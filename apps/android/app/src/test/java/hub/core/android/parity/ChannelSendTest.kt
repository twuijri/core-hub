package hub.core.android.parity

import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.realtime.Envelope
import hub.core.android.ui.screens.ChannelBottom
import hub.core.android.ui.screens.ChannelSendRefusal
import hub.core.android.ui.screens.ChannelSendRules
import hub.core.android.ui.screens.ChannelSending
import hub.core.android.ui.screens.ChatGroupsOps
import hub.core.android.ui.screens.ChatGroupsRules
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.ChannelConversation
import hub.core.client.model.ChannelMessage
import hub.core.client.model.ChannelOutgoing
import hub.core.client.model.ChannelSendFailure
import hub.core.client.model.ChannelSendUnavailable
import hub.core.client.model.SessionsListChannelConversations200Response
import hub.core.client.model.SessionsListChannelMessages200Response
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Writing into a Telegram or WhatsApp conversation from the phone (contract decision §153): the
 * new fields read with and without them (an older hub), the composer or the reason in its place,
 * the hub's message followed from posted to answered, the realtime event, the polling that slows
 * down while the hub announces each turn, and the send against a scripted hub — its refusals in
 * the words the screen gives them.
 */
class ChannelSendTest {
    private val json = Serializer.kotlinxSerializationJson
    private val at = "2026-10-08T10:00:00Z"

    private fun conversation(extra: String = "") = json.decodeFromString(
        ChannelConversation.serializer(),
        """{"id":"T1","profile":"work","channel":"telegram","message_count":3,"started_at":"$at","last_message_at":"$at",
            "peer_name":"Sara","preview":"hi"$extra}""",
    )

    private fun outgoingJson(id: String, status: String, messageId: String? = null, client: String? = "a-1", error: String = "null") =
        """{"id":"$id","conversation_id":"T1","client_message_id":${client?.let { "\"$it\"" } ?: "null"},"text":"ما آخر الأخبار؟",
            "author_name":"Admin","status":"$status","error":$error,"message_id":${messageId?.let { "\"$it\"" } ?: "null"},
            "session_id":null,"created_at":"$at","updated_at":"$at"}"""

    private fun outgoing(id: String, status: String, messageId: String? = null, client: String? = "a-1") =
        json.decodeFromString(ChannelOutgoing.serializer(), outgoingJson(id, status, messageId, client))

    private fun message(id: String, role: String = "user", extra: String = "") =
        json.decodeFromString(ChannelMessage.serializer(), """{"id":"$id","role":"$role","text":"t","created_at":"$at"$extra}""")

    private val ulid = "01K6ZQ4W5X6Y7Z8A9B0C1D2E3F"
    private val ulid2 = "01K6ZQ4W5X6Y7Z8A9B0C1D2E3G"

    // ------------------------------------------------------------------ reading

    @Test fun `an older hub without the new fields reads as before - read-only, polled as before`() {
        val old = conversation()
        assertNull(old.canSend)
        assertNull(old.sendUnavailable)
        assertEquals(ChannelBottom.ReadOnly, ChannelSendRules.bottom(old))
        val page = json.decodeFromString(
            SessionsListChannelMessages200Response.serializer(),
            """{"conversation":${json.encodeToString(ChannelConversation.serializer(), old)},
                "items":[{"id":"m1","role":"user","text":"hi","created_at":"$at"}],"has_more":false,"next_offset":null}""",
        )
        assertNull(page.outgoing)
        assertNull(page.liveUpdates)
        assertNull("absent origin means the channel", page.items.single().origin)
        assertFalse(ChannelSendRules.fromHub(page.items.single()))
        assertEquals(ChatGroupsRules.TRANSCRIPT_POLL_MS, ChannelSendRules.transcriptPollMs(page.liveUpdates))
        assertEquals(ChatGroupsRules.POLL_MS, ChannelSendRules.listPollMs(null))
    }

    @Test fun `a newer hub - the composer for whoever may write, the reason otherwise`() {
        assertEquals(ChannelBottom.Composer, ChannelSendRules.bottom(conversation(""","can_send":true,"send_unavailable":null,"current_id":null""")))
        assertEquals(
            ChannelBottom.Unavailable(ChannelSendUnavailable.NOT_ADMIN, null),
            ChannelSendRules.bottom(conversation(""","can_send":false,"send_unavailable":"not_admin","current_id":null""")),
        )
        assertEquals(
            "a conversation that moved on carries where to go",
            ChannelBottom.Unavailable(ChannelSendUnavailable.NOT_CURRENT, "T2"),
            ChannelSendRules.bottom(conversation(""","can_send":false,"send_unavailable":"not_current","current_id":"T2"""")),
        )
        assertEquals(
            "a hub that does not run Hermes keeps the read-only banner",
            ChannelBottom.ReadOnly,
            ChannelSendRules.bottom(conversation(""","can_send":false,"send_unavailable":"hermes_not_managed","current_id":null""")),
        )
        for (reason in listOf("platform_unsupported", "bridge_offline", "no_route")) {
            val bottom = ChannelSendRules.bottom(conversation(""","can_send":false,"send_unavailable":"$reason","current_id":null"""))
            assertEquals(reason, (bottom as ChannelBottom.Unavailable).reason.value)
            assertNull(bottom.currentId)
        }
    }

    @Test fun `the hub's message in the transcript, the outgoing list and live updates are read`() {
        val page = json.decodeFromString(
            SessionsListChannelMessages200Response.serializer(),
            """{"conversation":${json.encodeToString(ChannelConversation.serializer(), conversation(""","can_send":true"""))},
                "items":[{"id":"m1","role":"user","text":"ما آخر الأخبار؟","created_at":"$at","attachments":[],"origin":"hub","author_name":"Admin"},
                         {"id":"m2","role":"assistant","text":"Here","created_at":"$at","attachments":[],"origin":"channel","author_name":null}],
                "has_more":false,"next_offset":null,"outgoing":[${outgoingJson(ulid, "answering", "m1")}],"live_updates":true}""",
        )
        val hub = page.items[0]
        assertTrue(ChannelSendRules.fromHub(hub))
        assertEquals("Admin", hub.authorName)
        assertFalse(ChannelSendRules.fromHub(page.items[1]))
        assertEquals(ChannelOutgoing.Status.ANSWERING, page.outgoing!!.single().status)
        assertEquals(ChannelSendRules.LIVE_TRANSCRIPT_POLL_MS, ChannelSendRules.transcriptPollMs(page.liveUpdates))
        val list = json.decodeFromString(
            SessionsListChannelConversations200Response.serializer(),
            """{"items":[],"unavailable":[],"has_more":false,"live_updates":true}""",
        )
        assertEquals(ChannelSendRules.LIVE_POLL_MS, ChannelSendRules.listPollMs(list.liveUpdates))
        val failed = json.decodeFromString(
            ChannelOutgoing.serializer(),
            outgoingJson(ulid, "failed", error = """{"reason":"bridge_no_answer","message":null}"""),
        )
        assertEquals(ChannelSendFailure.Reason.BRIDGE_NO_ANSWER, failed.error!!.reason)
    }

    // ------------------------------------------------------------------ following the message

    @Test fun `a message the transcript has shows its state under it, one it has not yet comes after`() {
        val messages = listOf(message("m1", extra = ""","origin":"hub","author_name":"Admin""""), message("m2", "assistant"))
        val split = ChannelSendRules.split(messages, listOf(outgoing(ulid, "answering", "m1"), outgoing(ulid2, "posted", null, "a-2")))
        assertEquals(setOf("m1"), split.followed.keys)
        assertEquals(listOf(ulid2), split.pending.map { it.id })
        // A message id the shown page does not have (an older page not read) is still pending.
        val notShown = ChannelSendRules.split(messages, listOf(outgoing(ulid, "answered", "m9")))
        assertEquals(listOf(ulid), notShown.pending.map { it.id })
    }

    @Test fun `the words show at once, until the hub's own copy of them takes their place`() {
        val sending = ChannelSending("a-1", "ما آخر الأخبار؟")
        assertTrue(ChannelSendRules.showSending(sending, emptyList()))
        assertFalse(ChannelSendRules.showSending(sending, listOf(outgoing(ulid, "posted", client = "a-1"))))
        assertTrue(ChannelSendRules.showSending(sending, listOf(outgoing(ulid, "posted", client = "other"))))
        assertFalse(ChannelSendRules.showSending(null, emptyList()))
    }

    @Test fun `the state moves in place - posted, delivered, answering, answered`() {
        var list = ChannelSendRules.upsert(emptyList(), outgoing(ulid, "posted"))
        for (status in listOf("delivered", "answering", "answered")) {
            list = ChannelSendRules.upsert(list, outgoing(ulid, status))
            assertEquals(1, list.size)
            assertEquals(status, list.single().status.value)
        }
        list = ChannelSendRules.upsert(list, outgoing(ulid2, "posted", client = "a-2"))
        assertEquals("a second message comes after the first", listOf(ulid, ulid2), list.map { it.id })
    }

    @Test fun `the words to send are trimmed and capped, and nothing is sent empty`() {
        assertNull(ChannelSendRules.words("   \n "))
        assertEquals("hi", ChannelSendRules.words("  hi \n"))
        assertEquals(ChannelSendRules.TEXT_MAX, ChannelSendRules.words("x".repeat(5000))!!.length)
        assertTrue(ChannelSendRules.clientId(1) != ChannelSendRules.clientId(1))
    }

    // ------------------------------------------------------------------ realtime

    private fun envelope(payload: String, event: String = "channel_conversation.updated", namespace: String = "/rt/sessions") =
        Envelope.parse("""{"event":"$event","namespace":"$namespace","profile":"work","ts":"$at","seq":7,"payload":$payload}""")!!

    @Test fun `channel_conversation updated is read, and anything else is not`() {
        val turn = ChannelSendRules.parse(envelope("""{"conversation_id":"T1","channel":"telegram","reason":"turn_started","outgoing":null}"""))!!
        assertEquals("T1", turn.conversationId)
        assertEquals("turn_started", turn.reason)
        assertNull(turn.outgoing)
        val moved = ChannelSendRules.parse(envelope("""{"conversation_id":"T1","channel":"telegram","reason":"outgoing","outgoing":${outgoingJson(ulid, "delivered")}}"""))!!
        assertEquals(ChannelOutgoing.Status.DELIVERED, moved.outgoing!!.status)
        assertNull(ChannelSendRules.parse(envelope("""{"session_id":"S1"}""", event = "session.updated")))
        assertNull(ChannelSendRules.parse(envelope("""{"conversation_id":"T1"}""", namespace = "/rt/tasks")))
        assertNull("no reason, no update", ChannelSendRules.parse(envelope("""{"conversation_id":"T1"}""")))
    }

    @Test fun `a step in between moves the line in place, a turn or the message's end reads again`() {
        val start = listOf(outgoing(ulid, "posted"))
        fun update(reason: String, status: String? = null) = ChannelSendRules.parse(
            envelope("""{"conversation_id":"T1","channel":"telegram","reason":"$reason","outgoing":${status?.let { outgoingJson(ulid, it) } ?: "null"}}"""),
        )!!
        val delivered = ChannelSendRules.apply("T1", start, update("outgoing", "delivered"))
        assertEquals(ChannelOutgoing.Status.DELIVERED, delivered.outgoing.single().status)
        assertFalse(delivered.refetch)
        assertTrue(ChannelSendRules.apply("T1", delivered.outgoing, update("turn_started")).refetch)
        assertTrue(ChannelSendRules.apply("T1", delivered.outgoing, update("turn_ended")).refetch)
        val answered = ChannelSendRules.apply("T1", delivered.outgoing, update("outgoing", "answered"))
        assertTrue(answered.refetch)
        assertEquals(ChannelOutgoing.Status.ANSWERED, answered.outgoing.single().status)
        assertTrue(ChannelSendRules.apply("T1", start, update("outgoing", "failed")).refetch)
        val elsewhere = ChannelSendRules.apply("T9", start, update("turn_ended"))
        assertFalse("another conversation's turn is not this screen's", elsewhere.refetch)
        assertEquals(start, elsewhere.outgoing)
        // The list reads again on a settled update only.
        assertTrue(ChannelSendRules.settled(update("turn_ended")))
        assertFalse(ChannelSendRules.settled(update("outgoing", "answering")))
    }

    // ------------------------------------------------------------------ the send, against a scripted hub

    private val server = MockWebServer()
    private val responses = ArrayDeque<MockResponse>()

    @Before fun start() {
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest) = responses.removeFirstOrNull() ?: MockResponse().setResponseCode(404)
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun answer(status: Int, body: String) {
        responses += MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
    }

    @Test fun `sending posts the words with the phone's id and takes the hub's message back`() = runTest {
        val ops = ChatGroupsOps { HubApis(server.url("/").toString().trimEnd('/'), OkHttpClient()) }
        answer(202, """{"outgoing":${outgoingJson(ulid, "posted")}}""")
        val made = ops.send("work", "T1", "ما آخر الأخبار؟", "a-1").getOrThrow()
        assertEquals(ChannelOutgoing.Status.POSTED, made.status)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertTrue(request.requestUrl!!.encodedPath.endsWith("/channel-conversations/T1/messages"))
        assertEquals("work", request.getHeader("X-Hub-Profile"))
        val sent = json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("ما آخر الأخبار؟", sent["text"]!!.jsonPrimitive.content)
        assertEquals("a-1", sent["client_message_id"]!!.jsonPrimitive.content)
    }

    @Test fun `a refused send is said in the screen's words, the channel's own refusal included`() = runTest {
        val ops = ChatGroupsOps { HubApis(server.url("/").toString().trimEnd('/'), OkHttpClient()) }
        answer(503, """{"error":"Telegram refused","code":"service_unavailable","details":{"reason":"channel_send_failed","message":"Bad Request: chat not found"}}""")
        answer(503, """{"error":"No gateway","code":"service_unavailable","details":{"reason":"bridge_offline"}}""")
        answer(409, """{"error":"Moved on","code":"state_invalid","details":{"reason":"not_current","current_id":"T2"}}""")
        answer(403, """{"error":"Admins only","code":"forbidden","details":{"reason":"not_admin"}}""")
        answer(400, """{"error":"Too long","code":"validation_failed"}""")
        fun refusal(result: Result<*>) = ChannelSendRules.failure(result.exceptionOrNull() as HubError)
        assertEquals(ChannelSendRefusal.Channel("Bad Request: chat not found"), refusal(ops.send("work", "T1", "x", "a-1")))
        assertEquals(ChannelSendRefusal.Unavailable(ChannelSendUnavailable.BRIDGE_OFFLINE), refusal(ops.send("work", "T1", "x", "a-2")))
        assertEquals(ChannelSendRefusal.Unavailable(ChannelSendUnavailable.NOT_CURRENT), refusal(ops.send("work", "T1", "x", "a-3")))
        assertEquals(ChannelSendRefusal.Unavailable(ChannelSendUnavailable.NOT_ADMIN), refusal(ops.send("work", "T1", "x", "a-4")))
        val other = refusal(ops.send("work", "T1", "x", "a-5")) as ChannelSendRefusal.Other
        assertEquals("Too long", other.error.text)
    }
}

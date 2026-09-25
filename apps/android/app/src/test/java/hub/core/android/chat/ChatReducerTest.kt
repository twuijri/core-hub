package hub.core.android.chat

import hub.core.android.realtime.Envelope
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.MessageRole
import hub.core.client.model.SessionDetail
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The chat's state machine, fed the contract's own shapes (openapi.yaml examples). */
class ChatReducerTest {
    private val sid = "01J8QK3ZR2W7M5N4P6T8V9X0YA"
    private val run = "01J8QK3ZR2W7M5N4P6T8V9X0RN"
    private val shell = "01J8QK3ZR2W7M5N4P6T8V9X0MB"
    private var seq = 100L

    private fun author(kind: String, name: String) = """{"kind":"$kind","id":null,"name":"$name","avatar":null}"""

    private fun message(id: String, seq: Int, role: String, text: String?, status: String = "complete", tools: String = "[]") = """
        {"id":"$id","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-21T10:15:00Z",
         "updated_at":"2026-09-21T10:15:00Z","session_id":"$sid","room_id":null,"seq":$seq,"role":"$role",
         "author":${author(if (role == "user") "user" else "agent", if (role == "user") "طارق" else "Hermes")},
         "content":${if (text == null) "[]" else """[{"type":"text","text":"$text"}]"""},"reasoning":null,"tool_calls":$tools,
         "run_id":"$run","status":"$status","mentions":[],"handoff":null,"usage":null,"reply_to_message_id":null}
    """.trimIndent()

    private fun runJson(status: String, error: String? = null) = """
        {"id":"$run","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-21T10:15:00Z",
         "updated_at":"2026-09-21T10:15:00Z","session_id":"$sid","room_id":null,"seat_id":null,"job_id":"01J8QK3ZR2W7M5N4P6T8V9X0JB",
         "status":"$status","queue_position":null,"trigger":{"kind":"user","id":"01J8QK3ZR2W7M5N4P6T8V9X0HM"},"input_message_id":"01J8QK3ZR2W7M5N4P6T8V9X0MA",
         "output_message_id":"$shell","model":null,"provider":null,"reasoning_effort":null,"interrupted":false,
         "error":${error?.let { """{"error":"$it","code":"agent_error"}""" } ?: "null"},"usage":null,
         "started_at":"2026-09-21T10:15:01Z","finished_at":null}
    """.trimIndent()

    private fun tool(status: String, output: String?) = """
        {"id":"01J8QK3ZR2W7M5N4P6T8V9X0TC","name":"shell","status":"$status","preview":"pnpm test",
         "arguments":{"command":"pnpm test","env":{"CI":true},"retries":2},"output":${output?.let { "\"$it\"" } ?: "null"},
         "output_truncated":false,"duration_ms":null,"subagent_id":null,"started_at":null,"finished_at":null}
    """.trimIndent()

    private fun approval(kind: String, status: String = "pending") = """
        {"id":"01J8QK3ZR2W7M5N4P6T8V9X0AP","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM",
         "created_at":"2026-09-21T10:15:00Z","updated_at":"2026-09-21T10:15:00Z","kind":"$kind","status":"$status",
         "session_id":"$sid","run_id":"$run","message_id":"$shell","room_id":null,"workflow_run_id":null,"node_id":null,
         "agent":{"id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","name":"Hermes"},"title":"Delete build/?","description":null,
         "command":"rm -rf build","choices":[],"allow_always":true,"answer_mode":"choice","response":null,
         "expires_at":"2026-09-21T10:20:00Z"}
    """.trimIndent()

    private fun env(event: String, payload: String, profile: String = "work") =
        Envelope.parse("""{"event":"$event","namespace":"/rt/sessions","profile":"$profile","ts":"2026-09-21T10:15:04Z","seq":${++seq},"payload":$payload}""")!!

    private fun open(): ChatState {
        val detail = Serializer.kotlinxSerializationJson.decodeFromString(
            SessionDetail.serializer(),
            """{"id":"$sid","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-21T10:00:00Z",
               "updated_at":"2026-09-21T10:00:00Z","agent_id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","title":"اختبارات","source":"chat",
               "origin":null,"channel":null,"model":null,"provider":null,"reasoning_effort":null,"working_dir":null,"pinned":false,
               "archived":false,"category_id":null,"preview":null,"message_count":1,"usage":null,"context":null,"status":"idle",
               "active_run_id":null,"parent_session_id":null,"notify":false,"last_message_at":null,"match":null,
               "runs":[],"pending_approvals":[]}""",
        )
        val first = Serializer.kotlinxSerializationJson.decodeFromString(
            hub.core.client.model.Message.serializer(), message("01J8QK3ZR2W7M5N4P6T8V9X0MA", 13, "user", "شغّل الاختبارات"),
        )
        return ChatReducer.loaded(ChatState(), detail, listOf(first), 0)
    }

    private fun ChatState.feed(vararg envelopes: Envelope) = envelopes.fold(this) { s, e -> ChatReducer.apply(s, e, 5_000) }

    @Test fun `a streamed reply is built from the shell, its deltas and the final message`() {
        var s = open().feed(
            env("run.started", """{"run":${runJson("running")}}"""),
            env("message.created", """{"message":${message(shell, 14, "assistant", null, "streaming")}}"""),
            env("message.delta", """{"session_id":"$sid","message_id":"$shell","run_id":"$run","delta":"سأشغّل "}"""),
            env("message.delta", """{"session_id":"$sid","message_id":"$shell","run_id":"$run","delta":"الاختبارات."}"""),
        )
        assertTrue(s.running)
        assertEquals("سأشغّل الاختبارات.", s.messages.last().text)
        assertTrue(s.messages.last().streaming)
        s = s.feed(env("run.completed", """{"run":${runJson("succeeded")},"message":${message(shell, 14, "assistant", "سأشغّل الاختبارات. نجحت.")}}"""))
        assertFalse(s.running)
        assertEquals("سأشغّل الاختبارات. نجحت.", s.messages.last().text)
        assertFalse(s.messages.last().streaming)
    }

    @Test fun `a late message_created shell does not wipe text that already streamed`() {
        val s = open().feed(
            env("message.delta", """{"session_id":"$sid","message_id":"$shell","run_id":"$run","delta":"hello"}"""),
            env("message.created", """{"message":${message(shell, 14, "assistant", null, "streaming")}}"""),
        )
        assertEquals("hello", s.messages.last().text)
    }

    @Test fun `tool calls start, finish and become the current step`() {
        var s = open().feed(
            env("message.created", """{"message":${message(shell, 14, "assistant", null, "streaming")}}"""),
            env("tool.started", """{"session_id":"$sid","message_id":"$shell","run_id":"$run","tool_call":${tool("running", null)}}"""),
        )
        assertEquals("shell", s.currentStep)
        assertEquals(1, s.messages.last().toolCalls.size)
        s = s.feed(env("tool.completed", """{"session_id":"$sid","message_id":"$shell","run_id":"$run","tool_call":${tool("succeeded", "30 passed")}}"""))
        assertEquals(1, s.messages.last().toolCalls.size)
        assertEquals("30 passed", s.messages.last().toolCalls.single().output)
        assertEquals(3, s.messages.last().toolCalls.single().arguments!!.size)
    }

    @Test fun `approvals and questions wait until resolved`() {
        var s = open().feed(env("approval.requested", """{"approval":${approval("tool_call")}}"""))
        assertEquals(1, s.decisions.size)
        assertNull(s.question)
        s = s.feed(env("approval.resolved", """{"approval":${approval("tool_call", "approved")}}"""))
        assertTrue(s.approvals.isEmpty())
        s = s.feed(env("approval.requested", """{"approval":${approval("question")}}"""))
        assertEquals("Delete build/?", s.question!!.title)
        assertTrue(s.decisions.isEmpty())
    }

    @Test fun `a failed run says why and stops the indicator`() {
        val s = open().feed(
            env("run.started", """{"run":${runJson("running")}}"""),
            env("run.failed", """{"run":${runJson("failed", "Provider authentication failed")}}"""),
        )
        assertFalse(s.running)
        assertEquals("Provider authentication failed", s.failure)
    }

    @Test fun `events of other sessions are ignored`() {
        val before = open()
        val other = message("01J8QK3ZR2W7M5N4P6T8V9X0ZZ", 1, "user", "x").replace(sid, "01J8QK3ZR2W7M5N4P6T8V9X0ZY")
        assertEquals(before.messages, before.feed(env("message.created", """{"message":$other}""")).messages)
        assertEquals(before.messages, before.feed(env("message.delta", """{"session_id":"01J8QK3ZR2W7M5N4P6T8V9X0ZY","message_id":"$shell","run_id":"$run","delta":"x"}""")).messages)
    }

    @Test fun `after_seq is the highest seq of the session's own profile`() {
        val s = open()
        val a = s.feed(env("message.delta", """{"session_id":"$sid","message_id":"$shell","run_id":"$run","delta":"a"}"""))
        val seen = a.lastSeq
        assertEquals(seq, seen)
        val b = a.feed(env("message.delta", """{"session_id":"$sid","message_id":"$shell","run_id":"$run","delta":"b"}""", profile = "other"))
        assertEquals(seen, b.lastSeq)
    }

    @Test fun `turns group consecutive messages of one speaker and skip empty shells`() {
        val s = open().feed(
            env("message.created", """{"message":${message("01J8QK3ZR2W7M5N4P6T8V9X0MC", 14, "user", "and again")}}"""),
            env("message.created", """{"message":${message(shell, 15, "assistant", null, "streaming")}}"""),
        )
        val turns = Turns.group(s.messages)
        assertEquals(1, turns.size)
        assertEquals(MessageRole.USER, turns.single().role)
        assertEquals(2, turns.single().messages.size)
    }
}

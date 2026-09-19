package us.i3u.hermesstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The paginated transcript mapping.
 *
 * `display_content` is nullable on the server and `JSONObject.opt` returns
 * [JSONObject.NULL] for it, which stringifies to "null". Every message in the
 * history screen rendered as the word "null" because of it, so these fixtures
 * keep a JSON null distinguishable from real text.
 */
class ConversationPageTest {
    private val api = HermesApi("http://127.0.0.1:1", "token")

    @Test
    fun `a null display_content falls back to the stored content`() {
        val root = JSONObject(
            """
            {"session":{"title":"معرفة نوع جهاز الماك"},"total":2,"offset":0,"hasMore":false,
             "messages":[
               {"id":"m1","role":"user","display_content":null,"content":"وش نوع جهازي؟"},
               {"id":"m2","role":"assistant","display_content":null,"content":[{"type":"text","text":"جهازك ماك"}]}
             ]}
            """.trimIndent(),
        )
        val page = api.parseConversationPage(root, 0)
        // The value reaches the row exactly as the server wrote it, as in the
        // web's `display_content ?? content`; the block array is read once,
        // by parseChatMessage, so an upload can still become a card.
        assertEquals(
            listOf("وش نوع جهازي؟", "جهازك ماك"),
            page.messages.map { parseChatMessage(it.content).text },
        )
        assertEquals("معرفة نوع جهاز الماك", page.title)
    }

    @Test
    fun `display_content wins when the server sends one`() {
        val root = JSONObject(
            """{"messages":[{"id":"m1","role":"assistant","display_content":"shown","content":"raw"}]}""",
        )
        assertEquals(listOf("shown"), api.parseConversationPage(root, 0).messages.map { it.content })
    }

    @Test
    fun `a message with no content at all is dropped, never rendered as null`() {
        val root = JSONObject(
            """{"messages":[
                 {"id":"m1","role":"assistant","display_content":null,"content":null},
                 {"id":"m2","role":"assistant","content":"kept"}
               ]}""",
        )
        val page = api.parseConversationPage(root, 0)
        assertEquals(listOf("kept"), page.messages.map { it.content })
    }

    @Test
    fun `tool rows stay out of the transcript`() {
        val root = JSONObject(
            """{"messages":[
                 {"id":"m1","display_role":"tool","content":"terminal output"},
                 {"id":"m2","display_role":"assistant","content":"answer"}
               ]}""",
        )
        assertEquals(listOf("answer"), api.parseConversationPage(root, 0).messages.map { it.content })
    }

    @Test
    fun `a room message with a null content is empty, not the word null`() {
        val message = GroupJson.message(JSONObject("""{"id":"r1","content":null,"sender_name":"default"}"""))
        assertEquals("", message?.content ?: "")
    }

    @Test
    fun `a room message keeps its text and its card too`() {
        // GroupRoomState builds a ChatLine straight from GroupMessage.content
        // and never drops a blank one, so the same flattening bug painted an
        // empty room bubble with a sender name and an avatar.
        val bracketed = GroupJson.message(
            JSONObject("""{"id":"r2","senderName":"برق","content":"[التقرير](/home/agent/report.pdf) خلصت المراجعة."}"""),
        )
        val parsed = parseChatMessage(bracketed?.content.orEmpty())
        assertTrue(parsed.text.contains("خلصت المراجعة"))
        assertEquals("/home/agent/report.pdf", parsed.files.single().path)

        val upload = GroupJson.message(
            JSONObject("""{"id":"r3","senderName":"owner","content":"[{\"type\":\"file\",\"name\":\"a.m4a\",\"path\":\"/upload/a.m4a\"}]"}"""),
        )
        assertEquals("a.m4a", parseChatMessage(upload?.content.orEmpty()).files.single().fileName)
    }

    // ── "an old conversation renders with no text" ────────────────────────
    //
    // The fixture is the one tools/mock-studio.py serves for session s4.
    // `display_content` is null on every row, so each one falls back to
    // `content`, which is what the previous flattening step could not cope
    // with.

    /** The transcript as the renderer sees it: what MessageRow would draw. */
    private fun rendered(root: JSONObject): List<Pair<String, ParsedChatMessage>> =
        api.parseConversationPage(root, 0).messages.map { it.id to parseChatMessage(it.content) }

    private fun oldConversation(): JSONObject = JSONObject(
        """
        {"total":5,"offset":0,"limit":60,"hasMore":false,"messages":[
          {"id":"o1","role":"user","display_content":null,
           "content":"[التقرير](/home/agent/report.pdf) هذا هو الملخص الكامل، راجعه من فضلك."},
          {"id":"o2","role":"user","display_content":null,
           "content":"[{\"type\":\"text\",\"text\":\"حلل هذا التسجيل\"},{\"type\":\"file\",\"name\":\"meeting.m4a\",\"path\":\"/upload/meeting.m4a\",\"media_type\":\"audio/mp4\"}]"},
          {"id":"o3","role":"user","display_content":null,
           "content":"[{\"type\":\"image\",\"name\":\"shot.png\",\"path\":\"uploads/shot.png\"}]"},
          {"id":"o4","role":"assistant","display_content":null,
           "content":"[{\"type\":\"thinking\",\"thinking\":\"...\"},{\"type\":\"text\",\"text\":\"[1] المصدر الأول\"}]"},
          {"id":"o5","role":"assistant","display_content":null,"content":"راجعت التقرير وكل شيء واضح."}
        ]}
        """.trimIndent(),
    )

    @Test
    fun `no row of the old conversation is dropped`() {
        assertEquals(listOf("o1", "o2", "o3", "o4", "o5"), rendered(oldConversation()).map { it.first })
    }

    @Test
    fun `every surviving row has something to draw`() {
        rendered(oldConversation()).forEach { (id, parsed) ->
            assertTrue(
                "$id would render an avatar, a name and a timestamp around nothing",
                parsed.text.isNotBlank() || parsed.files.isNotEmpty(),
            )
        }
    }

    @Test
    fun `prose that merely begins with a bracket keeps its text and its download card`() {
        val (_, parsed) = rendered(oldConversation()).first { it.first == "o1" }
        assertTrue("the summary text was swallowed", parsed.text.contains("هذا هو الملخص الكامل"))
        assertEquals("/home/agent/report.pdf", parsed.files.single().path)
    }

    @Test
    fun `an upload stays a download card instead of becoming paperclip text`() {
        val (_, parsed) = rendered(oldConversation()).first { it.first == "o2" }
        assertEquals("حلل هذا التسجيل", parsed.text)
        assertEquals("meeting.m4a", parsed.files.single().fileName)
        assertFalse("the card was flattened into text", parsed.text.contains("📎"))
    }

    @Test
    fun `an attachment that is not server-local is still named`() {
        val (_, parsed) = rendered(oldConversation()).first { it.first == "o3" }
        assertEquals("📎 shot.png", parsed.text)
        assertTrue(parsed.files.isEmpty())
    }

    @Test
    fun `a block this client does not model does not take the answer with it`() {
        val (_, parsed) = rendered(oldConversation()).first { it.first == "o4" }
        assertEquals("[1] المصدر الأول", parsed.text)
    }

    @Test
    fun `a row is kept only when it has something to draw`() {
        val root = JSONObject(
            """{"messages":[
                 {"id":"m1","role":"assistant","display_content":null,"content":null},
                 {"id":"m2","role":"assistant","display_content":null,"content":"   "},
                 {"id":"m3","role":"assistant","display_content":null,"content":"[{\"type\":\"text\",\"text\":\"  \"}]"},
                 {"id":"m4","role":"assistant","content":"kept"}
               ]}""",
        )
        val kept = api.parseConversationPage(root, 0)
        // m3 carries no readable block, so it falls back to its own text —
        // ugly, but the web shows the same string and nothing is silently
        // lost. m1 and m2 have nothing at all and are dropped.
        assertEquals(listOf("m3", "m4"), kept.messages.map { it.id })
        kept.messages.forEach { assertTrue(parseChatMessage(it.content).text.isNotBlank()) }
    }

    // ── paging ───────────────────────────────────────────────────────────

    @Test
    fun `offset counts backwards from the newest message`() {
        // sessions-db.ts orders `id DESC LIMIT ? OFFSET ?` and reverses the
        // window, so offset 0 is the latest page and `fetched` is what the
        // next, older request has to skip.
        val root = JSONObject(
            """{"total":5,"offset":0,"limit":3,"hasMore":true,"messages":[
                 {"id":"o3","role":"user","content":"ثالثة"},
                 {"id":"o4","role":"assistant","content":"رابعة"},
                 {"id":"o5","role":"assistant","content":"خامسة"}
               ]}""",
        )
        val page = api.parseConversationPage(root, 0)
        assertEquals(3, page.fetched)
        assertEquals(5, page.total)
        assertTrue(page.hasMore)
    }

    @Test
    fun `hasMore is derived when an older server omits it`() {
        val root = JSONObject(
            """{"total":5,"offset":0,"messages":[{"id":"o5","role":"assistant","content":"خامسة"}]}""",
        )
        assertTrue(api.parseConversationPage(root, 0).hasMore)
    }
}

package us.i3u.hermesstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
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
        assertEquals(listOf("وش نوع جهازي؟", "جهازك ماك"), page.messages.map { it.content })
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
}

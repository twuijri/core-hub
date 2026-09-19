package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatFilesTest {

    @Test
    fun `assistant local markdown files become native download cards`() {
        val parsed = parseChatMessage(
            """
            اكتمل تجهيز العرض.

            ### الملفات

            [تحميل عرض PowerPoint](</home/agent/.hermes/profiles/mohamed/workspace/Manpower_Cascading_RTL_MOD.pptx>)

            [للمعاينة تحميل نسخة PDF](</home/agent/.hermes/profiles/mohamed/workspace/Manpower_Cascading_RTL_MOD.pdf>)
            """.trimIndent(),
        )

        assertEquals(2, parsed.files.size)
        assertEquals("تحميل عرض PowerPoint", parsed.files[0].label)
        assertEquals("Manpower_Cascading_RTL_MOD.pptx", parsed.files[0].fileName)
        assertEquals("Manpower_Cascading_RTL_MOD.pdf", parsed.files[1].fileName)
        assertEquals("اكتمل تجهيز العرض.", parsed.text)
        assertFalse(parsed.text.contains("/home/agent"))
    }

    @Test
    fun `web links and markdown images remain regular message content`() {
        val content = "[الموقع](https://example.com) ![صورة](/home/agent/image.png)"
        val parsed = parseChatMessage(content)

        assertTrue(parsed.files.isEmpty())
        assertEquals(content, parsed.text)
    }

    @Test
    fun `existing download URLs are unwrapped and decoded once`() {
        val parsed = parseChatMessage(
            "[تنزيل](/api/studio/files/download?path=%2Fhome%2Fagent%2FMy%2520Report.pdf&name=ignored)",
        )

        assertEquals("/home/agent/My%20Report.pdf", parsed.files.single().path)
        assertEquals("My Report.pdf", parsed.files.single().fileName)
    }

    @Test
    fun `legacy download URLs in old histories are still unwrapped`() {
        val parsed = parseChatMessage(
            "[تنزيل](/api/hermes/download?path=%2Fhome%2Fagent%2FMy%2520Report.pdf&name=ignored)",
        )

        assertEquals("/home/agent/My%20Report.pdf", parsed.files.single().path)
    }

    @Test
    fun `visible filename with extension wins over server path`() {
        assertEquals(
            "final-ar.pptx",
            inferDownloadFileName("/workspace/generated-output.bin", "final-ar.pptx"),
        )
    }

    @Test
    fun `studio audio content blocks become an attachment instead of raw json`() {
        val parsed = parseChatMessage(
            """[{"type":"file","name":"voice-1786646557278.m4a","path":"/home/agent/.hermes-web-ui/upload/manager/bbdd9dabb00e962d.m4a","media_type":"audio/mp4"}]""",
        )

        assertEquals("", parsed.text)
        assertEquals(1, parsed.files.size)
        assertEquals("voice-1786646557278.m4a", parsed.files.single().label)
        assertEquals("voice-1786646557278.m4a", parsed.files.single().fileName)
        assertFalse(parsed.text.contains("media_type"))
    }

    @Test
    fun `studio content blocks preserve text and merge their files`() {
        val parsed = parseChatMessage(
            """[{"type":"text","text":"حلل هذا التسجيل"},{"type":"file","name":"meeting.m4a","path":"/upload/meeting.m4a","media_type":"audio/mp4"}]""",
        )

        assertEquals("حلل هذا التسجيل", parsed.text)
        assertEquals("meeting.m4a", parsed.files.single().fileName)
    }

    // ── nothing may parse down to an empty row ───────────────────────────

    @Test
    fun `an attachment that cannot become a card is named instead of vanishing`() {
        // No server-local path, so there is no download to offer — but the
        // reader still has to see that a file rode along. Returning an empty
        // ParsedChatMessage drew a bubble with no text at all.
        val parsed = parseChatMessage("""[{"type":"image","name":"shot.png","path":"uploads/shot.png"}]""")

        assertEquals("📎 shot.png", parsed.text)
        assertTrue(parsed.files.isEmpty())
    }

    @Test
    fun `blocks that yield nothing fall back to the original text`() {
        val content = """[{"type":"thinking","thinking":"..."}]"""
        val parsed = parseChatMessage(content)

        assertEquals(content, parsed.text)
        assertTrue(parsed.files.isEmpty())
    }

    @Test
    fun `an empty text block never becomes an empty bubble`() {
        val parsed = parseChatMessage("""[{"type":"text","text":"   "}]""")

        assertFalse("nothing to draw must not look like a parsed message", parsed.text.isBlank() && parsed.files.isEmpty())
    }

    @Test
    fun `renderability is what decides whether a row is kept`() {
        assertTrue(hasRenderableChatContent("مرحبا"))
        assertTrue(hasRenderableChatContent("[التقرير](/home/agent/report.pdf) الملخص"))
        assertTrue(hasRenderableChatContent("""[{"type":"file","name":"a.m4a","path":"/upload/a.m4a"}]"""))
        assertTrue(hasRenderableChatContent("""[{"type":"thinking","thinking":"..."}]"""))
        assertFalse(hasRenderableChatContent(""))
        assertFalse(hasRenderableChatContent("   "))
    }

    @Test
    fun `an answer that is only a download link keeps its card`() {
        val parsed = parseChatMessage("[a](/p/a.pdf)")

        assertEquals("", parsed.text)
        assertEquals("/p/a.pdf", parsed.files.single().path)
    }
}

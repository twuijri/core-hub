package hub.core.android.phone

import hub.core.android.chat.ChatAttachment
import hub.core.android.ui.components.AttachmentFiles
import hub.core.client.model.ContentBlock
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which language dictation listens in (docs/changes/2026-09-27-twuijri-mobile-voice-language.md). */
class DictationLanguageTest {
    @Test fun `a keyboard's language is a tag, and emoji or handwriting is not`() {
        assertEquals("ar", DictationLanguage.tag("ar"))
        assertEquals("en-US", DictationLanguage.tag("en_US"))
        assertEquals("en-GB", DictationLanguage.tag("en-gb"))
        assertEquals("zh-CN", DictationLanguage.tag("zh-Hans"))
        assertEquals("sr-Latn", DictationLanguage.tag("sr-latn"))
        assertNull(DictationLanguage.tag("emoji"))
        assertNull(DictationLanguage.tag("mul"))
        assertNull(DictationLanguage.tag(""))
        assertNull(DictationLanguage.tag(null))
    }

    @Test fun `the conversation's script is found from its letters`() {
        assertEquals(DictationLanguage.Script.ARABIC, DictationLanguage.script(listOf("مرحبا، كيف حالك؟")))
        assertEquals(DictationLanguage.Script.LATIN, DictationLanguage.script(listOf("Run the tests please")))
        assertEquals(DictationLanguage.Script.CYRILLIC, DictationLanguage.script(listOf("Привет, как дела?")))
        assertEquals(DictationLanguage.Script.DEVANAGARI, DictationLanguage.script(listOf("नमस्ते दुनिया")))
        assertEquals(DictationLanguage.Script.HAN, DictationLanguage.script(listOf("你好世界")))
        assertEquals(DictationLanguage.Script.KANA, DictationLanguage.script(listOf("こんにちは世界")))
        assertEquals(DictationLanguage.Script.HANGUL, DictationLanguage.script(listOf("안녕하세요")))
        assertEquals(DictationLanguage.Script.ARABIC, DictationLanguage.script(listOf("شغل اختبارات server الآن")))
        assertNull(DictationLanguage.script(listOf("42 ✓", "")))
    }

    @Test fun `a script maps to the phone's own language in it`() {
        assertEquals("ar", DictationLanguage.languageFor(DictationLanguage.Script.ARABIC, listOf("en-US")))
        assertEquals("fa-IR", DictationLanguage.languageFor(DictationLanguage.Script.ARABIC, listOf("en-US", "fa-IR")))
        assertEquals("fr-FR", DictationLanguage.languageFor(DictationLanguage.Script.LATIN, listOf("ar-SA", "fr-FR")))
        assertEquals("en", DictationLanguage.languageFor(DictationLanguage.Script.LATIN, listOf("ar-SA")))
        assertEquals("uk-UA", DictationLanguage.languageFor(DictationLanguage.Script.CYRILLIC, listOf("uk-UA")))
        assertEquals("hi", DictationLanguage.languageFor(DictationLanguage.Script.DEVANAGARI, emptyList()))
        assertEquals("ja-JP", DictationLanguage.languageFor(DictationLanguage.Script.HAN, listOf("ja-JP")))
    }

    /** The owner's case: an English app, the Arabic keyboard up — Arabic, not English. */
    @Test fun `Auto listens in the keyboard's language, not the app's`() {
        val languages = DictationLanguage.candidates(
            choice = DictationLanguage.AUTO, keyboard = "ar", recent = emptyList(),
            keyboards = listOf("en-US", "ar"), preferred = listOf("en-US"), app = "en",
        )
        assertEquals("ar", languages.first())
        assertEquals("ar-SA", DictationLanguage.withRegion(languages.first()))
    }

    @Test fun `without a keyboard the conversation, then the phone, then the app decide`() {
        assertEquals(
            listOf("ar", "en-US", "en"),
            DictationLanguage.candidates(DictationLanguage.AUTO, null, listOf("أهلًا", "شغّل الاختبارات"), emptyList(), listOf("en-US"), "en"),
        )
        assertEquals(
            listOf("fr-CA", "en-US", "ar"),
            DictationLanguage.candidates(DictationLanguage.AUTO, null, emptyList(), emptyList(), listOf("fr-CA", "en-US"), "ar"),
        )
        assertEquals(listOf("ar"), DictationLanguage.candidates(DictationLanguage.AUTO, "emoji", emptyList(), emptyList(), emptyList(), "ar"))
    }

    @Test fun `a chosen language comes first`() {
        val languages = DictationLanguage.candidates("es-MX", "ar", listOf("hello there"), emptyList(), listOf("en-US"), "en")
        assertEquals("es-MX", languages.first())
    }

    @Test fun `Auto lets the recognizer detect among the person's languages`() {
        assertEquals(
            listOf("ar-SA", "en-US", "fr-FR"),
            DictationLanguage.allowed(listOf("ar"), keyboards = listOf("en", "ar-EG"), preferred = listOf("fr-FR", "en-GB")),
        )
    }

    @Test fun `the menu offers the keyboards then popular languages, each once`() {
        val menu = DictationLanguage.menu(listOf("ar", "fr-FR", "emoji"), supported = null)
        assertEquals(listOf("ar", "fr-FR", "en"), menu.take(3))
        assertEquals(1, menu.count { DictationLanguage.base(it) == "ar" })
        assertTrue("not only Arabic and English", "es" in menu && "zh" in menu && "hi" in menu)
        assertFalse("sw" in DictationLanguage.menu(listOf("sw"), supported = listOf("en-US", "ar-SA")))
    }

    @Test fun `the microphone's mark names a chosen language only`() {
        assertNull(DictationLanguage.badge(DictationLanguage.AUTO))
        assertEquals("AR", DictationLanguage.badge("ar"))
        assertEquals("ZH", DictationLanguage.badge("zh-TW"))
    }

    @Test fun `stretches of dictation join, levels stay in range, and the hub hears Auto as no language`() {
        assertEquals("run the tests and tell me", Dictations.join("run the tests", "and tell me"))
        assertEquals("hello", Dictations.join("", " hello "))
        assertEquals(0f, Dictations.level(-160f))
        assertEquals(1f, Dictations.level(0f))
        assertEquals(0f, Dictations.levelOfRms(-10f))
        assertEquals(1f, Dictations.levelOfRms(12f))
        assertNull(Dictations.hubLanguage(DictationLanguage.AUTO))
        assertEquals("fr", Dictations.hubLanguage("fr-CA"))
    }

    @Test fun `a reply's picture is drawn, its other files are named and kept under their own names`() {
        assertTrue(ChatAttachment(ContentBlock.Type.IMAGE, "chart.png", null, "01J8QK3ZR2W7M5N4P6T8V9X0AA", "image/png").isImage)
        assertFalse(ChatAttachment(ContentBlock.Type.FILE, "report.pdf", null, "01J8QK3ZR2W7M5N4P6T8V9X0AB", "application/pdf").isImage)
        assertFalse("no bytes to fetch", ChatAttachment(ContentBlock.Type.IMAGE, "x.png", null).isImage)
        val root = File("/cache/attachments")
        assertEquals("/cache/attachments/A1/chart.png", AttachmentFiles.place(root, "A1", "chart.png").path)
        assertEquals(".._x_y.pdf", AttachmentFiles.place(root, "A1", "../x/y.pdf").name)
        assertEquals("A1", AttachmentFiles.place(root, "A1", null).name)
    }
}

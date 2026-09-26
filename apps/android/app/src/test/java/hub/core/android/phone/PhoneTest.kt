package hub.core.android.phone

import android.content.Intent
import hub.core.android.MemoryPrefs
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Notice
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneTest {
    private fun notice(id: String, at: String, read: Boolean = false, resource: String? = null, profile: String? = "work") =
        Serializer.kotlinxSerializationJson.decodeFromString(
            Notice.serializer(),
            """{"id":"$id","user_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","kind":"run_completed","title":"Hermes finished","body":"x",
               "created_at":"$at","profile":${profile?.let { "\"$it\"" } ?: "null"},"resource":${resource ?: "null"},
               "read_at":${if (read) "\"$at\"" else "null"}}""",
        )

    @Test fun `each unread notice is shown once, oldest first`() {
        val a = notice("01J8QK3ZR2W7M5N4P6T8V9X0N1", "2026-09-25T10:00:00Z")
        val b = notice("01J8QK3ZR2W7M5N4P6T8V9X0N2", "2026-09-25T10:05:00Z")
        val read = notice("01J8QK3ZR2W7M5N4P6T8V9X0N3", "2026-09-25T10:06:00Z", read = true)
        assertEquals(listOf(a, b), NoticeTracker.fresh(listOf(b, read, a), 0))
        val seen = NoticeTracker.seenAfter(listOf(b, read, a), 0)
        assertTrue(NoticeTracker.fresh(listOf(b, read, a), seen).isEmpty())
        assertEquals(seen, NoticeTracker.seenAfter(emptyList(), seen))
    }

    @Test fun `a notice opens the page it is about`() {
        assertEquals(
            "/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA?profile=work",
            NoticeTracker.path(notice("N", "2026-09-25T10:00:00Z", resource = """{"kind":"session","id":"01J8QK3ZR2W7M5N4P6T8V9X0YA"}""")),
        )
        assertEquals("/tasks", NoticeTracker.path(notice("N", "2026-09-25T10:00:00Z", resource = """{"kind":"task","id":"T"}""")))
        assertEquals("/settings/notifications", NoticeTracker.path(notice("N", "2026-09-25T10:00:00Z")))
    }

    @Test fun `shared text becomes the draft, with its subject when it adds something`() {
        assertEquals("https://example.com", Share.textOf(Intent.ACTION_SEND, "text/plain", null, " https://example.com "))
        assertEquals("مقال\n\nhttps://example.com", Share.textOf(Intent.ACTION_SEND, "text/plain", "مقال", "https://example.com"))
        assertEquals("a title in a body", Share.textOf(Intent.ACTION_SEND, "text/plain", "title", "a title in a body"))
        // A picture's caption comes along as the draft; its subject (often the file name) does not.
        assertEquals("x", Share.textOf(Intent.ACTION_SEND, "image/png", null, " x "))
        assertNull(Share.textOf(Intent.ACTION_SEND, "image/png", "IMG_0001.jpg", null))
        assertNull(Share.textOf(Intent.ACTION_VIEW, "text/plain", null, "x"))
        assertNull(Share.textOf(Intent.ACTION_SEND, "text/plain", " ", ""))
    }

    @Test fun `dictation is Auto by default and an old choice reads as it did, except the app's language`() {
        // «As the app» made an English app hear Arabic as English: it reads as Auto now.
        assertEquals(DictationLanguage.AUTO, DictationLanguage.stored(null))
        assertEquals(DictationLanguage.AUTO, DictationLanguage.stored("APP"))
        assertEquals("ar", DictationLanguage.stored("AR"))
        assertEquals("en", DictationLanguage.stored("EN"))
        assertEquals("fr-FR", DictationLanguage.stored("fr-FR"))
        // Replies are read in their own language, by their letters.
        assertEquals("ar", DictationLanguage.replyLanguage("اكتملت الاختبارات", listOf("en-US")))
        assertEquals("ru", DictationLanguage.replyLanguage("Все тесты прошли", listOf("en-US")))
        assertEquals("en", DictationLanguage.replyLanguage("42", listOf("ar-SA")))
    }

    @Test fun `this phone's choices persist, with voice and background checks on by default`() {
        val prefs = MemoryPrefs()
        val first = DeviceSettings(prefs)
        assertEquals(DeviceChoices(voiceInput = true, dictation = DictationLanguage.AUTO, spokenReplies = false, backgroundNotices = true), first.choices.value)
        first.update { it.copy(spokenReplies = true, dictation = "es-MX", backgroundNotices = false) }
        first.noticesSeenAt = 42
        val second = DeviceSettings(prefs)
        assertTrue(second.choices.value.spokenReplies)
        assertEquals("es-MX", second.choices.value.dictation)
        assertFalse(second.choices.value.backgroundNotices)
        assertEquals(42L, second.noticesSeenAt)
    }

    @Test fun `an update is checked against its SHA-256`() {
        val file = File.createTempFile("update", ".apk").apply { writeText("core hub") }
        assertEquals(java.security.MessageDigest.getInstance("SHA-256").digest("core hub".toByteArray()).joinToString("") { "%02x".format(it) }, Updates.sha256(file))
        file.delete()
    }
}

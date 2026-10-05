package hub.core.android.chat

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import hub.core.android.AppLanguage
import hub.core.android.Digits
import hub.core.android.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

/**
 * When a message was said, under it after a light tap (tester feedback, 2026-10-05): the clock
 * time today, «Yesterday» and the time yesterday, the short date and the time before that, digits
 * Latin in every language. The web's messageTime and iOS's MessageTimeTests check the same rule.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class MessageTimeTest {
    private val zone = ZoneId.of("Asia/Riyadh")
    private val now = ZonedDateTime.of(2026, 10, 5, 18, 30, 0, 0, zone)
    private val english = Locale.UK
    private val arabic = Locale.forLanguageTag("ar-SA")
    private val eastern = Regex("[٠-٩۰-۹]")

    private fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int) =
        ZonedDateTime.of(year, month, day, hour, minute, 0, 0, zone).toOffsetDateTime()

    private fun text(year: Int, month: Int, day: Int, hour: Int, minute: Int, locale: Locale, yesterday: String = "Yesterday") =
        MessageTime.text(at(year, month, day, hour, minute), now, locale) { "$yesterday $it" }

    @Test fun `today is only the clock time`() {
        assertEquals("00:05", text(2026, 10, 5, 0, 5, english))
    }

    @Test fun `yesterday says so before the time`() {
        assertEquals("Yesterday 23:50", text(2026, 10, 4, 23, 50, english))
    }

    @Test fun `the day is the reader's own, whatever zone the hub wrote`() {
        // 21:30 UTC on the 4th is 00:30 on the 5th in Riyadh: today, not yesterday.
        val utc = ZonedDateTime.of(2026, 10, 4, 21, 30, 0, 0, ZoneId.of("UTC")).toOffsetDateTime()
        assertEquals("00:30", MessageTime.text(utc, now, english) { "Yesterday $it" })
    }

    @Test fun `older shows the short date, and the year only when it differs`() {
        val thisYear = text(2026, 10, 3, 14, 5, english)
        assertTrue(thisYear, thisYear.contains("3 Oct") && thisYear.contains("14:05"))
        assertFalse(thisYear, thisYear.contains("2026"))
        val lastYear = text(2025, 12, 31, 8, 0, english)
        assertTrue(lastYear, lastYear.contains("31 Dec") && lastYear.contains("2025"))
    }

    @Test fun `Arabic keeps its words with Latin digits`() {
        listOf(Triple(2026, 10, 5), Triple(2026, 10, 4), Triple(2025, 1, 2)).forEach { (y, m, d) ->
            val shown = text(y, m, d, 9, 7, arabic, "أمس")
            assertFalse(shown, eastern.containsMatchIn(shown))
            assertTrue(shown, shown.contains("9:07"))
        }
        assertTrue(text(2026, 10, 4, 9, 7, arabic, "أمس").startsWith("أمس"))
        assertTrue(text(2025, 1, 2, 9, 7, arabic, "أمس").contains("يناير"))
    }

    @Test fun `yesterday is worded in both languages`() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        assertEquals("Yesterday 09:07", app.getString(R.string.chat_time_yesterday, "09:07"))
        assertEquals("أمس 09:07", Digits.wrap(app, AppLanguage.AR).getString(R.string.chat_time_yesterday, "09:07"))
    }
}

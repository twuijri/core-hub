package hub.core.android.phone

import android.app.Application
import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.test.core.app.ApplicationProvider
import hub.core.android.AppLanguage
import hub.core.android.Digits
import hub.core.android.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

/**
 * Latin digits (123) in the Arabic UI too (owner, 2026-09-26, DECISIONS §113): the tool row's
 * «43 ث», step counts, sizes and durations keep their Arabic words but not Arabic-Indic digits,
 * whether Arabic is chosen in the app or comes from an Arabic phone.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, qualifiers = "ar-rSA")
class DigitsTest {
    private val eastern = Regex("[٠-٩۰-۹]")
    private val arabicLetter = Regex("[ء-ي]")
    private val saved = Locale.getDefault()

    @After fun restore() = Locale.setDefault(saved)

    @Test fun `an Arabic locale without the keyword would print Arabic-Indic digits`() {
        assertTrue(eastern.containsMatchIn(String.format(Locale.forLanguageTag("ar-SA"), "%d", 43)))
        assertEquals("43", String.format(Digits.latin(Locale.forLanguageTag("ar-SA")), "%d", 43))
        assertEquals("ar-SA-u-nu-latn", Digits.latin(Locale.forLanguageTag("ar-SA")).toLanguageTag())
    }

    @Test fun `Arabic chosen in the app formats every number with Latin digits`() {
        val context = Digits.wrap(ApplicationProvider.getApplicationContext(), AppLanguage.AR)
        assertEquals("ar", context.resources.configuration.locales[0].language)
        assertEquals("43 ث", context.getString(R.string.tool_activity_seconds, 43))
        assertEquals("2 د 05 ث", context.getString(R.string.tool_activity_minutes, 2, 5))
        val steps = context.resources.getQuantityString(R.plurals.tool_activity_steps, 12, 12)
        assertTrue(steps, steps.contains("12") && arabicLetter.containsMatchIn(steps))
        val samples = listOf(
            steps,
            "%d:%02d".format(3, 7),
            Formatter.formatShortFileSize(context, 3_400_000),
            DateUtils.formatElapsedTime(2_590),
        )
        samples.forEach { assertFalse("«$it» has Arabic-Indic digits", eastern.containsMatchIn(it)) }
    }

    @Test fun `following an Arabic phone keeps its language and still prints Latin digits`() {
        Locale.setDefault(Locale.forLanguageTag("ar-SA"))
        val context = Digits.wrap(ApplicationProvider.getApplicationContext(), null)
        val locale = context.resources.configuration.locales[0]
        assertEquals("ar", locale.language)
        assertEquals("latn", locale.getUnicodeLocaleType("nu"))
        assertEquals("43 ث", context.getString(R.string.tool_activity_seconds, 43))
        assertEquals("ar", Locale.getDefault().language)
        assertEquals("43", "%d".format(43))
    }

    @Test fun `English stays English`() {
        val context = Digits.wrap(ApplicationProvider.getApplicationContext(), AppLanguage.EN)
        assertEquals("en", context.resources.configuration.locales[0].language)
        assertFalse(eastern.containsMatchIn(context.getString(R.string.tool_activity_seconds, 43)))
    }
}

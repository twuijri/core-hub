package hub.core.android

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import java.util.Locale

/**
 * Latin digits (123) in both languages, also in the Arabic UI (owner, 2026-09-26, DECISIONS §113):
 * numbers, durations, sizes, dates, counts and percentages keep their Arabic words, plural forms
 * and RTL, but never show Arabic-Indic digits (٠١٢…). Done once, on the locale: every
 * `stringResource(…, n)`, `pluralStringResource`, `String.format`, `Formatter.formatShortFileSize`
 * and `DateUtils` call reads its digits from the Unicode `nu-latn` keyword set here.
 */
object Digits {
    /** [locale] with the Latin numbering system; its language, region and script stay. */
    fun latin(locale: Locale): Locale =
        runCatching { Locale.Builder().setLocale(locale).setUnicodeLocaleKeyword("nu", "latn").build() }.getOrDefault(locale)

    /** The locales the app formats in: the in-app language when one is chosen, else the phone's list. */
    fun locales(language: AppLanguage?, system: LocaleList): LocaleList {
        val chosen = language?.let { listOf(Locale.forLanguageTag(it.tag)) } ?: List(system.size()) { system[it] }
        return LocaleList(*chosen.ifEmpty { listOf(Locale.getDefault()) }.map(::latin).toTypedArray())
    }

    /**
     * [base] configured for [language] (null follows the phone) with Latin digits; the process
     * default gains the same keyword, so `"%d".format(n)` and friends agree with the resources.
     */
    fun wrap(base: Context, language: AppLanguage?): Context {
        Locale.setDefault(latin(Locale.getDefault()))
        val config = Configuration(base.resources.configuration)
        val locales = locales(language, config.locales)
        config.setLocales(locales)
        config.setLayoutDirection(locales[0])
        return base.createConfigurationContext(config)
    }
}

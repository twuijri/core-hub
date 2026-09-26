package hub.core.android.phone

import java.util.Locale

/*
 * Which language the phone's recognizer listens in (owner, 2026-09-27: «المفروض هو يتعرف
 * تلقائي»). «Auto» — the default — follows the keyboard the person types with (its current
 * subtype), else the language the conversation is written in, else the phone's own languages,
 * else the app's. Any language the phone can recognize can be chosen from the microphone's long
 * press; none is special. The rules are here, apart from Android, so they are tested.
 */
object DictationLanguage {
    /** The stored choice that means "pick it for me". */
    const val AUTO = "auto"

    /** Offered after the keyboards' languages in the microphone's menu: widely spoken ones. */
    val popular = listOf("en", "ar", "es", "fr", "de", "zh", "hi", "pt", "ja", "ru", "it", "tr", "ko", "id", "ur", "fa")

    /** A writing system the conversation can be recognized by, cheaply, from its letters. */
    enum class Script { ARABIC, LATIN, CYRILLIC, DEVANAGARI, HAN, KANA, HANGUL, HEBREW, GREEK, THAI }

    /** A keyboard subtype's language (or any locale id) as a BCP-47 tag; null for none (emoji, handwriting). */
    fun tag(raw: String?): String? {
        val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val parts = trimmed.replace('_', '-').split('-').filter { it.isNotEmpty() }.toMutableList()
        val base = parts.firstOrNull()?.lowercase() ?: return null
        if (base.length !in 2..3 || !base.all { it in 'a'..'z' } || base in setOf("mul", "und", "zxx")) return null
        parts[0] = base
        if (base == "zh" && parts.size > 1) {
            when (parts[1].lowercase()) {
                "hans" -> return "zh-CN"
                "hant" -> return "zh-TW"
            }
        }
        if (parts.size > 1) {
            val second = parts[1]
            parts[1] = if (second.length == 2) second.uppercase() else second.lowercase().replaceFirstChar { it.uppercase() }
        }
        return parts.joinToString("-")
    }

    /** The language part of a tag: `ar` of `ar-SA`. */
    fun base(tag: String): String = tag.replace('_', '-').substringBefore('-').lowercase()

    /** The script most letters of [texts] are written in; null with fewer than three letters. */
    fun script(texts: List<String>): Script? {
        val counts = mutableMapOf<Script, Int>()
        texts.forEach { text ->
            var i = 0
            while (i < text.length) {
                val point = text.codePointAt(i)
                scriptOf(point)?.let { counts[it] = (counts[it] ?: 0) + 1 }
                i += Character.charCount(point)
            }
        }
        // Japanese mixes kana with Han: any kana makes it Japanese.
        counts[Script.KANA]?.let { kana ->
            counts[Script.KANA] = kana + (counts.remove(Script.HAN) ?: 0)
        }
        val best = counts.maxByOrNull { it.value } ?: return null
        return if (best.value >= 3) best.key else null
    }

    private fun scriptOf(point: Int): Script? = when (point) {
        in 0x41..0x5A, in 0x61..0x7A, in 0xC0..0x24F, in 0x1E00..0x1EFF -> Script.LATIN
        in 0x600..0x6FF, in 0x750..0x77F, in 0x8A0..0x8FF, in 0xFB50..0xFDFF, in 0xFE70..0xFEFF -> Script.ARABIC
        in 0x400..0x52F -> Script.CYRILLIC
        in 0x900..0x97F -> Script.DEVANAGARI
        in 0x3040..0x30FF -> Script.KANA
        in 0x4E00..0x9FFF, in 0x3400..0x4DBF -> Script.HAN
        in 0xAC00..0xD7AF, in 0x1100..0x11FF -> Script.HANGUL
        in 0x590..0x5FF -> Script.HEBREW
        in 0x370..0x3FF -> Script.GREEK
        in 0xE00..0xE7F -> Script.THAI
        else -> null
    }

    /** The script a language is written in (the common case; Latin for the rest). */
    fun scriptOfLanguage(tag: String): Script = when (base(tag)) {
        "ar", "fa", "ur", "ps", "ckb", "sd", "ug" -> Script.ARABIC
        "ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn", "tg" -> Script.CYRILLIC
        "hi", "mr", "ne", "sa" -> Script.DEVANAGARI
        "zh", "yue" -> Script.HAN
        "ja" -> Script.KANA
        "ko" -> Script.HANGUL
        "he", "iw", "yi" -> Script.HEBREW
        "el" -> Script.GREEK
        "th" -> Script.THAI
        else -> Script.LATIN
    }

    /** The language written in [script] among [known] (keyboards, then the phone's languages), else the script's most spoken one. */
    fun languageFor(script: Script, known: List<String>): String =
        known.mapNotNull(::tag).firstOrNull { scriptOfLanguage(it) == script || (script == Script.HAN && base(it) == "ja") }
            ?: when (script) {
                Script.ARABIC -> "ar"
                Script.LATIN -> "en"
                Script.CYRILLIC -> "ru"
                Script.DEVANAGARI -> "hi"
                Script.HAN -> "zh"
                Script.KANA -> "ja"
                Script.HANGUL -> "ko"
                Script.HEBREW -> "he"
                Script.GREEK -> "el"
                Script.THAI -> "th"
            }

    /**
     * The languages to try, best first: the person's choice; with Auto, the keyboard in use, then
     * the language the conversation is written in, then the phone's languages, then the app's.
     */
    fun candidates(
        choice: String,
        keyboard: String?,
        recent: List<String>,
        keyboards: List<String>,
        preferred: List<String>,
        app: String,
    ): List<String> {
        val list = mutableListOf<String>()
        if (choice != AUTO) tag(choice)?.let(list::add)
        tag(keyboard)?.let(list::add)
        script(recent)?.let { list += languageFor(it, keyboards + preferred) }
        list += preferred.mapNotNull(::tag)
        tag(app)?.let(list::add)
        val seen = mutableSetOf<String>()
        return list.filter { seen.add(it.lowercase()) }
    }

    /** The region a bare language is asked for in, so the recognizer gets a full locale. */
    private val usualRegion = mapOf(
        "ar" to "SA", "en" to "US", "es" to "ES", "fr" to "FR", "de" to "DE", "pt" to "BR", "zh" to "CN",
        "it" to "IT", "nl" to "NL", "ru" to "RU", "ja" to "JP", "ko" to "KR", "hi" to "IN", "tr" to "TR",
    )

    /** A tag with a region: `ar` → `ar-SA`; one that has a region, or a language without a usual one, as it is. */
    fun withRegion(tag: String): String =
        if ('-' in tag) tag else usualRegion[base(tag)]?.let { "$tag-$it" } ?: tag

    /** What the recognizer may detect and switch between with Auto: the keyboards' languages and the phone's. */
    fun allowed(first: List<String>, keyboards: List<String>, preferred: List<String>): List<String> {
        val seen = mutableSetOf<String>()
        return (first + keyboards + preferred).mapNotNull(::tag).map(::withRegion).filter { seen.add(base(it)) }.take(10)
    }

    /**
     * What the microphone's menu offers: the keyboards' languages, then the popular ones, each
     * once, and only languages the phone recognizes when it says ([supported] null: all).
     */
    fun menu(keyboards: List<String>, supported: List<String>?): List<String> {
        val bases = supported?.map(::base)?.toSet()
        val seen = mutableSetOf<String>()
        return (keyboards.mapNotNull(::tag) + popular).filter { language ->
            seen.add(base(language)) && (bases == null || base(language) in bases)
        }
    }

    /** The tiny mark on the microphone while a language is chosen: `AR`, `EN`, `ZH`. */
    fun badge(choice: String): String? = if (choice == AUTO) null else base(choice).uppercase(Locale.ROOT)

    /** A language's name in the reader's language: «العربية», "Arabic". */
    fun name(tag: String, reader: String): String {
        val readerLocale = Locale.forLanguageTag(reader)
        val name = Locale.forLanguageTag(tag).getDisplayName(readerLocale).ifBlank { tag }
        return name.replaceFirstChar { it.titlecase(readerLocale) }
    }

    /** A stored choice as it reads now: up to 1.1.x the choices were APP (the app's language — what made an English app hear Arabic as English), AR and EN. */
    fun stored(value: String?): String = when (value) {
        null, "", "APP", AUTO -> AUTO
        "AR" -> "ar"
        "EN" -> "en"
        else -> tag(value) ?: AUTO
    }

    /** The phone's voice for a reply: the language its letters are written in, as the phone knows it; English when it cannot tell. */
    fun replyLanguage(text: String, known: List<String>): String =
        script(listOf(text))?.let { base(languageFor(it, known)) } ?: "en"
}

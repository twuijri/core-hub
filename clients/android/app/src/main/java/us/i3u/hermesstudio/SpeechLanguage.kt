package us.i3u.hermesstudio

import androidx.annotation.StringRes
import java.util.Locale

/**
 * Which language dictation listens for.
 *
 * Android's [android.speech.SpeechRecognizer] transcribes the language it is
 * told to, and the phone used to tell it whatever the app was displaying in.
 * That is right for someone whose phone and tongue agree, and wrong for the
 * owner: an English phone, Arabic speech, English nonsense in the composer.
 *
 * So the language becomes its own per-profile preference with three answers:
 *
 *  - [FOLLOW_APP] (the default, and what the app has always done) — the app's
 *    own display language,
 *  - a BCP-47 tag the device says it can recognise,
 *  - [AUTOMATIC] — the recognizer works the language out for itself.
 *
 * Automatic runs **on the device**. Since Android 14 the recognition intent
 * takes `EXTRA_ENABLE_LANGUAGE_DETECTION` and `EXTRA_ENABLE_LANGUAGE_SWITCH`
 * over a list of allowed languages, and the engine reports what it heard
 * through `RecognitionListener.onLanguageDetection`. No audio leaves the phone
 * for this. What the platform cannot do is decided by [DetectionSupport], and
 * a device that cannot detect is told so rather than quietly transcribing the
 * wrong language.
 *
 * Everything here is pure so the rules can be read in a test instead of on a
 * phone; the Android-side queries live in [SpeechInput].
 */

/**
 * The sentence for one [DetectionBlock], in the app's own words.
 *
 * Lives next to the enum so a new reason cannot be added without a string to
 * explain it. Every one of these takes the phone's Android release (`%1$s`)
 * and API level (`%2$d`) as arguments whether it uses them or not, so callers
 * need not know which reason names the platform.
 */
@StringRes
fun detectionReasonRes(block: DetectionBlock): Int = when (block) {
    DetectionBlock.None -> R.string.speech_detect_on
    DetectionBlock.NotChecked -> R.string.speech_detect_off_pending
    DetectionBlock.PlatformTooOld -> R.string.speech_detect_off_platform
    DetectionBlock.EngineSilent -> R.string.speech_detect_off_unknown
    DetectionBlock.EngineRefused -> R.string.speech_detect_off_engine
    DetectionBlock.NoModels -> R.string.speech_detect_off_models
}

/** One language dictation can run in, named the way its own speakers name it. */
data class SpeechLanguageOption(
    val tag: String,
    val endonym: String,
    /**
     * False for a curated entry offered because the device answered nothing.
     * Such a row is a guess and the sheet says so; a confirmed row is one the
     * recognizer itself listed.
     */
    val confirmed: Boolean = true,
)

/**
 * Why automatic detection is not running on this device.
 *
 * Every value is something the app was told, never something it assumed, and
 * every value has a sentence of its own on the recording strip. [None] is the
 * only one that means detection is actually live.
 */
enum class DetectionBlock {
    /** Detection is on: the engine was asked, and it agreed. */
    None,

    /** The device was never asked yet, so nothing may be claimed either way. */
    NotChecked,

    /** Older than Android 14: the detection extras do not exist here. */
    PlatformTooOld,

    /** `checkRecognitionSupport` (or the broadcast) never answered at all. */
    EngineSilent,

    /** The engine answered, but refused an intent that asked for detection. */
    EngineRefused,

    /** Fewer than two of the owner's languages have a model on this phone. */
    NoModels,
}

/**
 * What this device can actually do about working the language out for itself.
 *
 * Nothing here is assumed. [sdkInt] is the API level the phone reported (the
 * extras and the `onLanguageDetection` callback arrived in 34), [engineAnswered]
 * means the installed recognition service replied to a support query at all,
 * [detectionAccepted] means it replied to a query for an intent that **asked
 * for detection** — which is a different question, and the one the app used to
 * skip — and [allowed] is the list of languages that engine reported, not a
 * list this app made up.
 *
 * [checked] separates "we asked and this is the answer" from "we have not
 * asked yet", so a take started before the query returned is never described
 * as a device limitation.
 */
data class DetectionSupport(
    val checked: Boolean = false,
    val sdkInt: Int = 0,
    val engineAnswered: Boolean = false,
    val detectionAccepted: Boolean = false,
    val allowed: List<String> = emptyList(),
) {
    /** Android 14 or later: the detection extras exist at all. */
    val platform: Boolean get() = sdkInt >= SpeechLanguages.DETECTION_SDK

    /**
     * The first thing standing in the way, in the order the owner would meet
     * them. Detecting between fewer than two languages is not detection, so a
     * device that reported one language (or none) counts as unable.
     */
    val block: DetectionBlock
        get() = when {
            !checked -> DetectionBlock.NotChecked
            !platform -> DetectionBlock.PlatformTooOld
            !engineAnswered -> DetectionBlock.EngineSilent
            !detectionAccepted -> DetectionBlock.EngineRefused
            allowed.size < 2 -> DetectionBlock.NoModels
            else -> DetectionBlock.None
        }

    val usable: Boolean get() = block == DetectionBlock.None
}

/**
 * What the installed recognition service answered when asked which languages
 * it has. [answered] separates "the engine said it can do nothing" from "the
 * engine never replied", because only the second one justifies a guess.
 */
data class RecognizerLanguages(
    /** Everything it can recognise, on device or online: the picker's list. */
    val all: List<String> = emptyList(),
    /** Languages whose model is on the phone now; what detection can work with. */
    val onDevice: List<String> = emptyList(),
    /** The engine's own default language, if it named one. */
    val preferred: String? = null,
    val answered: Boolean = false,
    /**
     * The engine answered a support query for an intent that carried
     * `EXTRA_ENABLE_LANGUAGE_DETECTION`. False on a platform too old to have
     * the extra, and false when the engine refused that intent but answered a
     * plain one.
     */
    val detectionAccepted: Boolean = false,
)

/** Where one dictation take runs, and in which language. */
sealed interface SpeechPlan {
    /**
     * Android's recognizer in one fixed language.
     *
     * [detectionBlock] is anything other than [DetectionBlock.None] when the
     * owner asked for automatic and this device cannot do it, so the caller
     * can name the concrete reason instead of pretending. [requestedTag] is
     * the language that was asked for but which the engine does not serve —
     * blank when [languageTag] is exactly what was wanted — so a take that had
     * to move from `en-SA` to `en-US` says which, rather than failing or
     * silently running somewhere else.
     */
    data class OnDevice(
        val languageTag: String,
        val detectionBlock: DetectionBlock = DetectionBlock.None,
        val requestedTag: String = "",
    ) : SpeechPlan {
        val detectionUnavailable: Boolean get() = detectionBlock != DetectionBlock.None
    }

    /**
     * Android's recognizer with detection and switching turned on. [seed] is
     * the language the take opens in — the intent still requires one — and
     * [allowed] the languages the engine may settle on.
     */
    data class Detect(val seed: String, val allowed: List<String>) : SpeechPlan

    /**
     * Core Hub transcription: the explicit alternative, chosen in
     * Settings → Voice input, or the only path on a device with no recognizer.
     * A null [hint] means the take named no language at all.
     */
    data class OnServer(val hint: String?) : SpeechPlan
}

object SpeechLanguages {

    /** Dictate in whatever language the app itself is showing. The default. */
    const val FOLLOW_APP = ""

    /** Let the recognizer work the language out from the audio. */
    const val AUTOMATIC = "auto"

    /** The API level `EXTRA_ENABLE_LANGUAGE_DETECTION` and friends were added in. */
    const val DETECTION_SDK = 34

    /** The API level `SpeechRecognizer.checkRecognitionSupport` was added in. */
    const val SUPPORT_QUERY_SDK = 33

    /** At most this many languages are offered to the engine to choose between. */
    const val MAX_DETECTION_LANGUAGES = 5

    /**
     * Offered only when the device answers nothing at all about the languages
     * it supports. These are not a claim about the device: the sheet marks
     * them unconfirmed, and picking one the recognizer cannot serve returns
     * `ERROR_LANGUAGE_NOT_SUPPORTED`, which the composer already shows in words.
     */
    val CURATED = listOf(
        "ar-SA", "en-US", "en-GB", "fr-FR", "es-ES", "de-DE",
        "tr-TR", "ur-PK", "hi-IN", "id-ID", "ru-RU", "zh-CN",
    )

    private val TAG = Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")

    /**
     * A stored or device-supplied tag in one shape: `ar_SA` and `AR-sa` both
     * become `ar-SA`. Returns "" for anything that is not a language tag, so a
     * damaged preference degrades to "follow the app" instead of reaching the
     * recognizer.
     */
    fun normalizeTag(raw: String?): String {
        val text = raw?.trim()?.replace('_', '-').orEmpty()
        if (!TAG.matches(text)) return ""
        val canonical = runCatching { Locale.forLanguageTag(text).toLanguageTag() }.getOrDefault("")
        return if (canonical.isBlank() || canonical == "und") "" else canonical
    }

    /** Reads a stored preference: [FOLLOW_APP], [AUTOMATIC] or a clean tag. */
    fun normalize(choice: String?): String {
        val text = choice?.trim().orEmpty()
        if (text.isEmpty()) return FOLLOW_APP
        if (text.equals(AUTOMATIC, ignoreCase = true)) return AUTOMATIC
        return normalizeTag(text).ifBlank { FOLLOW_APP }
    }

    /** The tag a specific choice names, or null for [FOLLOW_APP] and [AUTOMATIC]. */
    fun specificTag(choice: String?): String? =
        normalize(choice).takeIf { it != FOLLOW_APP && it != AUTOMATIC }

    /** The base subtag: `ar-SA` → `ar`. */
    fun baseLanguage(tag: String): String =
        tag.substringBefore('-').trim().lowercase(Locale.ROOT)

    /**
     * The language a take runs in when it has to name one. [AUTOMATIC] has
     * none of its own, so it borrows the app's — which is what makes the app
     * language a usable fallback when detection turns out to be impossible.
     */
    fun deviceTag(choice: String?, appLanguageTag: String): String =
        specificTag(choice) ?: normalizeTag(appLanguageTag)

    /**
     * The `language` field of `POST /api/studio/stt/transcribe`.
     *
     * Verified against this repository's server: the STT controller reads only
     * `provider` and `audio` from the multipart body and takes the language
     * from the profile's stored provider settings, so this field changes
     * nothing there today. It is still sent — it is the documented field, the
     * web client sends it too — and a blank one is the honest way to say
     * "no hint".
     */
    fun serverHint(tag: String): String? = baseLanguage(tag).takeIf { it.isNotEmpty() }

    /**
     * The tag the engine will actually serve for [tag].
     *
     * `en-SA` is a real Android locale — an English phone in Saudi Arabia —
     * and almost no recognition engine has a model for it. Handing it to the
     * recognizer buys `ERROR_LANGUAGE_NOT_SUPPORTED` at best and, on an engine
     * that shrugs and picks its own, a transcript in a language nobody asked
     * for. So the region is dropped onto a variant the engine did list.
     *
     * Only within the same base language: there is no honest fallback from a
     * language the engine simply does not have, and [supported] being empty
     * means the engine said nothing, which is not permission to guess.
     */
    fun supportedTag(tag: String, supported: List<String>): String {
        val clean = normalizeTag(tag)
        if (clean.isEmpty()) return clean
        val available = supported.mapNotNull { normalizeTag(it).takeIf(String::isNotEmpty) }
        if (available.isEmpty()) return clean
        available.firstOrNull { it.equals(clean, ignoreCase = true) }?.let { return it }
        available.firstOrNull { baseLanguage(it) == baseLanguage(clean) }?.let { return it }
        return clean
    }

    /**
     * Where this take runs. [inputMode] is Settings → Voice input, [choice] the
     * per-profile language preference, [appLanguageTag] the language on screen,
     * [recognizerAvailable] whether this device has on-device recognition at
     * all, [detection] what its engine reported about detecting, and
     * [supported] every language that engine listed — used to move a tag it
     * cannot serve onto one it can.
     */
    fun plan(
        inputMode: String,
        choice: String?,
        appLanguageTag: String,
        recognizerAvailable: Boolean,
        detection: DetectionSupport = DetectionSupport(),
        supported: List<String> = emptyList(),
    ): SpeechPlan {
        val clean = normalize(choice)
        // Core Hub is the deliberate alternative, and the only path left on a
        // phone with no recognizer at all.
        if (inputMode == Store.VOICE_INPUT_SERVER || !recognizerAvailable) {
            val hint = if (clean == AUTOMATIC) null else serverHint(deviceTag(clean, appLanguageTag))
            return SpeechPlan.OnServer(hint)
        }
        if (clean == AUTOMATIC && detection.usable) {
            return SpeechPlan.Detect(seed = seedFor(appLanguageTag, detection.allowed), allowed = detection.allowed)
        }
        // Either a named language, or automatic on a device that cannot do it:
        // no audio is sent anywhere, the take runs in one language, and the
        // caller is handed everything it needs to say which and why.
        val wanted = deviceTag(clean, appLanguageTag)
        val served = supportedTag(wanted, supported)
        return SpeechPlan.OnDevice(
            languageTag = served,
            detectionBlock = if (clean == AUTOMATIC) detection.block else DetectionBlock.None,
            requestedTag = if (served.equals(wanted, ignoreCase = true)) "" else wanted,
        )
    }

    /**
     * The language a detecting take opens in: the app's own if the engine can
     * serve it, otherwise the first language it offered.
     */
    fun seedFor(appLanguageTag: String, allowed: List<String>): String {
        val app = normalizeTag(appLanguageTag)
        if (app.isBlank()) return allowed.firstOrNull().orEmpty()
        allowed.firstOrNull { it.equals(app, ignoreCase = true) }?.let { return it }
        allowed.firstOrNull { baseLanguage(it) == baseLanguage(app) }?.let { return it }
        return allowed.firstOrNull() ?: app
    }

    /**
     * The languages the engine is allowed to choose between.
     *
     * [wanted] are the languages this owner plausibly speaks — the ones the app
     * itself ships, plus the phone's own locale, plus any language they have
     * pinned before — and [supported] is what the engine reported. Every entry
     * has to survive that intersection, so the list is never a guess: a device
     * that cannot hear a language is never asked to.
     *
     * When [supported] is empty the engine told us nothing, and the wanted
     * languages are passed through as-is for it to accept or reject itself.
     */
    fun detectionCandidates(
        wanted: List<String>,
        supported: List<String>,
        limit: Int = MAX_DETECTION_LANGUAGES,
    ): List<String> {
        val available = supported.mapNotNull { normalizeTag(it).takeIf(String::isNotEmpty) }
        val out = LinkedHashSet<String>()
        for (raw in wanted) {
            val tag = normalizeTag(raw)
            if (tag.isEmpty()) continue
            val match = when {
                available.isEmpty() -> tag
                else -> available.firstOrNull { it.equals(tag, ignoreCase = true) }
                    ?: available.firstOrNull { baseLanguage(it) == baseLanguage(tag) }
            } ?: continue
            out.add(match)
            if (out.size >= limit) break
        }
        return out.toList()
    }

    /**
     * What `onLanguageDetection` reported, or null when it is not worth
     * showing. A guess the engine itself calls unconfident is not a fact about
     * the take, and the recording sheet says nothing rather than something
     * wrong.
     */
    fun readDetected(tag: String?, confidence: Int): String? {
        val clean = normalizeTag(tag)
        if (clean.isEmpty()) return null
        if (confidence < CONFIDENCE_CONFIDENT) return null
        return clean
    }

    /** `SpeechRecognizer.LANGUAGE_DETECTION_CONFIDENCE_LEVEL_CONFIDENT`. */
    const val CONFIDENCE_CONFIDENT = 2

    /**
     * The language's name in itself — `العربية`, `Français` — so a reader can
     * find their language in a list they cannot otherwise read, the same rule
     * [AppLanguage] follows for the app's own languages.
     */
    fun endonym(tag: String): String {
        val locale = runCatching { Locale.forLanguageTag(tag) }.getOrNull() ?: return tag
        val name = runCatching { locale.getDisplayName(locale) }.getOrDefault("")
        if (name.isBlank() || name == "und") return tag
        return name.replaceFirstChar { if (it.isLowerCase()) it.titlecase(locale) else it.toString() }
    }

    /**
     * A name wrapped in a first-strong isolate.
     *
     * `English` dropped into an Arabic sentence, or `العربية` into an English
     * one, drags the punctuation around it to the wrong side. U+2068/U+2069
     * are the Unicode answer: the run is measured on its own and the sentence
     * around it keeps its own direction.
     */
    fun isolate(text: String): String = "\u2068" + text + "\u2069"

    /** [endonym], ready to be dropped into a sentence in the other script. */
    fun isolatedEndonym(tag: String): String = isolate(endonym(tag))

    /** Several language names for one sentence, each isolated. */
    fun nameList(tags: List<String>, separator: String): String =
        tags.joinToString(separator, transform = ::isolatedEndonym)

    /**
     * The rows built from what the device reported — `checkRecognitionSupport`
     * on Android 13 and up, otherwise the `ACTION_GET_LANGUAGE_DETAILS`
     * broadcast.
     *
     * Only tags the device actually listed become rows: [preferred] can move
     * one to the top but never adds one, because a language this device cannot
     * recognise is not worth offering. Junk entries are dropped, `ar_SA` and
     * `ar-SA` collapse into one row, and the rest are ordered by tag so the
     * regional variants of a language sit together.
     */
    fun fromSupported(tags: List<String>?, preferred: String? = null): List<SpeechLanguageOption> {
        val normalized = tags.orEmpty()
            .mapNotNull { normalizeTag(it).takeIf(String::isNotEmpty) }
            .distinct()
        if (normalized.isEmpty()) return emptyList()
        val head = normalizeTag(preferred)
        val sorted = normalized.sorted()
        val ordered = if (head.isNotBlank() && head in sorted) listOf(head) + (sorted - head) else sorted
        return ordered.map { SpeechLanguageOption(it, endonym(it)) }
    }

    /** The unconfirmed list, for a device that reported nothing. */
    fun curated(): List<SpeechLanguageOption> =
        CURATED.mapNotNull { raw ->
            val tag = normalizeTag(raw)
            if (tag.isEmpty()) null else SpeechLanguageOption(tag, endonym(tag), confirmed = false)
        }

    /**
     * The list the sheet shows: what the device confirmed, or the curated guess
     * when it confirmed nothing. A specific choice the device did not list is
     * still shown — dropping the owner's own stored preference would silently
     * move the selection somewhere else.
     */
    fun options(supported: List<SpeechLanguageOption>, choice: String?): List<SpeechLanguageOption> {
        val base = supported.ifEmpty { curated() }
        val picked = specificTag(choice) ?: return base
        if (base.any { it.tag.equals(picked, ignoreCase = true) }) return base
        return listOf(SpeechLanguageOption(picked, endonym(picked), confirmed = false)) + base
    }
}

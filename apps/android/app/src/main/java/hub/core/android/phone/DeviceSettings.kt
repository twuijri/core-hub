package hub.core.android.phone

import android.content.SharedPreferences
import hub.core.android.AppLanguage
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The dictation language: the app's own, or one chosen for speaking (NAVIGATION.md §2, This device). */
enum class Dictation { APP, AR, EN }

/** This phone's own choices — kept on the phone, never on the hub (they describe this device). */
data class DeviceChoices(
    /** The microphone in the composer, using the phone's own speech recognizer. */
    val voiceInput: Boolean = true,
    val dictation: Dictation = Dictation.APP,
    /** Read a finished reply aloud while its conversation is on screen. */
    val spokenReplies: Boolean = false,
    /** Look for new notices every 15 minutes while the app is closed. */
    val backgroundNotices: Boolean = true,
)

object DictationLanguage {
    /** The BCP 47 tag the recognizer is asked for. */
    fun tag(dictation: Dictation, app: AppLanguage): String = when (dictation) {
        Dictation.AR -> "ar-SA"
        Dictation.EN -> "en-US"
        Dictation.APP -> if (app == AppLanguage.AR) "ar-SA" else "en-US"
    }

    /** The voice a reply is read in: Arabic for Arabic text, English otherwise. */
    fun speechLocale(rtl: Boolean): Locale = if (rtl) Locale.forLanguageTag("ar") else Locale.ENGLISH
}

class DeviceSettings(private val prefs: SharedPreferences) {
    private val _choices = MutableStateFlow(read())
    val choices: StateFlow<DeviceChoices> = _choices.asStateFlow()

    private fun read() = DeviceChoices(
        voiceInput = prefs.getBoolean(VOICE, true),
        dictation = runCatching { Dictation.valueOf(prefs.getString(DICTATION, null) ?: "") }.getOrDefault(Dictation.APP),
        spokenReplies = prefs.getBoolean(SPOKEN, false),
        backgroundNotices = prefs.getBoolean(BACKGROUND, true),
    )

    fun update(change: (DeviceChoices) -> DeviceChoices) {
        val next = change(_choices.value)
        prefs.edit()
            .putBoolean(VOICE, next.voiceInput)
            .putString(DICTATION, next.dictation.name)
            .putBoolean(SPOKEN, next.spokenReplies)
            .putBoolean(BACKGROUND, next.backgroundNotices)
            .apply()
        _choices.value = next
    }

    /** When notices were last looked at, so each is shown once (epoch ms). */
    var noticesSeenAt: Long
        get() = prefs.getLong(SEEN, 0L)
        set(value) = prefs.edit().putLong(SEEN, value).apply()

    /** Whether the app has asked for the notification permission already. */
    var askedNotifications: Boolean
        get() = prefs.getBoolean(ASKED, false)
        set(value) = prefs.edit().putBoolean(ASKED, value).apply()

    private companion object {
        const val VOICE = "voice_input"
        const val DICTATION = "dictation"
        const val SPOKEN = "spoken_replies"
        const val BACKGROUND = "background_notices"
        const val SEEN = "notices_seen_at"
        const val ASKED = "asked_notifications"
    }
}

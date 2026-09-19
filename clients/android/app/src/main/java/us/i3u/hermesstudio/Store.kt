package us.i3u.hermesstudio

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Credentials live in EncryptedSharedPreferences, backed by a Keystore key, so
 * the bearer token is never written to disk in clear text.
 */
class Store(context: Context) {

    private val prefs: SharedPreferences = runCatching {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "hermes_secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse {
        // Keystore can be unavailable on a small number of devices; the app must
        // still run rather than crash on launch.
        context.getSharedPreferences("hermes_plain", Context.MODE_PRIVATE)
    }

    var baseUrl: String
        get() = prefs.getString(KEY_URL, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_URL, value.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    /**
     * Identifies this install to the server's App connections. Generated once
     * and kept for the life of the install, so re-pairing updates the same
     * device entry instead of creating a new one every time.
     */
    val deviceCode: String
        get() {
            val existing = prefs.getString(KEY_DEVICE_CODE, "").orEmpty()
            if (existing.isNotBlank()) return existing
            val generated = java.util.UUID.randomUUID().toString()
            prefs.edit().putString(KEY_DEVICE_CODE, generated).apply()
            return generated
        }

    /** Epoch seconds at which the App token stops working; 0 for a password login. */
    val tokenExpiresAt: Long get() = prefs.getLong(KEY_TOKEN_EXPIRES_AT, 0L)

    /** Epoch milliseconds of the last successful app-login or app-refresh. */
    val tokenRefreshedAt: Long get() = prefs.getLong(KEY_TOKEN_REFRESHED_AT, 0L)

    /** The server-side App connection row this token belongs to; 0 when unknown. */
    val appConnectionId: Int get() = prefs.getInt(KEY_APP_CONNECTION_ID, 0)

    /** True when the stored token came from app-login and can be refreshed. */
    val hasAppToken: Boolean get() = token.isNotBlank() && tokenExpiresAt > 0L

    /**
     * Writes a freshly issued App token and its metadata in one commit, so a
     * crash between fields can never leave a token paired with a stale expiry.
     */
    fun saveAppToken(token: String, expiresAt: Long, connectionId: Int, refreshedAt: Long = System.currentTimeMillis()) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putLong(KEY_TOKEN_EXPIRES_AT, expiresAt)
            .putLong(KEY_TOKEN_REFRESHED_AT, refreshedAt)
            .putInt(KEY_APP_CONNECTION_ID, connectionId)
            .commit()
    }

    /** Where dictation happens: [VOICE_INPUT_DEVICE] (default) or [VOICE_INPUT_SERVER]. */
    var voiceInput: String
        get() = prefs.getString(KEY_VOICE_INPUT, VOICE_INPUT_DEVICE).orEmpty().ifBlank { VOICE_INPUT_DEVICE }
        set(value) = prefs.edit().putString(KEY_VOICE_INPUT, value).apply()

    var profile: String
        get() = prefs.getString(KEY_PROFILE, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_PROFILE, value).apply()

    /**
     * Settings → Voice, per profile: which voice reads a reply out loud.
     *
     * [VoiceOutput.DEVICE] is the Android engine, a provider id is that Core
     * Hub provider, and [VoiceOutput.FOLLOW_SERVER] (the default, blank) means
     * whatever the profile's active provider is on the server. Kept per
     * profile because Core Hub stores its TTS settings per profile too.
     */
    fun voiceOutput(profile: String): String =
        prefs.getString("$KEY_VOICE_OUTPUT_PREFIX${profile.ifBlank { "default" }}", "").orEmpty()

    fun setVoiceOutput(profile: String, value: String) {
        prefs.edit().putString("$KEY_VOICE_OUTPUT_PREFIX${profile.ifBlank { "default" }}", value).apply()
    }

    /**
     * Settings → Dictation language, per profile: which language the
     * microphone listens for.
     *
     * [SpeechLanguages.FOLLOW_APP] (the default, blank) is the app's own
     * display language, [SpeechLanguages.AUTOMATIC] lets the recognizer work
     * it out, and anything else is a BCP-47 tag. Kept per profile so a work
     * profile the owner writes English in and a personal one he speaks Arabic
     * in do not fight over one setting.
     */
    fun speechLanguage(profile: String): String =
        SpeechLanguages.normalize(prefs.getString("$KEY_SPEECH_LANGUAGE_PREFIX${profile.ifBlank { "default" }}", ""))

    fun setSpeechLanguage(profile: String, value: String) {
        prefs.edit()
            .putString("$KEY_SPEECH_LANGUAGE_PREFIX${profile.ifBlank { "default" }}", SpeechLanguages.normalize(value))
            .apply()
    }

    fun sessionFor(profile: String): String =
        prefs.getString(sessionKey(profile), "").orEmpty()

    fun setSessionFor(profile: String, sessionId: String) {
        prefs.edit().putString(sessionKey(profile), sessionId).apply()
    }

    var onboarded: Boolean
        get() = prefs.getBoolean(KEY_ONBOARDED, false)
        set(value) = prefs.edit().putBoolean(KEY_ONBOARDED, value).apply()

    /** BCP-47 tag chosen in Settings; blank means "follow the system". */
    var language: String
        get() = prefs.getString(KEY_LANGUAGE, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_LANGUAGE, value).apply()

    /** system, light, or dark. Kept separately from Studio's display settings. */
    var appearance: String
        get() = prefs.getString(KEY_APPEARANCE, "system").orEmpty().ifBlank { "system" }
        set(value) = prefs.edit().putString(KEY_APPEARANCE, value).apply()

    var reasoningEffort: String
        get() = prefs.getString(KEY_REASONING, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_REASONING, value).apply()

    /** Composer ⚙ → "Show tool calls": the tool summary card under assistant replies. */
    var showToolCalls: Boolean
        get() = prefs.getBoolean(KEY_SHOW_TOOL_CALLS, true)
        set(value) = prefs.edit().putBoolean(KEY_SHOW_TOOL_CALLS, value).apply()

    /** Composer ⚙ → "Voice mode": read every assistant reply aloud as it completes. */
    var speakReplies: Boolean
        get() = prefs.getBoolean(KEY_SPEAK_REPLIES, false)
        set(value) = prefs.edit().putBoolean(KEY_SPEAK_REPLIES, value).apply()

    /**
     * Session pins, per profile, like the web's `hermes_session_pins_v1_<profile>`
     * localStorage key: a device-side preference, never sent to the server.
     */
    fun pinnedSessions(profile: String): Set<String> =
        prefs.getStringSet("$KEY_PINS_PREFIX$profile", emptySet()).orEmpty().toSet()

    fun setPinnedSessions(profile: String, ids: Set<String>) {
        prefs.edit().putStringSet("$KEY_PINS_PREFIX$profile", ids.toSet()).apply()
    }

    /** How many sessions the RECENT group shows (1–100, default 10), like the web. */
    var recentCount: Int
        get() = prefs.getInt(KEY_RECENT_COUNT, 10).coerceIn(1, 100)
        set(value) = prefs.edit().putInt(KEY_RECENT_COUNT, value.coerceIn(1, 100)).apply()

    /** Drawer "All profiles": list every profile's sessions, like the web's sidebar toggle. */
    var allProfiles: Boolean
        get() = prefs.getBoolean(KEY_ALL_PROFILES, false)
        set(value) = prefs.edit().putBoolean(KEY_ALL_PROFILES, value).apply()

    /** Settings › Display › Text size, a device preference (0.85–1.3, default 1). */
    var textScale: Float
        get() = prefs.getFloat(KEY_TEXT_SCALE, 1f).coerceIn(TEXT_SCALE_MIN, TEXT_SCALE_MAX)
        set(value) = prefs.edit().putFloat(KEY_TEXT_SCALE, value.coerceIn(TEXT_SCALE_MIN, TEXT_SCALE_MAX)).apply()

    fun clearCredentials() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_TOKEN_EXPIRES_AT)
            .remove(KEY_TOKEN_REFRESHED_AT)
            .remove(KEY_APP_CONNECTION_ID)
            .apply()
    }

    val isConfigured: Boolean
        get() = baseUrl.isNotBlank() && token.isNotBlank()

    private fun sessionKey(profile: String) = "$KEY_SESSION_PREFIX$profile"

    companion object {
        const val VOICE_INPUT_DEVICE = "device"
        const val VOICE_INPUT_SERVER = "server"
        const val TEXT_SCALE_MIN = 0.85f
        const val TEXT_SCALE_MAX = 1.3f
        private const val KEY_ALL_PROFILES = "sessions_all_profiles"
        private const val KEY_TEXT_SCALE = "text_scale"

        private const val KEY_URL = "base_url"
        private const val KEY_TOKEN = "token"
        private const val KEY_DEVICE_CODE = "device_code"
        private const val KEY_TOKEN_EXPIRES_AT = "token_expires_at"
        private const val KEY_TOKEN_REFRESHED_AT = "token_refreshed_at"
        private const val KEY_APP_CONNECTION_ID = "app_connection_id"
        private const val KEY_VOICE_INPUT = "voice_input"
        private const val KEY_VOICE_OUTPUT_PREFIX = "voice_output_"
        private const val KEY_SPEECH_LANGUAGE_PREFIX = "speech_language_"
        private const val KEY_PROFILE = "profile"
        private const val KEY_SESSION_PREFIX = "session_"
        private const val KEY_REASONING = "reasoning_effort"
        private const val KEY_ONBOARDED = "onboarded"
        private const val KEY_LANGUAGE = "language"
        private const val KEY_APPEARANCE = "appearance"
        private const val KEY_PINS_PREFIX = "session_pins_"
        private const val KEY_RECENT_COUNT = "recent_session_count"
        private const val KEY_SHOW_TOOL_CALLS = "show_tool_calls"
        private const val KEY_SPEAK_REPLIES = "speak_replies"
    }
}

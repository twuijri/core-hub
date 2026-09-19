package us.i3u.hermesstudio

import org.json.JSONObject

/**
 * Which voice reads a reply out loud.
 *
 * The web client never asks the server "use whatever you think is active": it
 * reads `GET /api/studio/tts/settings` once, keeps the chosen provider, and
 * then sends `provider` plus that provider's stored options on every
 * `POST /api/studio/tts/synthesize`. The phone used to send neither, so the
 * server fell back to [BUILT_IN] ("edge", Microsoft's free voice) whenever the
 * profile had no stored active provider and more than one provider configured
 * — and the owner heard the device voice with an unexplained banner.
 *
 * This file is the phone's half of that contract: parse the settings, pick the
 * provider the way the owner asked, and name it when something fails.
 */

/** One TTS provider Core Hub has stored for a profile. */
data class VoiceProvider(
    val id: String,
    /** Stored, non-secret options, exactly as Core Hub returns them. */
    val options: Map<String, String> = emptyMap(),
    /** Core Hub holds an API key for this provider; the key itself never leaves the server. */
    val hasApiKey: Boolean = false,
)

/** `GET /api/studio/tts/settings` for one profile. */
data class VoiceSettings(
    val providers: List<VoiceProvider> = emptyList(),
    /** What the server would pick on its own; blank when it has stored none. */
    val activeProvider: String = "",
) {
    fun provider(id: String): VoiceProvider? = providers.firstOrNull { it.id == id }
}

/** Where one spoken reply has to come from. */
sealed interface VoiceTarget {
    /** The Android engine, because the owner picked it in Settings. */
    data object Device : VoiceTarget

    /** Core Hub, with the provider named explicitly so the server never guesses. */
    data class Server(val provider: String, val options: Map<String, String>) : VoiceTarget
}

object VoiceOutput {
    /** Settings → Voice: read replies with the Android engine. */
    const val DEVICE = "device"

    /** Settings → Voice: whatever Core Hub says is active for the profile. */
    const val FOLLOW_SERVER = ""

    /** The server's own fallback when nothing is stored: Microsoft's free voice. */
    const val BUILT_IN = "edge"

    /**
     * Every provider `assertStoredTtsProvider` accepts, in the order Studio
     * lists them. An id outside this set is ignored rather than sent back to
     * the server, which would answer 400 "unknown TTS provider".
     */
    val PROVIDERS = listOf(
        "edge", "openai", "custom", "mimo", "doubao", "elevenlabs",
        "gemini", "xai", "mistral", "minimax", "deepinfra", "groq",
    )

    /** The server's own PROVIDER_LABELS; brand names, so both locales share them. */
    private val LABELS = mapOf(
        "edge" to "Edge TTS",
        "openai" to "OpenAI TTS",
        "custom" to "Custom TTS",
        "mimo" to "MiMo TTS",
        "doubao" to "Doubao TTS",
        "elevenlabs" to "ElevenLabs TTS",
        "gemini" to "Gemini TTS",
        "xai" to "xAI TTS",
        "mistral" to "Mistral TTS",
        "minimax" to "MiniMax TTS",
        "deepinfra" to "DeepInfra TTS",
        "groq" to "Groq TTS",
    )

    fun isProvider(id: String): Boolean = id in PROVIDERS

    fun label(id: String): String = LABELS[id] ?: id.ifBlank { BUILT_IN }

    /**
     * Reads the settings envelope. The server answers `{settings, activeProvider}`;
     * the web's own parser also accepts `{providers, …}`, so both are read here.
     */
    fun parse(body: JSONObject?): VoiceSettings {
        if (body == null) return VoiceSettings()
        val rows = body.optJSONArray("settings") ?: body.optJSONArray("providers")
        val providers = buildList {
            for (index in 0 until (rows?.length() ?: 0)) {
                val row = rows?.optJSONObject(index) ?: continue
                val id = row.optString("provider").trim()
                if (!isProvider(id)) continue
                add(
                    VoiceProvider(
                        id = id,
                        options = readOptions(row.optJSONObject("settings")),
                        hasApiKey = row.optJSONObject("secrets")?.optString("apiKey").orEmpty().isNotBlank(),
                    ),
                )
            }
        }
        val active = body.optString("activeProvider").trim()
        return VoiceSettings(providers, if (isProvider(active)) active else "")
    }

    /**
     * Only the plain string options travel back. `baseUrlPresets` is an array of
     * past URLs the settings screen offers, not an input to a synthesis, and a
     * blank value would only override a stored one with nothing.
     */
    private fun readOptions(settings: JSONObject?): Map<String, String> {
        if (settings == null) return emptyMap()
        val keys = settings.keys()
        val options = LinkedHashMap<String, String>()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key == "apiKey") continue
            val value = settings.opt(key)
            if (value is String && value.isNotBlank()) options[key] = value
        }
        return options
    }

    /**
     * Turns the owner's stored choice into the request the phone will send.
     *
     * When the owner has not picked anything the server's own rule is mirrored
     * (`resolveActiveTtsProvider` in the TTS controller): the stored active
     * provider, else the single configured non-[BUILT_IN] provider, else
     * [BUILT_IN]. Mirroring it rather than sending nothing means the app can
     * show which provider is in effect and name it when it fails.
     */
    fun resolve(choice: String, settings: VoiceSettings): VoiceTarget {
        if (choice == DEVICE) return VoiceTarget.Device
        val provider = if (isProvider(choice)) choice else effectiveProvider(settings)
        return VoiceTarget.Server(provider, settings.provider(provider)?.options.orEmpty())
    }

    /** The provider a blank choice resolves to, for the Settings list and its labels. */
    fun effectiveProvider(settings: VoiceSettings): String {
        if (isProvider(settings.activeProvider)) return settings.activeProvider
        val configured = settings.providers.map { it.id }.filter { it != BUILT_IN }
        return configured.singleOrNull() ?: BUILT_IN
    }

    /**
     * The rows Settings → Voice shows: every provider Core Hub has stored for
     * the profile, with the built-in one always present the way the web always
     * lists its `tts-edge` connection.
     */
    fun listedProviders(settings: VoiceSettings): List<VoiceProvider> {
        val stored = settings.providers
        if (stored.any { it.id == BUILT_IN }) return stored
        return stored + VoiceProvider(BUILT_IN)
    }
}

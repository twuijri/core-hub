package us.i3u.hermesstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The settings envelope and the provider choice behind the "speak" button.
 *
 * The bug these cover: the phone sent no `provider`, so the server fell back to
 * `resolveActiveTtsProvider` and answered `edge` — Microsoft's free voice —
 * even though the profile had an Arabic provider configured. The rule is
 * mirrored here so the phone names a provider on every request and can say
 * which one it asked for when the answer is not audio.
 */
class VoiceOutputTest {

    private fun settings(body: String) = VoiceOutput.parse(JSONObject(body))

    @Test
    fun `the settings envelope is read the way the TTS controller writes it`() {
        val parsed = settings(
            """
            {
              "settings": [
                {"provider":"elevenlabs",
                 "settings":{"baseUrl":"https://api.elevenlabs.io/v1","voice":"ar-Layla","model":"","speed":"1",
                             "baseUrlPresets":["https://api.elevenlabs.io/v1"]},
                 "secrets":{"apiKey":"[stored]"},"updatedAt":1785000000000},
                {"provider":"edge","settings":{"voice":"ar-SA-HamedNeural"},"secrets":{}}
              ],
              "activeProvider": "elevenlabs"
            }
            """.trimIndent(),
        )

        assertEquals(listOf("elevenlabs", "edge"), parsed.providers.map { it.id })
        assertEquals("elevenlabs", parsed.activeProvider)
        val arabic = parsed.provider("elevenlabs")!!
        assertTrue("Studio holds the key, so the phone must not be asked for one", arabic.hasApiKey)
        assertEquals(
            mapOf("baseUrl" to "https://api.elevenlabs.io/v1", "voice" to "ar-Layla", "speed" to "1"),
            arabic.options,
        )
        assertFalse("the built-in voice has no stored key", parsed.provider("edge")!!.hasApiKey)
    }

    @Test
    fun `the web's providers alias is accepted and unknown ids are dropped`() {
        val parsed = settings(
            """{"providers":[{"provider":"openai","settings":{"model":"tts-1"}},
                             {"provider":"not-a-provider","settings":{}}],
                "activeProvider":"not-a-provider"}""",
        )

        assertEquals(listOf("openai"), parsed.providers.map { it.id })
        assertEquals("an id the server would reject must not come back as active", "", parsed.activeProvider)
    }

    @Test
    fun `an empty or missing body is not a provider list`() {
        assertEquals(VoiceSettings(), VoiceOutput.parse(null))
        assertEquals(VoiceSettings(), settings("{}"))
    }

    @Test
    fun `the stored active provider is what a blank choice asks for`() {
        val parsed = settings(
            """{"settings":[{"provider":"elevenlabs","settings":{"voice":"ar-Layla"}},
                            {"provider":"groq","settings":{"voice":"Nasser"}}],
                "activeProvider":"elevenlabs"}""",
        )

        val target = VoiceOutput.resolve(VoiceOutput.FOLLOW_SERVER, parsed)

        assertEquals(VoiceTarget.Server("elevenlabs", mapOf("voice" to "ar-Layla")), target)
    }

    @Test
    fun `with nothing active a single configured provider wins, two fall back to the built-in`() {
        val single = settings("""{"settings":[{"provider":"elevenlabs","settings":{"voice":"ar-Layla"}}]}""")
        assertEquals("elevenlabs", VoiceOutput.effectiveProvider(single))

        // The reported bug: two configured providers and no stored active one,
        // so the server answers `edge` and the phone must say so out loud.
        val both = settings(
            """{"settings":[{"provider":"elevenlabs","settings":{}},{"provider":"groq","settings":{}}]}""",
        )
        assertEquals(VoiceOutput.BUILT_IN, VoiceOutput.effectiveProvider(both))
        assertEquals(VoiceOutput.BUILT_IN, VoiceOutput.effectiveProvider(VoiceSettings()))

        // The built-in alone is not a configured choice either.
        val onlyEdge = settings("""{"settings":[{"provider":"edge","settings":{"voice":"ar-SA-HamedNeural"}}]}""")
        assertEquals(VoiceOutput.BUILT_IN, VoiceOutput.effectiveProvider(onlyEdge))
    }

    @Test
    fun `an explicit choice beats the server's own active provider`() {
        val parsed = settings(
            """{"settings":[{"provider":"elevenlabs","settings":{"voice":"ar-Layla"}},
                            {"provider":"groq","settings":{"voice":"Nasser"}}],
                "activeProvider":"elevenlabs"}""",
        )

        assertEquals(
            VoiceTarget.Server("groq", mapOf("voice" to "Nasser")),
            VoiceOutput.resolve("groq", parsed),
        )
        assertEquals(VoiceTarget.Device, VoiceOutput.resolve(VoiceOutput.DEVICE, parsed))
    }

    @Test
    fun `a provider with no stored row is still asked for by name`() {
        val target = VoiceOutput.resolve("edge", settings("""{"settings":[]}"""))

        assertEquals(VoiceTarget.Server("edge", emptyMap()), target)
    }

    @Test
    fun `the settings list always offers the built-in voice`() {
        val listed = VoiceOutput.listedProviders(
            settings("""{"settings":[{"provider":"elevenlabs","settings":{}}]}"""),
        )
        assertEquals(listOf("elevenlabs", "edge"), listed.map { it.id })

        val stored = VoiceOutput.listedProviders(
            settings("""{"settings":[{"provider":"edge","settings":{"voice":"ar-SA-HamedNeural"}}]}"""),
        )
        assertEquals(listOf("edge"), stored.map { it.id })
        assertEquals(mapOf("voice" to "ar-SA-HamedNeural"), stored.single().options)
    }

    @Test
    fun `every id the phone can send is one the server stores`() {
        // assertStoredTtsProvider rejects anything else with 400.
        assertEquals(
            listOf("custom", "deepinfra", "doubao", "edge", "elevenlabs", "gemini",
                   "groq", "mimo", "minimax", "mistral", "openai", "xai"),
            VoiceOutput.PROVIDERS.sorted(),
        )
        assertFalse(VoiceOutput.isProvider("webspeech"))
        assertFalse(VoiceOutput.isProvider(VoiceOutput.DEVICE))
        assertEquals("ElevenLabs TTS", VoiceOutput.label("elevenlabs"))
    }
}

package us.i3u.hermesstudio

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The request the "speak" button sends, and what the app is told when it comes
 * back without audio.
 *
 * The phone used to post `{text, options:{}}` with no `provider`, which let the
 * server resolve one on its own, and it reported every failure as a bare
 * "HTTP 502". Both are fixed here: the provider is named, and the server's
 * status and error body reach the banner.
 */
class VoiceSynthesisTest {
    private lateinit var server: MockWebServer
    private lateinit var api: HermesApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = HermesApi(server.url("/").toString().trimEnd('/'), "saved-token")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun enqueueAudio(bytes: ByteArray, contentType: String, provider: String) {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", contentType)
                .setHeader("X-TTS-Provider", provider)
                .setHeader("X-TTS-Engine", "$provider-engine")
                .setBody(Buffer().write(bytes)),
        )
    }

    private fun wav(): ByteArray = "RIFF....WAVEfmt ".toByteArray(Charsets.US_ASCII) + ByteArray(32)

    @Test
    fun `synthesize names the provider and sends its stored options`() {
        enqueueAudio(wav(), "audio/wav", "elevenlabs")

        val audio = api.synthesize(
            profile = "manager",
            text = "مرحبا",
            provider = "elevenlabs",
            options = mapOf("voice" to "ar-Layla", "model" to "eleven_multilingual_v2"),
        )

        val request = server.takeRequest()
        assertEquals("/api/studio/tts/synthesize", request.path)
        assertEquals("manager", request.getHeader("X-Hermes-Profile"))
        assertEquals("Bearer saved-token", request.getHeader("Authorization"))
        val body = JSONObject(request.body.readUtf8())
        assertEquals("elevenlabs", body.getString("provider"))
        assertEquals("مرحبا", body.getString("text"))
        assertEquals("ar-Layla", body.getJSONObject("options").getString("voice"))
        assertEquals("eleven_multilingual_v2", body.getJSONObject("options").getString("model"))
        assertEquals("audio/wav", audio.mime)
        assertEquals(".wav", audio.extension)
        assertEquals("elevenlabs", audio.provider)
        assertEquals("elevenlabs-engine", audio.engine)
    }

    @Test
    fun `blank options and the API key never travel`() {
        enqueueAudio(wav(), "audio/wav", "groq")

        api.synthesize("manager", "hi", "groq", mapOf("voice" to "Nasser", "model" to "", "apiKey" to "sk-secret"))

        val options = JSONObject(server.takeRequest().body.readUtf8()).getJSONObject("options")
        assertEquals("Nasser", options.getString("voice"))
        // An empty value would override a stored setting with nothing, and the
        // key belongs to the server's own secret store.
        assertEquals(setOf("voice"), options.keys().asSequence().toSet())
    }

    @Test
    fun `an unnamed provider is still a valid request for the server's own choice`() {
        enqueueAudio(wav(), "audio/mpeg", "edge")

        api.synthesize("manager", "hi")

        val body = JSONObject(server.takeRequest().body.readUtf8())
        assertTrue("no provider must mean no field, not an empty one", !body.has("provider"))
    }

    @Test
    fun `a 5xx carries the server's status, error and detail to the banner`() {
        server.enqueue(
            MockResponse().setResponseCode(502)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"TTS synthesis failed","detail":"edge-tts returned 403 for this network"}"""),
        )

        val failure = assertThrows(TtsSynthesisException::class.java) {
            api.synthesize("manager", "hi", "edge")
        }

        assertEquals("edge", failure.provider)
        assertEquals(502, failure.statusCode)
        assertEquals("tts_http_error", failure.code)
        assertEquals("HTTP 502: TTS synthesis failed: edge-tts returned 403 for this network", failure.message)
    }

    @Test
    fun `a JSON error served as HTTP 200 is reported, not handed to the player`() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"TTS synthesis failed","detail":"model playai-tts-arabic is decommissioned"}"""),
        )

        val failure = assertThrows(TtsSynthesisException::class.java) {
            api.synthesize("manager", "hi", "groq")
        }

        assertEquals("groq", failure.provider)
        assertEquals("tts_not_audio", failure.code)
        assertTrue(failure.message!!.contains("decommissioned"))
    }

    @Test
    fun `a body that is not JSON at all is still quoted back`() {
        server.enqueue(
            MockResponse().setResponseCode(504)
                .setHeader("Content-Type", "text/html")
                .setBody("<html>\n<body>504 Gateway Time-out</body>\n</html>"),
        )

        val failure = assertThrows(TtsSynthesisException::class.java) {
            api.synthesize("manager", "hi", "elevenlabs")
        }

        assertTrue(failure.message, failure.message!!.contains("504 Gateway Time-out"))
    }

    @Test
    fun `an empty 200 is its own failure and names the provider asked for`() {
        server.enqueue(MockResponse().setHeader("Content-Type", "audio/mpeg").setBody(""))

        val failure = assertThrows(TtsSynthesisException::class.java) {
            api.synthesize("manager", "hi", "elevenlabs")
        }

        assertEquals("elevenlabs", failure.provider)
        assertEquals("tts_empty_audio", failure.code)
    }

    @Test
    fun `settings are read for the requested profile`() {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{"settings":[{"provider":"elevenlabs","settings":{"voice":"ar-Layla"},
                                 "secrets":{"apiKey":"[stored]"}}],"activeProvider":"elevenlabs"}""",
            ),
        )

        val settings = api.ttsSettings("manager")

        val request = server.takeRequest()
        assertEquals("/api/studio/tts/settings", request.path)
        assertEquals("manager", request.getHeader("X-Hermes-Profile"))
        assertEquals("elevenlabs", settings.activeProvider)
        assertEquals(mapOf("voice" to "ar-Layla"), settings.provider("elevenlabs")?.options)
    }

    @Test
    fun `picking a provider writes Studio's active provider once`() {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{"activeProvider":"groq"}"""),
        )

        assertEquals("groq", api.setActiveTtsProvider("manager", "groq"))

        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/studio/tts/settings/active", request.path)
        assertEquals("groq", JSONObject(request.body.readUtf8()).getString("provider"))
        assertNull("speaking must never write the active provider", server.takeRequest(1, java.util.concurrent.TimeUnit.MILLISECONDS))
    }
}

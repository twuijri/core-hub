package us.i3u.hermesstudio

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * What the chosen dictation language actually puts on the wire.
 *
 * The on-device half is covered by [SpeechLanguageTest]; this is the other
 * path the brief asks to reach — `POST /api/studio/stt/transcribe` — plus the
 * preflight that decides whether the profile can transcribe at all.
 */
class SpeechRequestTest {
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

    private fun enqueueStatus(configured: Boolean, provider: String?, reason: String? = null) {
        val body = buildString {
            append("""{"profile":"manager","configured":$configured""")
            provider?.let { append(""","activeProvider":"$it"""") }
            reason?.let { append(""","reason":"$it"""") }
            append("}")
        }
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(body))
    }

    private fun enqueueTranscript(text: String, language: String? = null) {
        val extra = language?.let { ""","language":"$it"""" }.orEmpty()
        server.enqueue(
            MockResponse().setHeader("Content-Type", "application/json")
                .setBody("""{"text":"$text","provider":"openai","model":"gpt-4o-transcribe"$extra,"durationMs":1200}"""),
        )
    }

    private fun wav(): ByteArray = WavFormat.wrap(ByteArray(3_200))

    @Test
    fun `a chosen language travels as the language field, scoped to the profile`() {
        enqueueStatus(configured = true, provider = "openai")
        enqueueTranscript("السلام عليكم", language = "ar")

        val result = api.transcribe("manager", wav(), language = "ar")

        val status = server.takeRequest()
        assertEquals("/api/studio/stt/profile-status?profile=manager", status.path)
        val upload = server.takeRequest()
        assertEquals("/api/studio/stt/transcribe?profile=manager", upload.path)
        assertEquals("manager", upload.getHeader("X-Hermes-Profile"))
        val body = upload.body.readUtf8()
        assertTrue("the provider is required by the server", body.contains("""name="provider""""))
        assertTrue(body.contains("openai"))
        assertTrue("""the chosen language has to reach the request""", body.contains("""name="language""""))
        assertTrue(body.contains("\r\n\r\nar\r\n"))
        assertEquals("السلام عليكم", result.text)
        assertEquals("ar", result.language)
    }

    @Test
    fun `no language means no field at all, not an empty one`() {
        enqueueStatus(configured = true, provider = "openai")
        enqueueTranscript("hello")

        api.transcribe("manager", wav(), language = null)

        server.takeRequest()
        val body = server.takeRequest().body.readUtf8()
        // An empty part would be a different claim from saying nothing.
        assertFalse(body.contains("""name="language""""))
    }

    @Test
    fun `a blank language is treated as no language`() {
        enqueueStatus(configured = true, provider = "openai")
        enqueueTranscript("hello")

        api.transcribe("manager", wav(), language = "   ")

        server.takeRequest()
        assertFalse(server.takeRequest().body.readUtf8().contains("""name="language""""))
    }

    @Test
    fun `a profile with no usable provider fails before any audio is uploaded`() {
        enqueueStatus(configured = false, provider = null, reason = "active_stt_provider_missing")

        val failure = assertThrows(SttNotConfiguredException::class.java) {
            api.transcribe("manager", wav(), language = "ar")
        }

        assertEquals("active_stt_provider_missing", failure.reason)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `the browser provider is not something a phone can use`() {
        enqueueStatus(configured = true, provider = "browser")

        assertThrows(SttNotConfiguredException::class.java) {
            api.transcribe("manager", wav(), language = "ar")
        }
        assertEquals("no recording is uploaded to a provider the phone cannot drive", 1, server.requestCount)
    }

    @Test
    fun `silence comes back as its own code, not a generic failure`() {
        enqueueStatus(configured = true, provider = "openai")
        server.enqueue(
            MockResponse().setResponseCode(400).setHeader("Content-Type", "application/json")
                .setBody("""{"error":"No speech detected","code":"no_speech_detected"}"""),
        )

        val failure = assertThrows(HermesException::class.java) {
            api.transcribe("manager", wav(), language = "ar")
        }
        assertEquals("no_speech_detected", failure.code)
    }
}

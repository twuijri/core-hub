package us.i3u.hermesstudio

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/**
 * The reported bug, end to end, against `tools/mock-studio.py`.
 *
 * `MockWebServer` proves what the client sends; this proves the whole path —
 * the real [HermesApi] talking to a server that resolves an unnamed provider
 * the way Core Hub does. Skipped when the machine has no python3.
 */
class MockStudioVoiceTest {

    private val mock = File("../tools/mock-studio.py")
    private var process: Process? = null
    private lateinit var api: HermesApi

    @Before
    fun startMock() {
        assumeTrue("python3 is required to run the mock server", python3() != null)
        assumeTrue("tools/mock-studio.py must be next to the app module", mock.isFile)
        val started = ProcessBuilder(python3()!!, mock.absolutePath, "0")
            .directory(mock.parentFile)
            .redirectErrorStream(true)
            .start()
        process = started
        // The mock prints the port it was given; port 0 means "any free one".
        val banner = started.inputStream.bufferedReader().readLine().orEmpty()
        val port = Regex(":(\\d+)").find(banner)?.groupValues?.get(1)
        assumeTrue("the mock did not report a port: $banner", port != null)
        api = HermesApi("http://127.0.0.1:$port", "mock-token")
    }

    @After
    fun stopMock() {
        process?.destroy()
        process?.waitFor()
    }

    @Test
    fun `the profile's providers and its active voice come back`() {
        val settings = api.ttsSettings("manager")

        assertEquals("elevenlabs", settings.activeProvider)
        assertEquals(listOf("elevenlabs", "groq", "edge"), settings.providers.map { it.id })
        val arabic = settings.provider("elevenlabs")!!
        assertTrue(arabic.hasApiKey)
        assertEquals("ar-Layla", arabic.options["voice"])
    }

    @Test
    fun `naming no provider is the bug - the server picks the built-in voice and it fails`() {
        val failure = assertThrows(TtsSynthesisException::class.java) {
            api.synthesize("manager", "السلام عليكم")
        }

        assertEquals(VoiceOutput.BUILT_IN, failure.provider)
        assertEquals(502, failure.statusCode)
        assertTrue(failure.message, failure.message!!.contains("edge-tts returned 403"))
    }

    @Test
    fun `naming the profile's own provider is the fix`() {
        val settings = api.ttsSettings("manager")
        val target = VoiceOutput.resolve(VoiceOutput.FOLLOW_SERVER, settings) as VoiceTarget.Server

        assertEquals("elevenlabs", target.provider)
        val audio = api.synthesize("manager", "السلام عليكم", target.provider, target.options)

        assertEquals("audio/wav", audio.mime)
        assertEquals("elevenlabs", audio.provider)
        assertTrue("the mock must answer with real WAV bytes", audio.bytes.size > 44)
    }

    @Test
    fun `a JSON error served as HTTP 200 never reaches the player`() {
        val failure = assertThrows(TtsSynthesisException::class.java) {
            api.synthesize("manager", "hi", "groq")
        }

        assertEquals("tts_not_audio", failure.code)
        assertTrue(failure.message, failure.message!!.contains("decommissioned"))
    }

    @Test
    fun `a provider Core Hub does not have is a 4xx the banner can quote`() {
        val failure = assertThrows(TtsSynthesisException::class.java) {
            api.synthesize("manager", "hi", "gemini")
        }

        assertEquals(400, failure.statusCode)
        assertTrue(failure.message, failure.message!!.contains("unknown TTS provider"))
    }

    @Test
    fun `picking a provider moves Studio's active one`() {
        assertEquals("groq", api.setActiveTtsProvider("manager", "groq"))
        assertEquals("groq", api.ttsSettings("manager").activeProvider)
    }

    private fun python3(): String? = sequenceOf("/usr/bin/python3", "python3")
        .firstOrNull { candidate ->
            runCatching {
                ProcessBuilder(candidate, "--version").redirectErrorStream(true).start().waitFor() == 0
            }.getOrDefault(false)
        }
}

package us.i3u.hermesstudio

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The whole update path against `tools/mock-studio.py`, through the real
 * [HermesApi].
 *
 * The pure tests prove the arithmetic; this proves the wire: that the check
 * reaches a server that answers the contract, that the download really resumes
 * with `Range` rather than silently starting again, and that a channel the
 * owner has not configured comes back as something the app can explain instead
 * of as a crash. Skipped when the machine has no python3.
 */
class MockStudioUpdateTest {

    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val mock = File("../tools/mock-studio.py")
    private var process: Process? = null
    private var mockPort: String = ""
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
        val banner = started.inputStream.bufferedReader().readLine().orEmpty()
        val port = Regex(":(\\d+)").find(banner)?.groupValues?.get(1)
        assumeTrue("the mock did not report a port: $banner", port != null)
        mockPort = port!!
        api = HermesApi("http://127.0.0.1:$port", "mock-token")
        api.activeProfile = "manager"
    }

    @After
    fun stopMock() {
        process?.destroy()
        process?.waitFor()
    }

    private val installed = AppBuild.parse("1.0.2-test.22")

    @Test
    fun `the check comes back as an offer the app can act on`() {
        val verdict = parseMobileUpdate(api.mobileUpdate(channel = "test"), installed)

        val release = (verdict as UpdateCheckResult.Available).release
        assertEquals("1.0.2-test.999", release.versionName)
        assertEquals(999, release.build.buildNumber)
        assertTrue("the offer must carry its size", release.sizeBytes > 0)
        assertTrue(release.notes.isNotBlank())
        assertTrue(release.downloadPath.startsWith("/api/studio/app-updates/mobile/download"))
    }

    @Test
    fun `a channel the owner never configured is a reason, not a failure`() {
        val verdict = parseMobileUpdate(api.mobileUpdate(channel = "beta"), installed)

        assertEquals(UpdateCheckResult.Unavailable(UpdateProblem.NotConfigured), verdict)
    }

    @Test
    fun `the download arrives whole and matches the size the check promised`() {
        val release = offered()
        val apk = File(temporaryFolder.root, "core-hub.apk")

        val written = api.downloadMobileUpdate(release.downloadPath, apk, release.sizeBytes)

        assertEquals(release.sizeBytes, written)
        assertEquals(release.sizeBytes, apk.length())
        assertEquals("a downloaded APK must start with the zip magic", "PK", apk.readBytes().copyOfRange(0, 2).toString(Charsets.US_ASCII))
        assertTrue(UpdateDownload.isComplete(apk.length(), release.sizeBytes))
    }

    @Test
    fun `an interrupted download resumes with Range instead of starting again`() {
        val release = offered()
        val apk = File(temporaryFolder.root, "core-hub.apk")
        val whole = File(temporaryFolder.root, "whole.apk")
        api.downloadMobileUpdate(release.downloadPath, whole, release.sizeBytes)

        // Stop a third of the way in, the way a dropped connection would.
        val stopAt = release.sizeBytes / 3
        var seen = 0L
        api.downloadMobileUpdate(
            downloadPath = release.downloadPath,
            destination = apk,
            declaredSize = release.sizeBytes,
            onProgress = { downloaded, _ -> seen = downloaded },
            isCancelled = { seen >= stopAt },
        )
        val partial = apk.length()
        assertTrue("the partial download must have written something", partial in 1 until release.sizeBytes)

        // The second attempt asks for the rest and appends it in place.
        val written = api.downloadMobileUpdate(release.downloadPath, apk, release.sizeBytes)

        assertEquals(release.sizeBytes, written)
        assertEquals(release.sizeBytes, apk.length())
        assertTrue(
            "a resumed download must produce the same bytes as a whole one",
            apk.readBytes().contentEquals(whole.readBytes()),
        )
    }

    @Test
    fun `the resumed half really is the cached half, not the file fetched twice`() {
        // A resumed download and a restarted one both end up the right length,
        // so length proves nothing. Marking the cached prefix and finding the
        // mark still there afterwards proves the server sent only the tail.
        val release = offered()
        val apk = File(temporaryFolder.root, "core-hub.apk")
        val prefix = 1_024L
        api.downloadMobileUpdate(
            downloadPath = release.downloadPath,
            destination = apk,
            declaredSize = release.sizeBytes,
            isCancelled = { apk.length() >= prefix },
        )
        val marked = apk.readBytes().copyOf().also { it[0] = 0x2a }
        apk.writeBytes(marked)
        val keptLength = apk.length()
        assertTrue(keptLength in 1 until release.sizeBytes)

        api.downloadMobileUpdate(release.downloadPath, apk, release.sizeBytes)

        assertEquals(release.sizeBytes, apk.length())
        assertEquals("the cached prefix was re-downloaded instead of resumed", 0x2a.toByte(), apk.readBytes()[0])
    }

    @Test
    fun `a cache left over from another build is thrown away, not appended to`() {
        val release = offered()
        val apk = File(temporaryFolder.root, "core-hub.apk")
        // Longer than the release: bytes from a build that is not this one.
        apk.writeBytes(ByteArray((release.sizeBytes + 512).toInt()) { 0x7f })

        val written = api.downloadMobileUpdate(release.downloadPath, apk, release.sizeBytes)

        assertEquals(release.sizeBytes, written)
        assertEquals(release.sizeBytes, apk.length())
        assertNotEquals(0x7f.toByte(), apk.readBytes().last())
    }

    @Test
    fun `an already complete cache is handed back without asking the server again`() {
        val release = offered()
        val apk = File(temporaryFolder.root, "core-hub.apk")
        api.downloadMobileUpdate(release.downloadPath, apk, release.sizeBytes)
        val modifiedAt = apk.lastModified()

        val written = api.downloadMobileUpdate(release.downloadPath, apk, release.sizeBytes)

        assertEquals(release.sizeBytes, written)
        assertEquals("the finished file must not be rewritten", modifiedAt, apk.lastModified())
    }

    @Test
    fun `downloading from an unconfigured channel is a 409 the app can name`() {
        val apk = File(temporaryFolder.root, "core-hub.apk")

        val failure = assertThrows(HermesException::class.java) {
            api.downloadMobileUpdate(
                "/api/studio/app-updates/mobile/download?platform=android&channel=beta",
                apk,
                declaredSize = 0L,
            )
        }

        assertEquals(409, failure.statusCode)
        assertEquals("updates_not_configured", failure.code)
        assertEquals(
            UpdateOutcome.NotConfigured,
            updateProblemFor(failure.statusCode, failure.code, transportFailure = false).outcome(),
        )
    }

    @Test
    fun `progress is reported from the first byte to the last`() {
        val release = offered()
        val apk = File(temporaryFolder.root, "core-hub.apk")
        val seen = mutableListOf<Pair<Long, Long>>()

        api.downloadMobileUpdate(
            downloadPath = release.downloadPath,
            destination = apk,
            declaredSize = release.sizeBytes,
            onProgress = { downloaded, total -> seen += downloaded to total },
        )

        assertTrue(seen.isNotEmpty())
        assertEquals(0L to release.sizeBytes, seen.first())
        assertEquals(release.sizeBytes to release.sizeBytes, seen.last())
        assertEquals(100, UpdateDownload.percent(seen.last().first, seen.last().second))
    }

    @Test
    fun `both routes carry the same authentication as every other call`() {
        // The check echoes what it received, so the headers are proved, not assumed.
        val body = api.mobileUpdate(channel = "test")
        assertEquals("Bearer mock-token", body.optString("mockAuthorization"))
        assertEquals("manager", body.optString("mockProfile"))

        // And the download is as private as the release it streams: without a
        // bearer token the mock refuses it, which is only observable because
        // the real client does send one on the calls above.
        val anonymous = HermesApi("http://127.0.0.1:$mockPort", "")
        val failure = assertThrows(HermesException::class.java) {
            anonymous.downloadMobileUpdate(
                "/api/studio/app-updates/mobile/download?platform=android&channel=test",
                File(temporaryFolder.root, "anonymous.apk"),
                declaredSize = 0L,
            )
        }
        assertEquals(401, failure.statusCode)
        assertEquals(
            UpdateOutcome.Unauthorized,
            updateProblemFor(failure.statusCode, failure.code, transportFailure = false).outcome(),
        )
    }

    private fun offered(): MobileRelease =
        (parseMobileUpdate(api.mobileUpdate(channel = "test"), installed) as UpdateCheckResult.Available).release

    private fun python3(): String? = sequenceOf("/usr/bin/python3", "python3")
        .firstOrNull { candidate ->
            runCatching {
                ProcessBuilder(candidate, "--version").redirectErrorStream(true).start().waitFor() == 0
            }.getOrDefault(false)
        }
}

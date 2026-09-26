package hub.core.android.phone

import hub.core.android.MemoryPrefs
import hub.core.android.repoRoot
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** Self-update from GitHub releases (SelfUpdate.kt): versions, the APK, the six hours, Later, the Play switch. */
class SelfUpdateTest {
    private val server = MockWebServer()

    @After fun stop() { runCatching { server.shutdown() } }

    private fun release(version: String, size: Long = 1234, sha256: String? = null) = AppRelease(
        version = version,
        apkName = "Core-Hub-$version-android.apk",
        apkUrl = "https://github.com/twuijri/core-hub/releases/download/v$version/Core-Hub-$version-android.apk",
        size = size,
        sha256 = sha256,
        pageUrl = "https://github.com/twuijri/core-hub/releases/tag/v$version",
    )

    /** The shape of `GET /repos/twuijri/core-hub/releases/latest`, trimmed. */
    private fun latestJson(
        tag: String = "v1.1.3",
        prerelease: Boolean = false,
        draft: Boolean = false,
        apkUrl: String? = null,
        digest: String? = "sha256:" + "ab".repeat(32),
    ): String {
        val v = tag.removePrefix("v")
        val url = apkUrl ?: "https://github.com/twuijri/core-hub/releases/download/$tag/Core-Hub-$v-android.apk"
        return """
            {"tag_name":"$tag","name":"Core Hub $v","draft":$draft,"prerelease":$prerelease,
             "html_url":"https://github.com/twuijri/core-hub/releases/tag/$tag",
             "assets":[
               {"name":"Core-Hub-Setup-$v-x64.exe","size":110000000,"browser_download_url":"https://github.com/twuijri/core-hub/releases/download/$tag/Core-Hub-Setup-$v-x64.exe"},
               {"name":"Core-Hub-$v-arm64.dmg","size":120000000,"browser_download_url":"https://github.com/twuijri/core-hub/releases/download/$tag/Core-Hub-$v-arm64.dmg"},
               {"name":"Core-Hub-$v-android.apk","size":31457280,${digest?.let { "\"digest\":\"$it\"," } ?: ""}"browser_download_url":"$url"}
             ]}
        """.trimIndent()
    }

    // --- versions ---------------------------------------------------------------------------

    @Test fun `versions compare as semantic versions`() {
        assertTrue(ReleaseRules.isNewer("1.1.3", "1.1.2"))
        assertTrue(ReleaseRules.isNewer("1.10.0", "1.9.9"))
        assertTrue(ReleaseRules.isNewer("v2.0.0", "1.99.99"))
        assertFalse(ReleaseRules.isNewer("1.1.2", "1.1.2"))
        assertFalse(ReleaseRules.isNewer("1.1.1", "1.1.2"))
        // A release is newer than its own pre-releases; pre-releases order by their numbers.
        assertTrue(ReleaseRules.isNewer("1.2.0", "1.2.0-test.3"))
        assertTrue(ReleaseRules.isNewer("1.2.0-test.10", "1.2.0-test.9"))
        assertFalse(ReleaseRules.isNewer("1.2.0-test.3", "1.2.0"))
        // Anything that is not a version is never newer.
        assertFalse(ReleaseRules.isNewer("latest", "1.1.2"))
        assertFalse(ReleaseRules.isNewer("1.1.3", "dev"))
        assertFalse(ReleaseRules.isNewer("1.1", "1.0.0"))
    }

    // --- the release and its APK ---------------------------------------------------------------

    @Test fun `the APK is picked by the release's own name for it`() {
        val r = ReleaseRules.read(latestJson())!!
        assertEquals("1.1.3", r.version)
        assertEquals("Core-Hub-1.1.3-android.apk", r.apkName)
        assertEquals("https://github.com/twuijri/core-hub/releases/download/v1.1.3/Core-Hub-1.1.3-android.apk", r.apkUrl)
        assertEquals(31457280L, r.size)
        assertEquals("ab".repeat(32), r.sha256)
        assertEquals("https://github.com/twuijri/core-hub/releases/tag/v1.1.3", r.pageUrl)
        // Without GitHub's digest the size is still checked.
        assertNull(ReleaseRules.read(latestJson(digest = null))!!.sha256)
    }

    @Test fun `the pattern is the one the release script and the download page use`() {
        val script = File(repoRoot, "apps/desktop/scripts/release-assets.mjs").readText()
        assertTrue("release-assets.mjs names the APK", script.contains("name: `Core-Hub-\${version}-android.apk`"))
        val site = File(repoRoot, "site/src/releases.js").readText()
        assertTrue("the download page picks the same name", site.contains("'android-apk': new RegExp(`^Core-Hub-\${V}-android\\\\.apk$`)"))
        assertTrue(ReleaseRules.APK_NAME.matches("Core-Hub-1.1.3-android.apk"))
        assertFalse(ReleaseRules.APK_NAME.matches("app-release.apk"))
        assertFalse(ReleaseRules.APK_NAME.matches("Core-Hub-1.1.3-android.apk.sig"))
    }

    @Test fun `pre-releases, drafts, strangers' links and garbage are never offered`() {
        assertNull(ReleaseRules.read(latestJson(prerelease = true)))
        assertNull(ReleaseRules.read(latestJson(draft = true)))
        assertNull(ReleaseRules.read(latestJson(tag = "v1.2.0-test.4")))
        assertNull(ReleaseRules.read(latestJson(tag = "nightly")))
        assertNull(ReleaseRules.read(latestJson(apkUrl = "https://evil.example/Core-Hub-1.1.3-android.apk")))
        assertNull(ReleaseRules.read(latestJson(apkUrl = "https://github.com/someone/else/releases/download/v1.1.3/Core-Hub-1.1.3-android.apk")))
        assertNull(ReleaseRules.read("""{"message":"API rate limit exceeded for 1.2.3.4."}"""))
        assertNull(ReleaseRules.read("<html>captive portal</html>"))
        assertNull(ReleaseRules.read(""))
        assertNull(ReleaseRules.read("""{"tag_name":"v1.1.3","assets":"nope"}"""))
    }

    @Test fun `sizes read in Latin digits`() {
        assertEquals("30 MB", ReleaseRules.formatSize(31457280))
        assertEquals("12.5 MB", ReleaseRules.formatSize(13107200))
        assertEquals("980 KB", ReleaseRules.formatSize(980 * 1024))
        assertEquals("", ReleaseRules.formatSize(0))
    }

    // --- the six hours ---------------------------------------------------------------------------

    private class CountingSource(var answer: Lookup) : ReleaseSource {
        var calls = 0
        override suspend fun latest(): Lookup { calls++; return answer }
    }

    @Test fun `on its own it asks at most every six hours, This device asks now`() = runTest {
        val hour = 60L * 60 * 1000
        var now = 1_000_000_000_000L
        val source = CountingSource(Lookup.Answer(release("1.1.3")))
        val checker = UpdateChecker(true, "1.1.2", MemoryUpdateStore(), source) { now }
        assertEquals(CheckResult.AVAILABLE, checker.checkIfDue())
        assertEquals(1, source.calls)
        now += 1 * hour
        assertEquals(CheckResult.NOT_DUE, checker.checkIfDue())
        now += 4 * hour + 59 * 60 * 1000
        assertEquals(CheckResult.NOT_DUE, checker.checkIfDue())
        assertEquals(1, source.calls)
        now += 60 * 1000
        assertEquals(CheckResult.AVAILABLE, checker.checkIfDue())
        assertEquals(2, source.calls)
        // The manual check ignores the six hours.
        assertEquals(CheckResult.AVAILABLE, checker.checkNow())
        assertEquals(3, source.calls)
        // A clock set back does not silence the check for hours.
        now -= 24 * hour
        assertEquals(CheckResult.AVAILABLE, checker.checkIfDue())
        assertEquals(4, source.calls)
    }

    @Test fun `rate-limited counts as a check, offline is asked again next time`() = runTest {
        var now = 5_000_000L
        val source = CountingSource(Lookup.Unreachable)
        val checker = UpdateChecker(true, "1.1.2", MemoryUpdateStore(), source) { now }
        assertEquals(CheckResult.UNREACHABLE, checker.checkIfDue())
        assertEquals(CheckResult.UNREACHABLE, checker.checkIfDue())
        assertEquals(2, source.calls)
        source.answer = Lookup.RateLimited
        assertEquals(CheckResult.RATE_LIMITED, checker.checkIfDue())
        now += 60 * 1000
        assertEquals(CheckResult.NOT_DUE, checker.checkIfDue())
        assertEquals(3, source.calls)
        assertNull(checker.available.value)
    }

    @Test fun `up to date forgets an older find, and a release no newer than the app is not offered`() = runTest {
        val store = MemoryUpdateStore()
        val source = CountingSource(Lookup.Answer(release("1.1.3")))
        val checker = UpdateChecker(true, "1.1.2", store, source)
        checker.checkNow()
        assertEquals("1.1.3", checker.available.value?.version)
        source.answer = Lookup.Answer(release("1.1.2"))
        assertEquals(CheckResult.UP_TO_DATE, checker.checkNow())
        assertNull(checker.available.value)
        assertNull(store.latest)
        // After the update installed, the find kept from before is older than the app: nothing.
        store.latest = release("1.1.3")
        assertNull(UpdateChecker(true, "1.1.3", store, source).available.value)
    }

    // --- Later -------------------------------------------------------------------------------------

    @Test fun `Later hides that version until a newer one, across launches`() = runTest {
        val prefs = MemoryPrefs()
        val source = CountingSource(Lookup.Answer(release("1.1.3")))
        val checker = UpdateChecker(true, "1.1.2", PrefsUpdateStore(prefs), source)
        checker.checkNow()
        assertEquals("1.1.3", ReleaseRules.notice(checker.available.value, checker.skipped.value)?.version)
        checker.later("1.1.3")
        assertNull(ReleaseRules.notice(checker.available.value, checker.skipped.value))
        // Still found (This device offers it), and still hidden after a restart, without asking GitHub.
        val again = UpdateChecker(true, "1.1.2", PrefsUpdateStore(prefs), source)
        assertEquals("1.1.3", again.available.value?.version)
        assertNull(ReleaseRules.notice(again.available.value, again.skipped.value))
        assertEquals(1, source.calls)
        // A newer release brings the notice back.
        source.answer = Lookup.Answer(release("1.1.4"))
        again.checkNow()
        assertEquals("1.1.4", ReleaseRules.notice(again.available.value, again.skipped.value)?.version)
    }

    // --- the Play switch -----------------------------------------------------------------------------

    @Test fun `with self-update off nothing asks and nothing is offered`() = runTest {
        val store = MemoryUpdateStore().apply { latest = release("9.9.9") }
        val source = CountingSource(Lookup.Answer(release("9.9.9")))
        val checker = UpdateChecker(false, "1.1.2", store, source)
        assertEquals(CheckResult.DISABLED, checker.checkIfDue())
        assertEquals(CheckResult.DISABLED, checker.checkNow())
        assertEquals(0, source.calls)
        assertNull(checker.available.value)
        assertEquals(0L, store.lastCheckAt)
    }

    // --- GitHub over HTTP ----------------------------------------------------------------------------

    private fun github() = GitHubReleases(OkHttpClient(), "1.1.2", api = server.url("/").toString().trimEnd('/'))

    @Test fun `GitHub's answers - a release, the rate limit, nothing yet, an error, garbage`() = runTest {
        server.enqueue(MockResponse().setBody(latestJson()))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"message":"API rate limit exceeded"}"""))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"message":"Not Found"}"""))
        server.enqueue(MockResponse().setResponseCode(502))
        server.enqueue(MockResponse().setBody("not json"))
        val source = github()
        assertEquals("1.1.3", (source.latest() as Lookup.Answer).release?.version)
        val request = server.takeRequest()
        assertEquals("/repos/twuijri/core-hub/releases/latest", request.path)
        assertNull(request.getHeader("Authorization"))
        assertEquals("CoreHub-Android/1.1.2", request.getHeader("User-Agent"))
        assertEquals(Lookup.RateLimited, source.latest())
        assertEquals(Lookup.Answer(null), source.latest())
        assertEquals(Lookup.Unreachable, source.latest())
        assertEquals(Lookup.Answer(null), source.latest())
        server.shutdown()
        assertEquals(Lookup.Unreachable, source.latest())
    }

    // --- the download ---------------------------------------------------------------------------------

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun served(version: String, size: Long, sha256: String?) =
        release(version, size, sha256).copy(apkUrl = server.url("/v$version/Core-Hub-$version-android.apk").toString())

    @Test fun `the download is kept only when its size and SHA-256 are the release's`() = runTest {
        val dir = File.createTempFile("updates", "").apply { delete(); mkdirs() }
        val bytes = ByteArray(200_000) { (it % 251).toByte() }
        val downloader = ApkDownloader(OkHttpClient())
        val good = served("1.1.3", bytes.size.toLong(), sha(bytes))

        server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
        val progress = mutableListOf<Long>()
        val apk = downloader.download(good, dir) { read, total -> assertEquals(bytes.size.toLong(), total); progress += read }
        assertEquals(bytes.size.toLong(), apk.length())
        assertEquals(bytes.size.toLong(), progress.last())
        assertNotNull(downloader.ready(good, dir))

        // A shorter file than the release says: nothing is kept.
        server.enqueue(MockResponse().setBody(Buffer().write(bytes.copyOf(1000))))
        try { downloader.download(good, dir) { _, _ -> }; fail("a short file was kept") } catch (e: BadDownload) { }
        assertNull(downloader.ready(good, dir))
        assertTrue(dir.listFiles()!!.isEmpty())

        // The right size but other bytes: the SHA-256 refuses it.
        server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(bytes.size))))
        try { downloader.download(good, dir) { _, _ -> }; fail("a wrong file was kept") } catch (e: BadDownload) { }
        assertTrue(dir.listFiles()!!.isEmpty())

        // A longer file stops at the release's size and is refused.
        server.enqueue(MockResponse().setBody(Buffer().write(bytes + bytes)))
        try { downloader.download(good, dir) { _, _ -> }; fail("a longer file was kept") } catch (e: BadDownload) { }
        assertTrue(dir.listFiles()!!.isEmpty())
        dir.deleteRecursively()
    }
}

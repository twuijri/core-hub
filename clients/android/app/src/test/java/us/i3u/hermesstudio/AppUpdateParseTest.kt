package us.i3u.hermesstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `GET /api/studio/app-updates/mobile`, read the way the app must read it.
 *
 * The route answers HTTP 200 for "nothing configured" as well as for a real
 * release, so the body — not the status — decides, and every branch of it has
 * to end somewhere the owner can be told about.
 */
class AppUpdateParseTest {

    private val installed = AppBuild.parse("1.0.2-test.22")

    private fun body(raw: String) = JSONObject(raw)

    @Test
    fun `a newer build comes back with everything needed to fetch it`() {
        val result = parseMobileUpdate(
            body(
                """
                {"available":true,"version":"1.0.2-test.23","buildNumber":23,
                 "notes":"أصلح الإشعارات","sizeBytes":18874368,
                 "publishedAt":"2026-09-19T08:00:00Z",
                 "downloadPath":"/api/studio/app-updates/mobile/download?platform=android&channel=test"}
                """.trimIndent(),
            ),
            installed,
        )

        val release = (result as UpdateCheckResult.Available).release
        assertEquals("1.0.2-test.23", release.versionName)
        assertEquals(23, release.build.buildNumber)
        assertEquals("أصلح الإشعارات", release.notes)
        assertEquals(18_874_368L, release.sizeBytes)
        assertEquals("2026-09-19T08:00:00Z", release.publishedAt)
        assertTrue(release.downloadPath.startsWith("/api/studio/app-updates/mobile/download"))
    }

    @Test
    fun `the same build the owner is running is not an update`() {
        val result = parseMobileUpdate(
            body("""{"available":true,"version":"1.0.2-test.22","buildNumber":22,"sizeBytes":1,"downloadPath":"/d"}"""),
            installed,
        )

        assertEquals(UpdateCheckResult.UpToDate, result)
    }

    @Test
    fun `an older build is never offered`() {
        val result = parseMobileUpdate(
            body("""{"available":true,"version":"1.0.2-test.9","buildNumber":9,"sizeBytes":1,"downloadPath":"/d"}"""),
            installed,
        )

        assertEquals(UpdateCheckResult.UpToDate, result)
    }

    @Test
    fun `the buildNumber field wins over a suffix that disagrees with it`() {
        val result = parseMobileUpdate(
            body("""{"available":true,"version":"1.0.2-test.4","buildNumber":40,"sizeBytes":1,"downloadPath":"/d"}"""),
            installed,
        )

        assertEquals(40, (result as UpdateCheckResult.Available).release.build.buildNumber)
    }

    @Test
    fun `a server the owner has not configured says so instead of failing`() {
        val result = parseMobileUpdate(body("""{"available":false,"reason":"not_configured"}"""), installed)

        assertEquals(UpdateCheckResult.Unavailable(UpdateProblem.NotConfigured), result)
    }

    @Test
    fun `available false with no reason is simply nothing new`() {
        assertEquals(UpdateCheckResult.UpToDate, parseMobileUpdate(body("""{"available":false}"""), installed))
        assertEquals(UpdateCheckResult.UpToDate, parseMobileUpdate(body("{}"), installed))
    }

    @Test
    fun `a reason the app does not know is reported with the server's own word`() {
        val result = parseMobileUpdate(body("""{"available":false,"reason":"channel_disabled"}"""), installed)

        assertEquals(UpdateCheckResult.Unavailable(UpdateProblem.ServerError, "channel_disabled"), result)
    }

    @Test
    fun `an offer with no version or no download path is a broken server, not an update`() {
        val noVersion = parseMobileUpdate(body("""{"available":true,"buildNumber":30,"downloadPath":"/d"}"""), installed)
        val noPath = parseMobileUpdate(body("""{"available":true,"version":"1.0.3-test.1"}"""), installed)

        assertEquals(UpdateCheckResult.Unavailable(UpdateProblem.Malformed), noVersion)
        assertEquals(UpdateCheckResult.Unavailable(UpdateProblem.Malformed), noPath)
    }

    @Test
    fun `a missing size still offers the build - the download verifies against the stream`() {
        val result = parseMobileUpdate(
            body("""{"available":true,"version":"1.0.3-test.1","buildNumber":31,"downloadPath":"/d"}"""),
            installed,
        )

        assertEquals(0L, (result as UpdateCheckResult.Available).release.sizeBytes)
    }

    // ── every failure has exactly one reason ─────────────────────────────

    @Test
    fun `transport, auth, not-configured and everything else are told apart`() {
        assertEquals(UpdateProblem.NoNetwork, updateProblemFor(null, null, transportFailure = true))
        assertEquals(UpdateProblem.Unauthorized, updateProblemFor(401, null, transportFailure = false))
        assertEquals(UpdateProblem.Unauthorized, updateProblemFor(403, null, transportFailure = false))
        assertEquals(UpdateProblem.NotConfigured, updateProblemFor(409, "updates_not_configured", transportFailure = false))
        assertEquals(UpdateProblem.NotConfigured, updateProblemFor(409, null, transportFailure = false))
        assertEquals(UpdateProblem.ServerError, updateProblemFor(500, null, transportFailure = false))
        assertEquals(UpdateProblem.ServerError, updateProblemFor(404, null, transportFailure = false))
    }

    @Test
    fun `a transport failure beats any status a stale response carried`() {
        assertEquals(UpdateProblem.NoNetwork, updateProblemFor(401, "updates_not_configured", transportFailure = true))
    }

    @Test
    fun `every problem maps to an outcome with a message in both languages`() {
        UpdateProblem.entries.forEach { problem ->
            val outcome = problem.outcome()
            assertTrue("$problem has no message", outcome.messageRes != 0)
        }
        // And nothing in the outcome list is unreachable or unnamed.
        UpdateOutcome.entries.forEach { outcome ->
            assertEquals(outcome, UpdateOutcome.named(outcome.name))
            assertTrue("${outcome.name} has no message", outcome.messageRes != 0)
        }
        assertEquals(UpdateOutcome.Never, UpdateOutcome.named("something-a-newer-build-wrote"))
    }
}

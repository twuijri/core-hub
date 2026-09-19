package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two rules on automatic checks, and the offsets of a resumed download.
 *
 * Both are invisible when they are wrong: a broken throttle just means a
 * request on every resume, and a wrong resume offset produces an APK that is
 * the right length and the wrong bytes.
 */
class AppUpdateThrottleTest {

    private val now = 1_790_000_000_000L
    private val hour = 60L * 60 * 1000

    @Test
    fun `the first check always runs`() {
        assertTrue(UpdateThrottle.shouldCheck(now, lastCheckAt = 0L, metered = false))
    }

    @Test
    fun `a resume minutes after the last check does not ask again`() {
        assertFalse(UpdateThrottle.shouldCheck(now, lastCheckAt = now - 5 * 60 * 1000, metered = false))
        assertFalse(UpdateThrottle.shouldCheck(now, lastCheckAt = now - 5 * hour, metered = false))
    }

    @Test
    fun `six hours later it does`() {
        assertTrue(UpdateThrottle.shouldCheck(now, lastCheckAt = now - UpdateThrottle.INTERVAL_MS, metered = false))
        assertTrue(UpdateThrottle.shouldCheck(now, lastCheckAt = now - 7 * hour, metered = false))
        assertEquals(6 * hour, UpdateThrottle.INTERVAL_MS)
    }

    @Test
    fun `nothing automatic happens on a metered connection`() {
        assertFalse(UpdateThrottle.shouldCheck(now, lastCheckAt = 0L, metered = true))
        assertFalse(UpdateThrottle.shouldCheck(now, lastCheckAt = now - 30 * hour, metered = true))
    }

    @Test
    fun `the owner asking overrides both the interval and the metered rule`() {
        assertTrue(UpdateThrottle.shouldCheck(now, lastCheckAt = now, metered = true, manual = true))
        assertTrue(UpdateThrottle.shouldCheck(now, lastCheckAt = now - 1, metered = false, manual = true))
    }

    @Test
    fun `allowing metered data brings the interval back as the only rule`() {
        assertTrue(UpdateThrottle.shouldCheck(now, lastCheckAt = 0L, metered = true, allowMetered = true))
        assertFalse(UpdateThrottle.shouldCheck(now, lastCheckAt = now - hour, metered = true, allowMetered = true))
    }

    @Test
    fun `a clock that moved backwards does not lock updates out`() {
        // A restored backup, or a phone whose date was corrected: a stamp in
        // the future would otherwise block every check until it came round.
        assertTrue(UpdateThrottle.shouldCheck(now, lastCheckAt = now + 30 * hour, metered = false))
    }

    // ── resume offsets ───────────────────────────────────────────────────

    @Test
    fun `a fresh download starts at zero and sends no Range header`() {
        assertEquals(0L, UpdateDownload.startOffset(existingBytes = 0L, expectedTotal = 1_000L))
        assertNull(UpdateDownload.rangeHeader(0L))
    }

    @Test
    fun `a partial file resumes from exactly where it stopped`() {
        assertEquals(400L, UpdateDownload.startOffset(existingBytes = 400L, expectedTotal = 1_000L))
        assertEquals("bytes=400-", UpdateDownload.rangeHeader(400L))
    }

    @Test
    fun `a cached file longer than the release is a leftover and is thrown away`() {
        assertEquals(0L, UpdateDownload.startOffset(existingBytes = 1_200L, expectedTotal = 1_000L))
    }

    @Test
    fun `a file already the full length is complete and asks for nothing`() {
        assertEquals(1_000L, UpdateDownload.startOffset(existingBytes = 1_000L, expectedTotal = 1_000L))
        assertTrue(UpdateDownload.isComplete(1_000L, 1_000L))
        assertFalse(UpdateDownload.isComplete(999L, 1_000L))
        // Without a known total nothing can be called complete.
        assertFalse(UpdateDownload.isComplete(1_000L, 0L))
    }

    @Test
    fun `206 continues at the offset asked for, and 200 overwrites from the top`() {
        assertEquals(400L, UpdateDownload.writeOffset(responseCode = 206, requestedOffset = 400L))
        // A server that ignored the Range header sent the whole file again;
        // appending it would produce a longer, corrupt APK.
        assertEquals(0L, UpdateDownload.writeOffset(responseCode = 200, requestedOffset = 400L))
    }

    @Test
    fun `the expected total prefers the declared size and falls back to the body`() {
        assertEquals(
            1_000L,
            UpdateDownload.expectedTotal(declaredSize = 1_000L, responseCode = 206, bodyLength = 600L, requestedOffset = 400L),
        )
        assertEquals(
            1_000L,
            UpdateDownload.expectedTotal(declaredSize = 0L, responseCode = 206, bodyLength = 600L, requestedOffset = 400L),
        )
        assertEquals(
            600L,
            UpdateDownload.expectedTotal(declaredSize = 0L, responseCode = 200, bodyLength = 600L, requestedOffset = 400L),
        )
        assertEquals(
            0L,
            UpdateDownload.expectedTotal(declaredSize = 0L, responseCode = 200, bodyLength = -1L, requestedOffset = 0L),
        )
    }

    @Test
    fun `progress stays inside nought to a hundred whatever it is given`() {
        assertEquals(0, UpdateDownload.percent(0L, 1_000L))
        assertEquals(40, UpdateDownload.percent(400L, 1_000L))
        assertEquals(100, UpdateDownload.percent(1_000L, 1_000L))
        assertEquals(0, UpdateDownload.percent(500L, 0L))
        assertEquals(0, UpdateDownload.percent(-5L, 1_000L))
        assertEquals(100, UpdateDownload.percent(2_000L, 1_000L))
    }

    @Test
    fun `the notice only shows for an offer the owner has not waved away`() {
        val release = MobileRelease(
            versionName = "1.0.2-test.23",
            build = AppBuild.parse("1.0.2-test.23"),
            notes = "",
            sizeBytes = 10L,
            publishedAt = "",
            downloadPath = "/d",
        )

        assertFalse(UpdateUiState().showNotice)
        assertTrue(UpdateUiState(release = release).showNotice)
        assertFalse(UpdateUiState(release = release, dismissed = true).showNotice)
        assertEquals(50, UpdateUiState(downloadedBytes = 5L, totalBytes = 10L).percent)
    }
}

package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which of two builds is newer.
 *
 * The bug this exists to prevent is the obvious one: CI names test builds
 * `1.0.2-test.<run>`, and comparing those as strings puts `1.0.2-test.9` after
 * `1.0.2-test.22`, so the app would offer the owner a downgrade and then keep
 * offering it forever.
 */
class AppUpdateVersionTest {

    @Test
    fun `a build name splits into release, channel and a numeric build`() {
        val build = AppBuild.parse("1.0.2-test.22")

        assertEquals("1.0.2", build.version)
        assertEquals("test", build.channel)
        assertEquals(22, build.buildNumber)
        assertEquals("1.0.2-test.22", build.name)
    }

    @Test
    fun `build numbers are compared as numbers, not as text`() {
        val nine = AppBuild.parse("1.0.2-test.9")
        val twentyTwo = AppBuild.parse("1.0.2-test.22")

        assertTrue("22 is newer than 9", twentyTwo.isNewerThan(nine))
        assertFalse("9 is not newer than 22", nine.isNewerThan(twentyTwo))
        // The string comparison this replaces gets it exactly backwards.
        assertTrue("1.0.2-test.9" > "1.0.2-test.22")
    }

    @Test
    fun `an identical build is never newer`() {
        val installed = AppBuild.parse("1.0.2-test.22")

        assertFalse(AppBuild.parse("1.0.2-test.22").isNewerThan(installed))
    }

    @Test
    fun `a higher release wins even with a lower build number`() {
        val installed = AppBuild.parse("1.0.2-test.90")

        assertTrue(AppBuild.parse("1.0.3-test.1").isNewerThan(installed))
        assertFalse(AppBuild.parse("1.0.1-test.900").isNewerThan(installed))
    }

    @Test
    fun `releases compare segment by segment, with a missing segment as zero`() {
        assertEquals(0, compareVersions("1.2", "1.2.0"))
        assertTrue(compareVersions("1.10.0", "1.9.9") > 0)
        assertTrue(compareVersions("2.0.0", "10.0.0") < 0)
        // A segment that is not a number must not throw; it counts as zero.
        assertEquals(0, compareVersions("1.x.0", "1.0.0"))
    }

    @Test
    fun `a name with no suffix falls back to the build number it was given`() {
        val local = AppBuild.parse("1.4.0", fallbackBuildNumber = 34)

        assertEquals("1.4.0", local.version)
        assertEquals(34, local.buildNumber)
        assertEquals(UPDATE_DEFAULT_CHANNEL, local.channel)
    }

    @Test
    fun `a channel with no run number still names its channel`() {
        val build = AppBuild.parse("1.0.2-test", fallbackBuildNumber = 7)

        assertEquals("test", build.channel)
        assertEquals(7, build.buildNumber)
    }

    @Test
    fun `this install describes itself from BuildConfig`() {
        val installed = AppBuild.installed()

        assertEquals(AppBuild.parse(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE), installed)
        assertTrue("the installed build must have an order", installed.buildNumber > 0)
    }
}

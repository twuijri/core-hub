package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mic long-press is invisible, so it has to be mentioned — and mentioning
 * it every single time is how a hint becomes something people stop reading.
 *
 * The owner asked for the first few recordings, then roughly every fifth to
 * tenth, and nothing at all once he has used the gesture. That is arithmetic,
 * so it is checked here rather than by recording fifty voice notes.
 */
class DictationHintTest {

    private fun shown(upTo: Int, longPressUsed: Boolean = false): List<Int> =
        (1..upTo).filter { DictationHint.showsOn(it, longPressUsed) }

    @Test
    fun `the opening recordings all get the hint`() {
        assertEquals(listOf(1, 2, 3), shown(DictationHint.FIRST_RUN))
        assertTrue(DictationHint.showsOn(1, longPressUsed = false))
    }

    @Test
    fun `after that it is occasional, never every time`() {
        val hits = shown(60)
        assertEquals("the first few, then rarely", listOf(1, 2, 3, 8, 16, 22, 32, 39, 48, 53), hits)
        // Eight reminders across fifty-seven later recordings is a reminder,
        // not a nag.
        assertTrue(hits.size < 12)
    }

    @Test
    fun `the gaps after the opening run stay inside the fifth-to-tenth band`() {
        val gaps = shown(200).drop(DictationHint.FIRST_RUN - 1).zipWithNext { a, b -> b - a }
        assertTrue("gaps were $gaps", gaps.all { it in 5..10 })
        // Not a metronome either: the owner asked for "roughly", and the same
        // gap repeated forever reads as a scheduled interruption.
        assertTrue("gaps were $gaps", gaps.distinct().size > 1)
    }

    @Test
    fun `using the gesture ends the hint for good`() {
        assertEquals(emptyList<Int>(), shown(200, longPressUsed = true))
        assertFalse(DictationHint.showsOn(1, longPressUsed = true))
    }

    @Test
    fun `a counter that never advanced shows nothing`() {
        assertFalse(DictationHint.showsOn(0, longPressUsed = false))
        assertFalse(DictationHint.showsOn(-1, longPressUsed = false))
    }

    @Test
    fun `the hint goes away on its own, and quickly`() {
        // Light means transient: it must not sit on the composer waiting to be
        // dismissed like a dialog would.
        assertTrue(DictationHint.VISIBLE_MILLIS in 2_000..8_000)
    }
}

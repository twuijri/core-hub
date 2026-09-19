package us.i3u.hermesstudio

/**
 * When to mention that a long press on the microphone changes the dictation
 * language.
 *
 * The gesture is invisible, so it has to be said at least once; said every
 * time it becomes noise, and noise is what people learn to look past. So: the
 * first few recordings, then rarely, then never again once the owner has
 * actually used it.
 *
 * "Rarely" is a repeating stride rather than one fixed number — every fifth to
 * tenth recording, never the same gap twice in a row — so it reads as an
 * occasional reminder instead of a metronome. The whole rule is arithmetic on
 * a counter, which is why it can be read in a test rather than by recording
 * fifty voice notes.
 */
object DictationHint {

    /** The opening recordings, where the gesture is genuinely news. */
    const val FIRST_RUN = 3

    /** The gaps after that, in order, repeating. Every one inside 5…10. */
    private val STRIDES = intArrayOf(5, 8, 6, 10, 7, 9)

    /** How long the hint stays on screen before it fades on its own. */
    const val VISIBLE_MILLIS = 5_000L

    /**
     * Whether the hint belongs on the [count]-th recording of this profile,
     * counting from 1.
     *
     * [longPressUsed] ends it for good: the owner knows the gesture, and a
     * reminder about something already learned is just clutter.
     */
    fun showsOn(count: Int, longPressUsed: Boolean): Boolean {
        if (longPressUsed || count <= 0) return false
        if (count <= FIRST_RUN) return true
        var at = FIRST_RUN
        var stride = 0
        while (at < count) {
            at += STRIDES[stride % STRIDES.size]
            stride++
        }
        return at == count
    }
}

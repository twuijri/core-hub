package us.i3u.hermesstudio

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The reported failure: the recording strip read "Listening in English (Saudi
 * Arabia)" while Arabic was being spoken, and the transcript came back in
 * Latin letters looking like a success.
 *
 * Two things were wrong underneath, and both are the kind that come back:
 *
 *  - the engine was never asked whether it could detect. `checkRecognitionSupport`
 *    was called with a plain recognition intent, so "the engine confirmed
 *    detection" only ever meant "the engine confirmed it can hear speech";
 *  - nothing on screen distinguished a take that was detecting from a take
 *    that had quietly fallen back to the app's locale.
 *
 * The behaviour lives in [SpeechLanguages] and is tested there. What is
 * guarded here is the wiring, because neither of these can be caught by a
 * pure test and neither shows up in a screenshot.
 */
class DictationReportingTest {

    private fun source(name: String) = File("src/main/java/us/i3u/hermesstudio/$name").readText()

    private val speechInput = source("SpeechInput.kt")
    private val composer = source("ui/chat/Composer.kt")
    private val viewModel = source("AppViewModel.kt")

    @Test
    fun `the support query asks the engine about detection, not only about speech`() {
        assertTrue(
            "querySupport must build its probe intent with the detection languages",
            speechInput.contains("recognitionIntent(context, Locale.getDefault().toLanguageTag(), detectAmong)"),
        )
        assertTrue(
            "and the answer must be recorded, not assumed",
            speechInput.contains("detectionAccepted = true"),
        )
    }

    @Test
    fun `what the query found decides what may be claimed`() {
        // Every field of DetectionSupport comes from the device: the API level
        // it reports, whether its engine answered, whether its engine took an
        // intent that asked to detect, and which models it listed.
        listOf("checked = true", "sdkInt = android.os.Build.VERSION.SDK_INT", "engineAnswered = reported.answered", "detectionAccepted = reported.detectionAccepted")
            .forEach { assertTrue("loadSpeechLanguages must record $it", viewModel.contains(it)) }
    }

    @Test
    fun `the recording strip reports the detection state, and the reason when it is off`() {
        assertTrue(
            "the strip must branch on the concrete reason detection is not running",
            composer.contains("state.takeDetectionBlock != DetectionBlock.None"),
        )
        assertTrue(
            "and a detecting take must name the languages the engine was handed",
            composer.contains("composer_take_detecting_among"),
        )
        assertTrue(
            "and a take moved off an unsupported locale must say which it left",
            composer.contains("state.takeFallbackFrom.isNotBlank()"),
        )
    }

    @Test
    fun `a finished take that ran in the wrong language says so, and keeps saying it`() {
        // A transient notice disappears; the text it produced does not. The
        // warning sits above the composer until the owner dismisses it or
        // starts another take.
        assertTrue("the composer must render dictationWarning", composer.contains("state.dictationWarning?.let"))
        assertTrue(
            "a detecting take that never named a language is not a successful one",
            viewModel.contains("notice_speech_detect_silent"),
        )
    }

    @Test
    fun `the long-press hint is counted, shown and retired`() {
        assertTrue("the counter advances on every take", viewModel.contains("noteDictationStarted()"))
        assertTrue("the cadence is DictationHint's, not the composer's", viewModel.contains("DictationHint.showsOn("))
        assertTrue("using the gesture retires the hint", composer.contains("viewModel.noteDictationLongPress()"))
        assertTrue("and it fades on its own", composer.contains("delay(DictationHint.VISIBLE_MILLIS)"))
    }

    @Test
    fun `every sentence the strip and the sheet can show exists in both languages`() {
        val keys = listOf(
            "speech_detect_on", "speech_detect_off_pending", "speech_detect_off_platform",
            "speech_detect_off_unknown", "speech_detect_off_engine", "speech_detect_off_models",
            "notice_speech_detect_off", "notice_speech_detect_silent", "notice_speech_language_fallback",
            "composer_take_detect_off", "composer_take_detecting_among", "composer_take_fallback",
            "composer_dictation_hint",
        )
        listOf("values", "values-ar").forEach { dir ->
            val strings = File("src/main/res/$dir/strings.xml").readText()
            keys.forEach { key ->
                assertTrue("$dir/strings.xml is missing $key", strings.contains("name=\"$key\""))
            }
        }
    }
}

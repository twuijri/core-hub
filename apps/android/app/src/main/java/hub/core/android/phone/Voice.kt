package hub.core.android.phone

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import hub.core.android.R
import hub.core.android.graph
import hub.core.android.markdown.Markdown
import hub.core.android.markdown.MdColors
import hub.core.android.ui.components.ContentDirection
import hub.core.android.ui.components.Glyphs
import hub.core.android.ui.theme.LocalTokens
import androidx.compose.ui.unit.LayoutDirection

/** The recognizer intent for one utterance in [languageTag], through the phone's own speech service. */
fun dictationIntent(languageTag: String, prompt: String): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, languageTag)
        .putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

/**
 * The composer's microphone: one utterance with the phone's own recognizer, its text added to
 * the draft. Absent when This device turns voice input off or the phone has no recognizer.
 */
@Composable
fun VoiceButton(onText: (String) -> Unit) {
    val context = LocalContext.current
    val graph = context.graph
    val choices by graph.device.choices.collectAsState()
    val available = remember { SpeechRecognizer.isRecognitionAvailable(context) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let(onText)
    }
    if (!choices.voiceInput || !available) return
    val prompt = stringResource(R.string.voice_prompt)
    IconButton(onClick = {
        try {
            launcher.launch(dictationIntent(DictationLanguage.tag(choices.dictation, graph.prefs.effectiveLanguage), prompt))
        } catch (_: ActivityNotFoundException) {
            // No activity answers the recognizer intent on this phone.
        }
    }) {
        Icon(Glyphs.Mic, stringResource(R.string.voice_input), tint = LocalTokens.current.textMuted)
    }
}

/** Reads finished replies aloud (This device → spoken replies), with the phone's own voice. */
class Speaker(private val context: Context) {
    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: Pair<String, Boolean>? = null

    fun speak(markdown: String) {
        val text = Markdown.plain(Markdown.parse(markdown, MdColors(androidx.compose.ui.graphics.Color.Black, androidx.compose.ui.graphics.Color.Black, androidx.compose.ui.graphics.Color.Black))).trim()
        if (text.isEmpty()) return
        val rtl = ContentDirection.of(text) == LayoutDirection.Rtl
        if (tts == null) tts = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            pending?.let { (t, r) -> say(t, r) }
            pending = null
        }
        if (ready) say(text, rtl) else pending = text to rtl
    }

    private fun say(text: String, rtl: Boolean) {
        val engine = tts ?: return
        engine.language = DictationLanguage.speechLocale(rtl)
        engine.speak(text.take(TextToSpeech.getMaxSpeechInputLength()), TextToSpeech.QUEUE_FLUSH, null, "reply")
    }

    fun stop() {
        tts?.stop()
    }
}

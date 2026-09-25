package hub.core.android.phone

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.markdown.Markdown
import hub.core.android.markdown.MdColors
import hub.core.android.ui.components.ContentDirection
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.SpeechRequest
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

/** The recognizer intent for one utterance in [languageTag], through the phone's own speech service. */
fun dictationIntent(languageTag: String, prompt: String): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, languageTag)
        .putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

/**
 * The composer's microphone. With «Voice: Core Hub» and a speech-to-text provider on the hub for
 * this [profile], a tap records and a second tap sends the take to the hub (`models.transcribe`);
 * otherwise one utterance goes through the phone's own recognizer. Its text is added to the draft.
 * Absent when This device turns voice input off, or when neither the hub nor the phone can listen.
 */
@Composable
fun VoiceButton(profile: String, onText: (String) -> Unit) {
    val context = LocalContext.current
    val graph = context.graph
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val choices by graph.device.choices.collectAsState()
    val available = remember { SpeechRecognizer.isRecognitionAvailable(context) }
    var recording by remember { mutableStateOf<Recording?>(null) }
    var transcribing by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let(onText)
    }
    val prompt = stringResource(R.string.voice_prompt)
    val noSpeech = stringResource(R.string.voice_no_speech)
    val micDenied = stringResource(R.string.voice_mic_denied)
    DisposableEffect(Unit) { onDispose { recording?.discard() } }

    fun onPhone() {
        if (!available) return
        try {
            launcher.launch(dictationIntent(DictationLanguage.tag(choices.dictation, graph.prefs.effectiveLanguage), prompt))
        } catch (_: ActivityNotFoundException) {
            // No activity answers the recognizer intent on this phone.
        }
    }

    fun record() {
        recording = runCatching { Recording(context) }.getOrNull()
        if (recording == null) onPhone()
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) record() else Toast.makeText(context, micDenied, Toast.LENGTH_LONG).show()
    }

    fun finish(take: Recording) {
        recording = null
        val durationMs = take.finish()
        val session = graph.store.current ?: return
        val language = DictationLanguage.tag(choices.dictation, graph.prefs.effectiveLanguage).substringBefore('-')
        transcribing = true
        scope.launch {
            hubCall { graph.apis(session).models.modelsTranscribe(profile, take.file, language, durationMs = durationMs) }
                .onSuccess { it.text.takeIf(String::isNotBlank)?.let(onText) }
                .onFailure { e ->
                    val error = e as HubError
                    val text = if (error.status == 400 && error.reason == "no_speech") noSpeech else error.text ?: error.code ?: e.toString()
                    Toast.makeText(context, text, Toast.LENGTH_LONG).show()
                }
            take.file.delete()
            transcribing = false
        }
    }

    if (!choices.voiceInput || (!available && choices.voiceSource != VoiceSource.HUB)) return
    IconButton(
        enabled = !transcribing,
        onClick = {
            recording?.let { finish(it); return@IconButton }
            val session = graph.store.current
            if (choices.voiceSource == VoiceSource.PHONE || session == null) {
                onPhone()
                return@IconButton
            }
            scope.launch {
                val ready = HubSpeech.ready(graph.apis(session), session.hub, profile)
                if (VoiceRoute.choose(choices.voiceSource, ready?.stt) == VoiceRoute.HUB) {
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) record()
                    else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                } else {
                    onPhone()
                }
            }
        },
    ) {
        when {
            transcribing -> {
                val busy = stringResource(R.string.voice_transcribing)
                CircularProgressIndicator(Modifier.size(20.dp).semantics { contentDescription = busy }, strokeWidth = 2.dp)
            }
            else -> Icon(
                painterResource(R.drawable.lucide_mic),
                stringResource(
                    if (recording != null) R.string.voice_recording else R.string.voice_input,
                ),
                tint = if (recording != null) t.danger else t.textMuted,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

/** What a hub may speak for a reply: the signed-in hub's API, the chat's profile, the person's choice. */
data class HubVoice(val api: HubApis, val hub: String, val profile: String, val source: VoiceSource)

/**
 * Reads finished replies aloud (This device → spoken replies): with the hub's voice when it has
 * one for the profile (and the person chose Core Hub), else the phone's own.
 */
class Speaker(private val context: Context) {
    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: Pair<String, Boolean>? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var playing: Job? = null
    private var player: MediaPlayer? = null

    fun speak(markdown: String, hub: HubVoice? = null) {
        val text = Markdown.plain(Markdown.parse(markdown, MdColors(androidx.compose.ui.graphics.Color.Black, androidx.compose.ui.graphics.Color.Black, androidx.compose.ui.graphics.Color.Black))).trim()
        if (text.isEmpty()) return
        stop()
        val rtl = ContentDirection.of(text) == LayoutDirection.Rtl
        if (hub == null || hub.source != VoiceSource.HUB) return onPhone(text, rtl)
        playing = scope.launch {
            val speech = HubSpeech.ready(hub.api, hub.hub, hub.profile)
            if (VoiceRoute.choose(hub.source, speech?.tts) != VoiceRoute.HUB) return@launch onPhone(text, rtl)
            // The hub takes up to 2 000 characters a request: longer replies go in parts.
            VoiceText.chunks(text).forEachIndexed { index, part ->
                val file = hubCall {
                    hub.api.models.modelsSynthesize(hub.profile, SpeechRequest(text = part, language = if (rtl) "ar" else "en"))
                }.getOrNull()
                if (file == null) {
                    // The hub could not speak this time: the phone reads it instead.
                    if (index == 0) onPhone(text, rtl)
                    return@launch
                }
                play(file)
                file.delete()
            }
        }
    }

    /** Plays one part to its end (or until [stop]). */
    private suspend fun play(file: java.io.File) = suspendCancellableCoroutine { cont ->
        val media = runCatching {
            MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener { if (cont.isActive) cont.resume(Unit) }
                setOnErrorListener { _, _, _ -> if (cont.isActive) cont.resume(Unit); true }
                prepare()
                start()
            }
        }.getOrElse {
            cont.resume(Unit)
            return@suspendCancellableCoroutine
        }
        player = media
        cont.invokeOnCancellation { runCatching { media.stop() } }
    }

    private fun onPhone(text: String, rtl: Boolean) {
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
        playing?.cancel()
        playing = null
        player?.let { runCatching { it.stop() }; it.release() }
        player = null
        tts?.stop()
    }
}

package hub.core.android.phone

import hub.core.android.generated.ControlTokens
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.MenuDivider
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.MenuLabel
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.kit.floatingChrome
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.layout.Row
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.LocaleList
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.InputMethodSubtype
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.ui.theme.LocalTokens
import java.io.File
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/*
 * Dictation into the composer (owner, 2026-09-27): the words appear in the composer while they are
 * spoken, a strip over it shows the microphone's level with cancel, stop and send, and the phone
 * keeps listening through short pauses until the person stops — the recognizer is started again
 * after each stretch it ends, without the system's dialog. With «Voice: Core Hub» and a
 * speech-to-text provider for the profile, the take is recorded and the hub transcribes it.
 */

/** The rules of a take, apart from Android, so they are tested. */
object Dictations {
    /** How many bars the strip's waveform draws. */
    const val LEVELS = 28

    /** Two stretches of words as one text. */
    fun join(first: String, second: String): String {
        val a = first.trim()
        val b = second.trim()
        return when {
            a.isEmpty() -> b
            b.isEmpty() -> a
            else -> "$a $b"
        }
    }

    /** Decibels (full scale, ≤ 0) as a bar height, 0…1. */
    fun level(decibels: Float): Float = if (decibels.isNaN()) 0f else ((decibels + 50f) / 45f).coerceIn(0f, 1f)

    /** The recognizer's `onRmsChanged` (about −2…10 dB) as a bar height, 0…1. */
    fun levelOfRms(rmsdB: Float): Float = if (rmsdB.isNaN()) 0f else ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)

    /** The language to send the hub with a recording: none with Auto, so its model detects it. */
    fun hubLanguage(choice: String): String? = if (choice == DictationLanguage.AUTO) null else DictationLanguage.base(choice)
}

/** The phone's languages, in the person's order. */
object PhoneLanguages {
    fun list(): List<String> {
        val locales = LocaleList.getDefault()
        return (0 until locales.size()).map { locales[it].toLanguageTag() }
    }
}

/** The keyboard the person types with, as the input method reports it. */
object Keyboards {
    private fun imm(context: Context) = context.getSystemService(InputMethodManager::class.java)

    @Suppress("DEPRECATION")
    private fun languageOf(subtype: InputMethodSubtype): String? =
        DictationLanguage.tag(subtype.languageTag.ifEmpty { subtype.locale })

    /** The current keyboard's language; null when the input method does not say. */
    fun current(context: Context): String? =
        runCatching { imm(context)?.currentInputMethodSubtype?.let(::languageOf) }.getOrNull()

    /** The languages of every keyboard the person has turned on. */
    fun enabled(context: Context): List<String> = runCatching {
        val manager = imm(context) ?: return emptyList()
        manager.enabledInputMethodList
            .flatMap { manager.getEnabledInputMethodSubtypeList(it, true) }
            .filter { it.mode.isNullOrEmpty() || it.mode == "keyboard" }
            .mapNotNull(::languageOf)
            .distinctBy { it.lowercase() }
    }.getOrDefault(emptyList())
}

/** What the composer's microphone is doing. */
enum class DictationPhase { IDLE, LISTENING, TRANSCRIBING }

/**
 * One composer's dictation. The words go into the draft as they come ([onDraft], after what was
 * typed before), and Send while dictating sends once the last words are in.
 */
@Stable
class DictationUi internal constructor(private val context: Context, private val scope: CoroutineScope) {
    var phase by mutableStateOf(DictationPhase.IDLE)
        private set
    var levels by mutableStateOf(List(Dictations.LEVELS) { 0f })
        private set
    /** The language the phone listens in during this take; null while the hub listens. */
    var listeningIn by mutableStateOf<String?>(null)
        private set

    internal var onDraft: (String) -> Unit = {}
    internal var onSend: () -> Unit = {}
    internal var toggle: () -> Unit = {}

    private var base = ""
    private var committed = ""
    private var partial = ""
    private var sendWhenHeard = false

    private var recognizer: SpeechRecognizer? = null
    private var intent: Intent? = null
    private var stretchStartedAt = 0L
    private var quickFailures = 0
    private var unavailable = ""
    private var denied = ""
    private val handler = Handler(Looper.getMainLooper())

    private var recording: Recording? = null
    private var meter: Job? = null

    val active: Boolean get() = phase != DictationPhase.IDLE

    internal fun begin(draft: String) {
        base = draft
        committed = ""
        partial = ""
        sendWhenHeard = false
        levels = List(Dictations.LEVELS) { 0f }
    }

    private fun show() = onDraft(Dictations.join(base, Dictations.join(committed, partial)))

    private fun push(level: Float) {
        levels = levels.drop(1) + level
    }

    /** Listens with the phone's recognizer in [language], through pauses, until [stop]. */
    internal fun listenOnPhone(language: String, allowed: List<String>, auto: Boolean, unavailable: String, denied: String) {
        this.unavailable = unavailable
        this.denied = denied
        if (!SpeechRecognizer.isRecognitionAvailable(context)) return fail(unavailable)
        listeningIn = language
        intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Longer pauses before a stretch ends, where the recognizer honours it.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
            if (auto) detectLanguages(this, allowed)
        }
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply { setRecognitionListener(listener) }
        quickFailures = 0
        phase = DictationPhase.LISTENING
        listen()
    }

    /** Auto on Android 13+: the recognizer may detect, and on 14+ switch to, any of the person's languages. */
    private fun detectLanguages(intent: Intent, allowed: List<String>) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_DETECTION, true)
            intent.putStringArrayListExtra(RecognizerIntent.EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES, ArrayList(allowed))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            intent.putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_SWITCH, RecognizerIntent.LANGUAGE_SWITCH_BALANCED)
            intent.putStringArrayListExtra(RecognizerIntent.EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES, ArrayList(allowed))
        }
    }

    private fun listen() {
        stretchStartedAt = SystemClock.elapsedRealtime()
        runCatching { recognizer?.startListening(intent) }.onFailure { fail(unavailable) }
    }

    /** The stretch ended (a pause, a time limit): the take goes on until the person stops. */
    private fun next(after: Long = 0) {
        handler.postDelayed({ if (phase == DictationPhase.LISTENING && recognizer != null) listen() }, after)
    }

    private fun commit() {
        if (partial.isBlank()) return
        committed = Dictations.join(committed, partial)
        partial = ""
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {
            if (phase == DictationPhase.LISTENING) push(Dictations.levelOfRms(rmsdB))
        }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            if (phase != DictationPhase.LISTENING) return
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            partial = text
            if (text.isNotBlank()) quickFailures = 0
            show()
        }

        override fun onResults(results: Bundle?) {
            if (phase != DictationPhase.LISTENING) return
            results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { partial = it }
            commit()
            show()
            next()
        }

        override fun onError(error: Int) {
            if (phase != DictationPhase.LISTENING || recognizer == null) return
            commit()
            when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> return fail(denied)
                // ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE (Android 12).
                12, 13 -> return fail(unavailable)
            }
            if (SystemClock.elapsedRealtime() - stretchStartedAt < 1000 && partial.isBlank()) quickFailures++
            if (quickFailures >= 3) return fail(unavailable)
            if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || error == SpeechRecognizer.ERROR_CLIENT) {
                recognizer?.cancel()
                next(after = 250)
            } else {
                next()
            }
        }
    }

    /** Records a take for the hub; [stop] sends it, [cancel] drops it. */
    internal fun recordForHub(transcribe: suspend (File, Int) -> Result<String>, unavailable: String): Boolean {
        val take = runCatching { Recording(context) }.getOrNull() ?: return false
        this.unavailable = unavailable
        recording = take
        listeningIn = null
        phase = DictationPhase.LISTENING
        hubTranscribe = transcribe
        meter = scope.launch {
            while (isActive) {
                push(take.level())
                delay(80)
            }
        }
        return true
    }

    private var hubTranscribe: (suspend (File, Int) -> Result<String>)? = null

    /** Ends the take and keeps its words. */
    fun stop() {
        recording?.let { take ->
            recording = null
            meter?.cancel()
            val durationMs = take.finish()
            val transcribe = hubTranscribe ?: return finished()
            phase = DictationPhase.TRANSCRIBING
            levels = List(Dictations.LEVELS) { 0f }
            scope.launch {
                transcribe(take.file, durationMs)
                    .onSuccess { committed = it; partial = ""; show() }
                    .onFailure { Toast.makeText(context, it.message ?: unavailable, Toast.LENGTH_LONG).show(); sendWhenHeard = false }
                take.file.delete()
                finished()
            }
            return
        }
        if (phase != DictationPhase.LISTENING) return
        commit()
        teardown()
        show()
        finished()
    }

    /** Ends the take and drops it: the draft is what was typed before. */
    fun cancel() {
        sendWhenHeard = false
        recording?.let { take ->
            recording = null
            meter?.cancel()
            take.discard()
        }
        teardown()
        committed = ""
        partial = ""
        onDraft(base)
        phase = DictationPhase.IDLE
    }

    /** Send: at once when not dictating; once the last words are in while dictating. */
    fun send() {
        if (phase == DictationPhase.IDLE) return onSend()
        sendWhenHeard = true
        if (phase == DictationPhase.LISTENING) stop()
    }

    private fun finished() {
        phase = DictationPhase.IDLE
        levels = List(Dictations.LEVELS) { 0f }
        if (sendWhenHeard) {
            sendWhenHeard = false
            onSend()
        }
    }

    private fun fail(message: String) {
        teardown()
        phase = DictationPhase.IDLE
        sendWhenHeard = false
        Toast.makeText(context, message, Toast.LENGTH_LONG).show()
    }

    private fun teardown() {
        handler.removeCallbacksAndMessages(null)
        recognizer?.let { runCatching { it.cancel() }; runCatching { it.destroy() } }
        recognizer = null
        levels = List(Dictations.LEVELS) { 0f }
    }

    internal fun dispose() {
        recording?.discard()
        recording = null
        meter?.cancel()
        teardown()
    }
}

/**
 * The composer's dictation for the chat in [profile]. [recent] is the conversation's latest words:
 * with Auto and no keyboard to go by, the phone listens in the language they are written in.
 */
@Composable
fun rememberDictation(
    profile: String,
    recent: List<String>,
    draft: () -> String,
    onDraft: (String) -> Unit,
    onSend: () -> Unit,
): DictationUi {
    val context = LocalContext.current
    val graph = context.graph
    val scope = rememberCoroutineScope()
    val dictation = remember { DictationUi(context, scope) }
    val choices by graph.device.choices.collectAsState()
    val latestRecent by rememberUpdatedState(recent)
    val latestDraft by rememberUpdatedState(draft)
    val latestOnDraft by rememberUpdatedState(onDraft)
    val latestOnSend by rememberUpdatedState(onSend)
    dictation.onDraft = { latestOnDraft(it) }
    dictation.onSend = { latestOnSend() }
    val unavailable = stringResource(R.string.voice_unavailable)
    val denied = stringResource(R.string.voice_mic_denied)
    val noSpeech = stringResource(R.string.voice_no_speech)
    var afterPermission by remember { mutableStateOf<(() -> Unit)?>(null) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) afterPermission?.invoke() else Toast.makeText(context, denied, Toast.LENGTH_LONG).show()
        afterPermission = null
    }
    DisposableEffect(Unit) { onDispose { dictation.dispose() } }

    fun withMicrophone(then: () -> Unit) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) then()
        else {
            afterPermission = then
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    dictation.toggle = toggle@{
        when (dictation.phase) {
            DictationPhase.LISTENING -> return@toggle dictation.stop()
            DictationPhase.TRANSCRIBING -> return@toggle
            DictationPhase.IDLE -> Unit
        }
        dictation.begin(latestDraft())
        val choice = choices.dictation
        val keyboards = Keyboards.enabled(context)
        val preferred = PhoneLanguages.list()
        val languages = DictationLanguage.candidates(
            choice = choice,
            keyboard = Keyboards.current(context),
            recent = latestRecent,
            keyboards = keyboards,
            preferred = preferred,
            app = graph.prefs.effectiveLanguage.tag,
        )
        val first = DictationLanguage.withRegion(languages.firstOrNull() ?: "en")
        val allowed = DictationLanguage.allowed(listOf(first), keyboards, preferred)
        val onPhone = {
            withMicrophone {
                dictation.listenOnPhone(first, allowed, auto = choice == DictationLanguage.AUTO, unavailable = unavailable, denied = denied)
            }
        }
        val session = graph.store.current
        if (choices.voiceSource == VoiceSource.PHONE || session == null) return@toggle onPhone()
        scope.launch {
            val ready = HubSpeech.ready(graph.apis(session), session.hub, profile)
            if (VoiceRoute.choose(choices.voiceSource, ready?.stt) != VoiceRoute.HUB) return@launch onPhone()
            // With Auto the hub's model detects the language itself; a chosen one goes as its hint.
            val language = Dictations.hubLanguage(choice)
            withMicrophone {
                val recorded = dictation.recordForHub({ file, durationMs ->
                    hubCall { graph.apis(session).models.modelsTranscribe(profile, file, language, durationMs = durationMs) }
                        .map { it.text }
                        .recoverCatching { e ->
                            val error = e as? HubError
                            throw IllegalStateException(
                                if (error?.status == 400 && error.reason == "no_speech") noSpeech else error?.text ?: error?.code ?: e.toString(),
                            )
                        }
                }, unavailable)
                if (!recorded) onPhone()
            }
        }
    }
    return dictation
}

/**
 * The composer's microphone: a tap dictates (or stops), a long press chooses the language — Auto,
 * the default, follows the keyboard. A chosen language shows as a small mark on it. Absent when
 * This device turns voice input off, or when neither the hub nor the phone can listen.
 */
@Composable
fun MicButton(dictation: DictationUi) {
    val context = LocalContext.current
    val graph = context.graph
    val t = LocalTokens.current
    val choices by graph.device.choices.collectAsState()
    val available = remember { SpeechRecognizer.isRecognitionAvailable(context) }
    var menu by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    if (!choices.voiceInput || (!available && choices.voiceSource != VoiceSource.HUB)) return
    val reader = graph.prefs.effectiveLanguage.tag
    val auto = stringResource(R.string.voice_language_auto)
    val chosen = if (choices.dictation == DictationLanguage.AUTO) auto else DictationLanguage.name(choices.dictation, reader)
    val label = stringResource(
        when (dictation.phase) {
            DictationPhase.TRANSCRIBING -> R.string.voice_transcribing
            DictationPhase.LISTENING -> R.string.voice_stop
            DictationPhase.IDLE -> R.string.voice_input
        },
    )
    Box {
        Box(
            Modifier.size(ControlTokens.heightMd.dp).clip(CircleShape)
                .combinedClickable(
                    enabled = dictation.phase != DictationPhase.TRANSCRIBING,
                    onClickLabel = label,
                    onLongClickLabel = stringResource(R.string.voice_language_hint),
                    onLongClick = { menu = true },
                    onClick = { dictation.toggle() },
                )
                .semantics {
                    contentDescription = label
                    stateDescription = chosen
                }
                .testTag("composer.dictate"),
            contentAlignment = Alignment.Center,
        ) {
            if (dictation.phase == DictationPhase.TRANSCRIBING) {
                Spinner(18.dp, t.textMuted)
            } else {
                LucideIcon(Lucide.Mic, null, size = 20.dp, tint = if (dictation.phase == DictationPhase.LISTENING) t.danger else t.textMuted)
            }
            DictationLanguage.badge(choices.dictation)?.let { badge ->
                Text(
                    badge,
                    fontSize = 8.sp,
                    color = t.accentText,
                    modifier = Modifier.align(Alignment.TopEnd).padding(top = 1.dp, end = 0.dp)
                        .background(t.accent, RoundedCornerShape(50)).padding(horizontal = 3.dp),
                )
            }
        }
        HubMenu(menu, { menu = false }) {
            val options = remember(choices.dictation) { menuLanguages(context, choices.dictation) }
            fun pick(tag: String) {
                graph.device.update { it.copy(dictation = tag) }
                menu = false
            }
            MenuLabel(stringResource(R.string.voice_language))
            MenuItem(auto, { pick(DictationLanguage.AUTO) }, checked = choices.dictation == DictationLanguage.AUTO)
            options.forEach { tag ->
                MenuItem(DictationLanguage.name(tag, reader), { pick(tag) }, checked = choices.dictation.equals(tag, ignoreCase = true))
            }
            MenuDivider()
            MenuItem(stringResource(R.string.voice_language_more), { menu = false; more = true }, icon = Lucide.Globe)
        }
    }
    if (more) {
        DictationLanguageDialog(
            choice = choices.dictation,
            onChoose = { tag -> graph.device.update { it.copy(dictation = tag) }; more = false },
            onDismiss = { more = false },
        )
    }
}

/** The menu's languages: the one chosen from «More», then the keyboards', then popular ones. */
private fun menuLanguages(context: Context, choice: String): List<String> {
    val offered = DictationLanguage.menu(Keyboards.enabled(context), supported = null)
    if (choice == DictationLanguage.AUTO || offered.any { DictationLanguage.base(it) == DictationLanguage.base(choice) }) return offered
    return listOf(choice) + offered
}

/** Over the composer while dictating: cancel, the microphone's level, stop, and send (as on iOS). */
@Composable
fun DictationStrip(dictation: DictationUi) {
    if (!dictation.active) return
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).floatingChrome().padding(horizontal = 6.dp, vertical = 4.dp)
            .testTag("dictation.strip"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (dictation.phase == DictationPhase.LISTENING) {
            HubIconButton(Lucide.X, stringResource(R.string.voice_cancel), dictation::cancel, size = ControlTokens.heightSm.dp, iconSize = 16.dp, modifier = Modifier.testTag("dictation.cancel"))
            Waveform(dictation.levels, t.accent, Modifier.weight(1f).height(24.dp))
            dictation.listeningIn?.let { Text(DictationLanguage.base(it).uppercase(Locale.ROOT), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted) }
            Box(
                Modifier.size(ControlTokens.heightSm.dp).clip(CircleShape).clickable(onClickLabel = stringResource(R.string.voice_stop), onClick = dictation::stop)
                    .testTag("dictation.stop"),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(12.dp).background(t.danger, RoundedCornerShape(2.dp)))
            }
        } else {
            Spinner(18.dp, t.textMuted, Modifier.padding(start = 6.dp))
            Text(
                stringResource(R.string.voice_transcribing), fontSize = FontTokens.sizeSm.sp, color = t.textMuted,
                modifier = Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 6.dp),
            )
        }
        HubIconButton(
            Lucide.ArrowUp, stringResource(R.string.voice_send), dictation::send, kind = IconKind.Accent,
            size = ControlTokens.heightSm.dp, iconSize = 16.dp, modifier = Modifier.testTag("dictation.send"),
        )
    }
}

/** The microphone's loudness over the last moments, as bars. */
@Composable
private fun Waveform(levels: List<Float>, color: Color, modifier: Modifier) {
    Canvas(modifier) {
        val gap = 2.dp.toPx()
        val bar = ((size.width - gap * (levels.size - 1)) / levels.size).coerceIn(1f, 3.dp.toPx())
        val total = bar * levels.size + gap * (levels.size - 1)
        var x = (size.width - total) / 2
        levels.forEach { level ->
            val height = (level * size.height).coerceAtLeast(3.dp.toPx())
            drawRoundRect(color, Offset(x, (size.height - height) / 2), Size(bar, height), CornerRadius(bar / 2))
            x += bar + gap
        }
    }
}

/**
 * Every language dictation can listen in, searchable: «More languages…» in the microphone's menu
 * and «Dictation language» in This device. Auto first; then the keyboards' and popular languages;
 * then all the phone's recognizer knows (Android 13+ says; before it, every language the phone knows).
 */
@Composable
fun DictationLanguageDialog(choice: String, onChoose: (String) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val reader = context.graph.prefs.effectiveLanguage.tag
    var query by remember { mutableStateOf("") }
    var supported by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(Unit) { supported = recognizerLanguages(context) }
    val all = remember(supported, reader) {
        val source = supported ?: Locale.getAvailableLocales().map { it.toLanguageTag() }
        source.mapNotNull(DictationLanguage::tag).distinctBy { it.lowercase() }.sortedBy { DictationLanguage.name(it, reader) }
    }
    val suggested = remember(supported) { DictationLanguage.menu(Keyboards.enabled(context), supported) }
    val words = query.trim()
    val found = if (words.isEmpty()) all else all.filter {
        DictationLanguage.name(it, reader).contains(words, ignoreCase = true) ||
            DictationLanguage.name(it, "en").contains(words, ignoreCase = true) || it.contains(words, ignoreCase = true)
    }
    HubDialog(onDismiss, stringResource(R.string.voice_language)) {
        HubTextField(
            query, { query = it }, placeholder = stringResource(R.string.voice_language_search), leadingIcon = Lucide.Search,
            modifier = Modifier.fillMaxWidth().testTag("dictation.languages.search"),
        )
        LazyColumn(Modifier.heightIn(max = 420.dp).testTag("dictation.languages")) {
            if (words.isEmpty()) {
                item { LanguageRow(stringResource(R.string.voice_language_auto), choice == DictationLanguage.AUTO) { onChoose(DictationLanguage.AUTO) } }
                item { Text(stringResource(R.string.voice_language_auto_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
                item { Heading(stringResource(R.string.voice_language_suggested)) }
                items(suggested, key = { "s:$it" }) { tag ->
                    LanguageRow(DictationLanguage.name(tag, reader), choice.equals(tag, ignoreCase = true)) { onChoose(tag) }
                }
                item { Heading(stringResource(R.string.voice_language_all)) }
            }
            items(found, key = { "a:$it" }) { tag ->
                LanguageRow(DictationLanguage.name(tag, reader), choice.equals(tag, ignoreCase = true)) { onChoose(tag) }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            HubButton(stringResource(R.string.close), onDismiss, kind = ButtonKind.Secondary, size = ControlSize.Md)
        }
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = LocalTokens.current.textMuted, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
}

@Composable
private fun LanguageRow(name: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(name, Modifier.weight(1f), fontSize = FontTokens.sizeMd.sp)
        if (selected) LucideIcon(Lucide.Check, null, size = 18.dp, tint = LocalTokens.current.accent)
    }
}

/** The languages the phone's recognizer supports (Android 13+); null when it cannot say. */
suspend fun recognizerLanguages(context: Context): List<String>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isRecognitionAvailable(context)) return null
    return withTimeoutOrNull(3000) { askRecognizer(context) }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private suspend fun askRecognizer(context: Context): List<String>? = suspendCancellableCoroutine { cont ->
    val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
    cont.invokeOnCancellation { runCatching { recognizer.destroy() } }
    recognizer.checkRecognitionSupport(
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH),
        ContextCompat.getMainExecutor(context),
        object : RecognitionSupportCallback {
            override fun onSupportResult(support: RecognitionSupport) {
                runCatching { recognizer.destroy() }
                val languages = (support.installedOnDeviceLanguages + support.pendingOnDeviceLanguages +
                    support.supportedOnDeviceLanguages + support.onlineLanguages).distinct()
                if (cont.isActive) cont.resume(languages.ifEmpty { null })
            }

            override fun onError(error: Int) {
                runCatching { recognizer.destroy() }
                if (cont.isActive) cont.resume(null)
            }
        },
    )
}

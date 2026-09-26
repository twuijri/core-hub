package hub.core.android.phone

import android.content.Context
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import hub.core.android.data.HubApis
import hub.core.android.data.hubCall
import hub.core.android.markdown.Markdown
import hub.core.android.markdown.MdColors
import hub.core.client.model.SpeechFormat
import hub.core.client.model.SpeechRequest
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

/** What a hub may speak for a reply: the signed-in hub's API, the chat's profile, the person's choice. */
data class HubVoice(val api: HubApis, val hub: String, val profile: String, val source: VoiceSource)

/**
 * Reads finished replies aloud (This device → spoken replies): with the hub's voice when it has
 * one for the profile (and the person chose Core Hub), else the phone's own.
 */
class Speaker(private val context: Context) {
    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: Pair<String, String>? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var playing: Job? = null
    private var player: MediaPlayer? = null

    fun speak(markdown: String, hub: HubVoice? = null) {
        val text = Markdown.plain(Markdown.parse(markdown, MdColors(androidx.compose.ui.graphics.Color.Black, androidx.compose.ui.graphics.Color.Black, androidx.compose.ui.graphics.Color.Black))).trim()
        if (text.isEmpty()) return
        stop()
        // The reply's own language, by its letters: Arabic, Russian, Hindi… not only Arabic or English.
        val language = DictationLanguage.replyLanguage(text, PhoneLanguages.list())
        if (hub == null || hub.source != VoiceSource.HUB) return onPhone(text, language)
        playing = scope.launch {
            val speech = HubSpeech.ready(hub.api, hub.hub, hub.profile)
            if (VoiceRoute.choose(hub.source, speech?.tts) != VoiceRoute.HUB) return@launch onPhone(text, language)
            // The hub takes up to 2 000 characters a request: longer replies go in parts.
            VoiceText.chunks(text).forEachIndexed { index, part ->
                val file = hubCall {
                    // MP3, which every phone plays, rather than a provider's default Ogg (DECISIONS §91).
                    hub.api.models.modelsSynthesize(hub.profile, SpeechRequest(text = part, language = language, format = SpeechFormat.MP3))
                }.getOrNull()
                if (file == null) {
                    // The hub could not speak this time: the phone reads it instead.
                    if (index == 0) onPhone(text, language)
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
                setOnCompletionListener { done(it); if (cont.isActive) cont.resume(Unit) }
                setOnErrorListener { mp, _, _ -> done(mp); if (cont.isActive) cont.resume(Unit); true }
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

    /** A part finished: its player is let go. */
    private fun done(media: MediaPlayer) {
        if (player === media) player = null
        media.release()
    }

    private fun onPhone(text: String, language: String) {
        if (tts == null) tts = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            pending?.let { (t, l) -> say(t, l) }
            pending = null
        }
        if (ready) say(text, language) else pending = text to language
    }

    private fun say(text: String, language: String) {
        val engine = tts ?: return
        engine.language = Locale.forLanguageTag(language)
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

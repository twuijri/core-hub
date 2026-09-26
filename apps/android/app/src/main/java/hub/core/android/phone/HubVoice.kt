package hub.core.android.phone

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import hub.core.android.data.HubApis
import hub.core.android.data.hubCall
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/*
 * Where the voice comes from (owner, 2026-09-25), as on the web: the hub's speech providers of the
 * chat's profile when it has them (`models.transcribe`, `models.synthesize`), else this phone's
 * own recognizer and voice. «Voice: Core Hub / This phone» (This device) chooses; Core Hub by default.
 */

/** Whose speech dictation and spoken replies use. */
enum class VoiceSource { HUB, PHONE }

/** Which side listens or speaks. */
enum class VoiceRoute {
    HUB, PHONE;

    companion object {
        /**
         * The hub when the person chose Core Hub and the profile's provider is ready; the phone
         * otherwise — including when the hub could not be asked ([hubReady] null).
         */
        fun choose(source: VoiceSource, hubReady: Boolean?): VoiceRoute =
            if (source == VoiceSource.HUB && hubReady == true) HUB else PHONE
    }
}

object VoiceText {
    /** `SpeechRequest.text` is at most 2 000 characters. */
    const val HUB_LIMIT = 2000

    /**
     * A reply in parts the hub speaks: cut at a sentence or a line when one is near the limit,
     * else at a space, never inside a word when it can help it.
     */
    fun chunks(text: String, limit: Int = HUB_LIMIT): List<String> {
        val parts = mutableListOf<String>()
        var rest = text
        while (rest.length > limit) {
            val window = rest.substring(0, limit)
            val sentence = window.indexOfLast { it in ".!?؟\n" }
            val cut = when {
                sentence >= 0 -> sentence + 1
                window.lastIndexOf(' ') >= 0 -> window.lastIndexOf(' ') + 1
                else -> limit
            }
            window.substring(0, cut).trim().takeIf { it.isNotEmpty() }?.let(parts::add)
            rest = rest.substring(cut)
        }
        rest.trim().takeIf { it.isNotEmpty() }?.let(parts::add)
        return parts
    }
}

/** Whether the hub can listen and speak for a profile (`models.getSpeech`), asked at most once a minute. */
object HubSpeech {
    data class Ready(val stt: Boolean, val tts: Boolean)

    private val known = ConcurrentHashMap<String, Pair<Ready, Long>>()

    /** null when the hub could not say (offline, an older hub): the phone is used then. */
    suspend fun ready(api: HubApis, hub: String, profile: String): Ready? {
        val key = "$hub|$profile"
        known[key]?.let { (ready, at) -> if (System.currentTimeMillis() - at < 60_000) return ready }
        val settings = hubCall { api.models.modelsGetSpeech(profile) }.getOrNull() ?: return null
        return Ready(settings.stt.ready, settings.tts.ready).also { known[key] = it to System.currentTimeMillis() }
    }
}

/** One take for the hub to transcribe: AAC in an .m4a file, 16 kHz mono (small; the hub takes m4a). */
class Recording(context: Context) {
    val file: File = File(context.cacheDir, "dictation-${System.currentTimeMillis()}.m4a")
    private val startedAt = System.currentTimeMillis()

    @Suppress("DEPRECATION")
    private val recorder: MediaRecorder = (if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()).apply {
        setAudioSource(MediaRecorder.AudioSource.MIC)
        setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        setAudioSamplingRate(16_000)
        setAudioChannels(1)
        setAudioEncodingBitRate(32_000)
        setOutputFile(file.absolutePath)
        prepare()
        start()
    }

    /** How loud the microphone is now, 0…1, for the strip's waveform. */
    fun level(): Float {
        val amplitude = runCatching { recorder.maxAmplitude }.getOrDefault(0)
        if (amplitude <= 0) return 0f
        return Dictations.level(20f * kotlin.math.log10(amplitude / 32767f))
    }

    /** Ends the take; how long it lasted, in ms. */
    fun finish(): Int {
        runCatching { recorder.stop() }
        recorder.release()
        return (System.currentTimeMillis() - startedAt).toInt()
    }

    fun discard() {
        runCatching { recorder.stop() }
        recorder.release()
        file.delete()
    }
}

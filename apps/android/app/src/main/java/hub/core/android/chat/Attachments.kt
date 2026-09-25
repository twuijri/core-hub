package hub.core.android.chat

import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.client.model.Attachment
import hub.core.client.model.ContentBlock
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/*
 * Files in the composer (owner, 2026-09-25): the «+» button offers a photo, the camera or a file.
 * Each one is uploaded as soon as it is picked (`sessions.uploadAttachment`, as the web's composer
 * does), shows as a chip with a preview and a remove button, and goes with the next message as an
 * image or file block.
 */

/** The words and files of one message on their way to the hub. */
data class Outgoing(val text: String, val attachments: List<Attachment> = emptyList()) {
    val isEmpty: Boolean get() = text.isBlank() && attachments.isEmpty()

    /** The blocks `sessions.createRun` takes: the text, then one block per file (web: `blocksFor`). */
    fun blocks(): List<ContentBlock> = buildList {
        val trimmed = text.trim()
        if (trimmed.isNotEmpty()) add(ContentBlock(type = ContentBlock.Type.TEXT, text = trimmed))
        attachments.forEach { a ->
            val type = when (a.kind) {
                Attachment.Kind.IMAGE -> ContentBlock.Type.IMAGE
                Attachment.Kind.AUDIO -> ContentBlock.Type.AUDIO
                else -> ContentBlock.Type.FILE
            }
            add(ContentBlock(type = type, attachmentId = a.id, name = a.name, mime = a.mime, sizeBytes = a.sizeBytes))
        }
    }
}

object AttachmentRules {
    /** `sessions.uploadAttachment` takes a file in one request up to 25 MB. */
    const val MAX_BYTES = 25L * 1024 * 1024

    /** Photos are made smaller before they leave the phone: the longer side at most this. */
    const val PHOTO_MAX_SIDE = 2048

    /** JPEG quality of a photo sent (0–100). */
    const val PHOTO_QUALITY = 80

    /** [width]×[height] scaled down (never up) so the longer side is at most [maxSide]. */
    fun fitted(width: Int, height: Int, maxSide: Int = PHOTO_MAX_SIDE): Pair<Int, Int> {
        val longer = max(width, height)
        if (longer <= maxSide || longer <= 0) return width to height
        val scale = maxSide.toDouble() / longer
        return (width * scale).roundToInt() to (height * scale).roundToInt()
    }

    /** «25 MB», the limit as a person reads it. */
    fun sizeText(bytes: Long): String {
        val mb = bytes / (1024.0 * 1024.0)
        return if (mb >= 1) "${mb.roundToInt()} MB" else "${(bytes / 1024.0).roundToInt()} KB"
    }
}

/**
 * The files waiting in the composer. [upload] sends one local file into the chat's profile;
 * [discard] deletes an uploaded one nothing uses yet (a chip removed before sending).
 */
class AttachmentTray(
    private val scope: CoroutineScope,
    private val upload: suspend (File) -> Attachment,
    private val discard: suspend (Attachment) -> Unit,
) {
    sealed interface State {
        data object Uploading : State
        data class Ready(val attachment: Attachment) : State

        /** [tooLarge] when the file is over the hub's limit (checked here, or the hub's 413). */
        data class Failed(val error: HubError?, val tooLarge: Boolean) : State
    }

    /** One chip. [preview] is a small picture for a photo (an Android bitmap), null for a file. */
    data class Item(val id: String, val name: String, val isImage: Boolean, val preview: Any?, val state: State)

    private val _items = MutableStateFlow<List<Item>>(emptyList())
    val items: StateFlow<List<Item>> = _items.asStateFlow()

    /** Something is still on its way: sending waits for it. */
    val uploading: Boolean get() = _items.value.any { it.state == State.Uploading }

    /** What finished uploading, in the order it was picked. */
    val attachments: List<Attachment> get() = _items.value.mapNotNull { (it.state as? State.Ready)?.attachment }

    /** Adds [file] (already under its own name) and uploads it; the file is deleted afterwards. */
    fun add(file: File, isImage: Boolean, preview: Any? = null) {
        val id = UUID.randomUUID().toString()
        if (file.length() > AttachmentRules.MAX_BYTES) {
            _items.update { it + Item(id, file.name, isImage, preview, State.Failed(null, tooLarge = true)) }
            file.delete()
            return
        }
        _items.update { it + Item(id, file.name, isImage, preview, State.Uploading) }
        scope.launch {
            val result = hubCall { upload(file) }
            file.delete()
            val state = result.fold(
                onSuccess = { State.Ready(it) },
                onFailure = { e -> (e as HubError).let { State.Failed(it, tooLarge = it.status == 413) } },
            )
            var kept = false
            _items.update { list ->
                list.map { item -> if (item.id == id) item.copy(state = state).also { kept = true } else item }
            }
            // Removed while it was uploading: nothing will use it.
            if (!kept && state is State.Ready) discard(state.attachment)
        }
    }

    /** A file that could not even be read on the phone. */
    fun addUnreadable(name: String) {
        _items.update { it + Item(UUID.randomUUID().toString(), name, false, null, State.Failed(null, tooLarge = false)) }
    }

    /** The chip's ×: the file does not go, and an uploaded one is deleted on the hub. */
    fun remove(id: String) {
        val item = _items.value.firstOrNull { it.id == id } ?: return
        _items.update { list -> list.filterNot { it.id == id } }
        val ready = item.state as? State.Ready ?: return
        scope.launch { runCatching { discard(ready.attachment) } }
    }

    /** After sending: the files now belong to the message. */
    fun clear() = _items.update { emptyList() }
}

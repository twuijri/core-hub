package hub.core.android.phone

import android.content.Intent

/**
 * «Share to Core Hub»: what another app shares becomes a new chat in the profile the selector is
 * on — text and links as the draft, pictures and files as its attachments (phone parity, B14).
 */
object Share {
    /** A shared picture or file, copied into the app's cache, waiting for the new chat's tray. */
    data class SharedFile(val file: java.io.File, val isImage: Boolean, val preview: Any? = null)

    /** The streams a share carries: one for `SEND`, several for `SEND_MULTIPLE`, none for text alone. */
    fun streamsOf(action: String?, single: android.net.Uri?, many: List<android.net.Uri>?): List<android.net.Uri> = when (action) {
        Intent.ACTION_SEND -> listOfNotNull(single)
        Intent.ACTION_SEND_MULTIPLE -> many.orEmpty().distinct()
        else -> emptyList()
    }

    @Suppress("DEPRECATION") // the typed getters are API 33+
    fun streamsOf(intent: Intent?): List<android.net.Uri> = intent?.let {
        streamsOf(
            it.action,
            runCatching { it.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM) }.getOrNull(),
            runCatching { it.getParcelableArrayListExtra<android.net.Uri>(Intent.EXTRA_STREAM) }.getOrNull(),
        )
    }.orEmpty()

    /** Whether a shared stream is a picture, from its type or its name. */
    fun isImage(mime: String?, name: String?): Boolean =
        mime?.startsWith("image/") == true || (mime == null && name?.substringAfterLast('.', "")?.lowercase() in setOf("jpg", "jpeg", "png", "heic", "webp", "gif"))

    fun textOf(action: String?, type: String?, subject: String?, text: String?): String? {
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
        // With pictures or files, only a caption the sender wrote (not a subject, often the file's name).
        if (type?.startsWith("text/") != true) return text?.trim()?.takeIf { it.isNotEmpty() }
        val body = text?.trim().orEmpty()
        val title = subject?.trim().orEmpty()
        return when {
            body.isEmpty() && title.isEmpty() -> null
            title.isEmpty() || body.contains(title) -> body
            body.isEmpty() -> title
            else -> "$title\n\n$body"
        }
    }

    fun textOf(intent: Intent?): String? = intent?.let {
        textOf(it.action, it.type, it.getStringExtra(Intent.EXTRA_SUBJECT), it.getStringExtra(Intent.EXTRA_TEXT))
    }
}

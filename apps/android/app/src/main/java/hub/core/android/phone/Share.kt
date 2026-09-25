package hub.core.android.phone

import android.content.Intent

/**
 * «Share to Core Hub»: what another app shares becomes the draft of a new chat in the profile the
 * selector is on. Text and links today; files and pictures are a follow-up (they need the
 * attachment upload in the composer first).
 */
object Share {
    fun textOf(action: String?, type: String?, subject: String?, text: String?): String? {
        if (action != Intent.ACTION_SEND || type?.startsWith("text/") != true) return null
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

package us.i3u.hermesstudio

import org.json.JSONArray
import java.net.URLDecoder

/** A local Studio file linked from an assistant Markdown message. */
data class ChatFileLink(
    val label: String,
    val path: String,
    val fileName: String,
)

data class ParsedChatMessage(
    val text: String,
    val files: List<ChatFileLink>,
)

private val MARKDOWN_LINK = Regex(
    """(?<!!)\[([^\]\r\n]+)]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))\s*\)""",
)
private val FILES_HEADING = Regex(
    """(?im)^\s{0,3}#{1,6}\s+(?:files|attachments|downloads|الملفات|المرفقات)\s*$""",
)
private val CONVENTIONAL_EXTENSION = Regex("""\.[A-Za-z0-9]{1,12}$""")

/**
 * Pulls absolute local-file links out of Markdown so the native UI can render
 * download cards. Ordinary web links and Markdown images stay in the message.
 */
fun parseChatMessage(content: String): ParsedChatMessage {
    val contentBlocks = parseStudioContentBlocks(content)
    val visibleContent = contentBlocks?.text ?: content
    val accepted = MARKDOWN_LINK.findAll(visibleContent).mapNotNull { match ->
        val rawTarget = match.groups[2]?.value ?: match.groups[3]?.value ?: return@mapNotNull null
        val path = unwrapStudioDownloadPath(rawTarget.trim())
        if (!isStudioLocalFile(path)) return@mapNotNull null
        val label = decodeUrlPart(match.groupValues[1]).trim().ifBlank { inferDownloadFileName(path) }
        match to ChatFileLink(
            label = label,
            path = path,
            fileName = inferDownloadFileName(path, label),
        )
    }.toList()

    if (accepted.isEmpty() && contentBlocks == null) return ParsedChatMessage(content, emptyList())

    val body = buildString {
        var cursor = 0
        accepted.forEach { (match, _) ->
            append(visibleContent, cursor, match.range.first)
            cursor = match.range.last + 1
        }
        append(visibleContent, cursor, visibleContent.length)
    }
        .replace(FILES_HEADING, "")
        .replace(Regex("""\n[ \t]*\n(?:[ \t]*\n)+"""), "\n\n")
        .trim()

    val files = (contentBlocks?.files.orEmpty() + accepted.map { it.second })
        .distinctBy { it.path }
    return ParsedChatMessage(body, files)
}

/**
 * Studio stores a message carrying uploads as a JSON string of content blocks.
 * The web client turns those blocks back into attachment cards; doing the same
 * here prevents an audio note or document from appearing as raw JSON after a
 * history refresh.
 *
 * Returns null when the value is not a block array *or* when the blocks carry
 * nothing this client can draw. An empty [ParsedChatMessage] would otherwise
 * reach the row and paint an avatar, an author label and a timestamp with no
 * text at all; falling back to the original string always shows something.
 */
private fun parseStudioContentBlocks(content: String): ParsedChatMessage? {
    val trimmed = content.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
    val array = runCatching { JSONArray(trimmed) }.getOrNull() ?: return null
    val text = mutableListOf<String>()
    val files = mutableListOf<ChatFileLink>()

    for (index in 0 until array.length()) {
        val block = array.optJSONObject(index) ?: continue
        when (block.optString("type")) {
            "text" -> block.optString("text").trim().takeIf(String::isNotEmpty)?.let(text::add)

            "file", "image" -> {
                val path = block.optString("path").trim()
                val name = block.optString("name").trim()
                if (path.isNotBlank() && isStudioLocalFile(path)) {
                    val label = name.ifBlank { inferDownloadFileName(path) }
                    files += ChatFileLink(
                        label = label,
                        path = path,
                        fileName = inferDownloadFileName(path, label),
                    )
                } else {
                    // A remote or relative attachment cannot become a download
                    // card, but the reader still has to see that a file rode
                    // along — the web shows its name too.
                    name.ifBlank { path }.takeIf(String::isNotBlank)?.let { text += "📎 $it" }
                }
            }
        }
    }

    val body = text.joinToString("\n\n")
    val links = files.distinctBy { it.path }
    return if (body.isNotBlank() || links.isNotEmpty()) ParsedChatMessage(body, links) else null
}

/**
 * True when [content] would draw something: body text or an attachment card.
 * The transcript uses it instead of a bare `isBlank()` so a message is dropped
 * only when it is genuinely empty, never because its text happens to start
 * with "[" or because it is a block array this client reads differently.
 */
fun hasRenderableChatContent(content: String): Boolean {
    if (content.isBlank()) return false
    val parsed = parseChatMessage(content)
    return parsed.text.isNotBlank() || parsed.files.isNotEmpty()
}

fun inferDownloadFileName(path: String, label: String? = null): String {
    val cleanLabel = decodeUrlPart(label.orEmpty()).trim()
    val decodedPath = decodeUrlPart(unwrapStudioDownloadPath(path))
        .substringBefore('?')
        .substringBefore('#')
    val basename = decodedPath.split('/', '\\').lastOrNull().orEmpty().trim()
    val preferred = when {
        CONVENTIONAL_EXTENSION.containsMatchIn(cleanLabel) -> cleanLabel
        CONVENTIONAL_EXTENSION.containsMatchIn(basename) -> basename
        cleanLabel.isNotBlank() -> cleanLabel
        basename.isNotBlank() -> basename
        else -> "download"
    }
    return preferred
        .split('/', '\\')
        .last()
        .replace(Regex("""[\u0000-\u001f<>:\"/\\|?*]"""), "_")
        .trim()
        .ifBlank { "download" }
}

/** Download links the server may put into a message: the canonical Studio route and the legacy alias. */
private val STUDIO_DOWNLOAD_PREFIXES = listOf("/api/studio/files/download?", "/api/hermes/download?")

fun unwrapStudioDownloadPath(value: String): String {
    if (STUDIO_DOWNLOAD_PREFIXES.none(value::startsWith)) return decodeUrlPart(value)
    val encoded = value.substringAfter('?').split('&')
        .firstOrNull { it.substringBefore('=') == "path" }
        ?.substringAfter('=', "")
        .orEmpty()
    return if (encoded.isBlank()) decodeUrlPart(value) else decodeUrlPart(encoded)
}

/** Server-local absolute paths and `device://<id>/<path>` links on a linked device. */
private fun isStudioLocalFile(path: String): Boolean =
    path.startsWith('/') ||
        path.startsWith("device://", ignoreCase = true) ||
        Regex("""^[A-Za-z]:[\\/]""").containsMatchIn(path)

private fun decodeUrlPart(value: String): String = runCatching {
    URLDecoder.decode(value.replace("+", "%2B"), Charsets.UTF_8.name())
}.getOrDefault(value)

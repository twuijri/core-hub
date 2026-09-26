package hub.core.android.chat

import hub.core.android.data.HubError
import hub.core.android.data.apiBase
import hub.core.android.data.hubCall
import hub.core.client.api.MetaApi
import hub.core.client.api.SessionsApi
import hub.core.client.model.SessionFile
import hub.core.client.model.SessionsCreateFileStreamRequest
import java.io.File
import java.io.InterruptedIOException
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer

/*
 * Opening the files of a conversation on the phone (docs/changes/2026-09-26-twuijri-mobile-open-files.md).
 * Everything here is pure or talks to the hub through the generated client only, so the rules are
 * tested on the JVM (HubFilesTest): which way a file opens, which file a link in a reply names, and
 * the download itself (bearer header, progress, cancel).
 */

/** A file of the hub a message carries or a reply's link names. */
sealed interface HubFile {
    val name: String
    val mime: String?
    val sizeBytes: Long?

    /** The folder it is kept under in the phone's cache. */
    val cacheKey: String

    /** An attachment: its bytes never change (`sessions.downloadAttachment`). */
    data class Attachment(val id: String, override val name: String, override val mime: String? = null, override val sizeBytes: Long? = null) : HubFile {
        override val cacheKey: String get() = id
    }

    /**
     * A file of the conversation's working folder (`sessions.readFile`): it may change, so the key
     * carries its size and time when the hub gave them.
     */
    data class Working(
        val sessionId: String,
        val path: String,
        override val name: String,
        override val mime: String? = null,
        override val sizeBytes: Long? = null,
        val modified: String? = null,
    ) : HubFile {
        override val cacheKey: String get() = "file-" + sha1("$sessionId\u0000$path\u0000$sizeBytes\u0000$modified").take(24)
    }

    companion object {
        fun of(attachment: ChatAttachment): Attachment? = attachment.attachmentId?.let {
            Attachment(it, attachment.name ?: it, attachment.mime, attachment.sizeBytes)
        }

        /** An entry of `sessions.listFiles`: its attachment when it is one, else the folder's file. */
        fun of(file: SessionFile, sessionId: String): HubFile = file.attachmentId?.let { Attachment(it, file.name, file.mime, file.sizeBytes) }
            ?: Working(sessionId, file.path ?: file.name, file.name, file.mime, file.sizeBytes, file.modifiedAt?.toString())
    }
}

private fun sha1(text: String): String =
    MessageDigest.getInstance("SHA-1").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

/** How a file opens: drawn by the app, in the phone's viewer or player, or handed to the share sheet. */
enum class FileOpen { PICTURE, VIEWER, MEDIA, SHARE }

object FileKinds {
    /** Pictures the app decodes itself (an SVG is not one: it opens in the viewer). */
    private val pictures = setOf("image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/bmp")

    private val byExtension = mapOf(
        "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png", "gif" to "image/gif", "webp" to "image/webp",
        "heic" to "image/heic", "heif" to "image/heif", "bmp" to "image/bmp", "svg" to "image/svg+xml",
        "pdf" to "application/pdf", "txt" to "text/plain", "md" to "text/markdown", "csv" to "text/csv",
        "json" to "application/json", "html" to "text/html", "htm" to "text/html", "xml" to "text/xml", "log" to "text/plain",
        "mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac", "wav" to "audio/wav", "ogg" to "audio/ogg",
        "oga" to "audio/ogg", "opus" to "audio/ogg", "flac" to "audio/flac", "weba" to "audio/webm",
        "mp4" to "video/mp4", "m4v" to "video/mp4", "mov" to "video/quicktime", "webm" to "video/webm", "mkv" to "video/x-matroska",
        "doc" to "application/msword", "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel", "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" to "application/vnd.ms-powerpoint", "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "epub" to "application/epub+zip", "rtf" to "application/rtf",
    )

    /** Opened in the phone's own viewer: documents and text. Anything else is shared or saved. */
    private val documents = setOf(
        "application/pdf", "application/json", "application/rtf", "application/epub+zip", "image/svg+xml",
        "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
    )

    /** The file's type: the hub's, unless it says nothing (`application/octet-stream`); then its name's. */
    fun mimeOf(name: String, mime: String?): String {
        val given = mime?.substringBefore(';')?.trim()?.lowercase()
        if (!given.isNullOrEmpty() && given != "application/octet-stream") return given
        return byExtension[name.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
    }

    fun openAs(name: String, mime: String?): FileOpen {
        val type = mimeOf(name, mime)
        return when {
            type in pictures -> FileOpen.PICTURE
            type.startsWith("audio/") || type.startsWith("video/") -> FileOpen.MEDIA
            type.startsWith("text/") || type in documents || type.startsWith("application/vnd.openxmlformats-officedocument.") -> FileOpen.VIEWER
            else -> FileOpen.SHARE
        }
    }

    fun openAs(file: HubFile): FileOpen = openAs(file.name, file.mime)
}

/**
 * Which file of the hub a link in a reply names (web: `Markdown.tsx`, decision §48): the address of
 * one of the reply's attachments (relative or on the hub's own origin), or a word that is one of the
 * conversation's files — its path, a path ending in it, or its name when one file has it (the reply's
 * own files first). Any other link is an ordinary link and opens in the browser.
 */
object FileLinks {
    /** The address a hub serves an attachment's bytes at, as the generated client builds it. */
    fun contentPath(attachmentId: String): String =
        MetaApi.defaultBasePath + SessionsApi(apiBase("")).sessionsDownloadAttachmentRequestConfig("", attachmentId, null).path

    /** The link as a word: decoded, without a query or fragment; null when it points off the hub. */
    fun wordOf(href: String, hub: String): String? {
        val raw = href.trim()
        if (raw.isEmpty() || raw.startsWith("#")) return null
        val scheme = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):").find(raw)?.groupValues?.get(1)?.lowercase()
        val path = when {
            scheme == "http" || scheme == "https" -> {
                val url = raw.toHttpUrlOrNull() ?: return null
                val home = hub.toHttpUrlOrNull() ?: return null
                if (url.scheme != home.scheme || url.host != home.host || url.port != home.port) return null
                url.encodedPath
            }
            // What agents write for a file they made: `sandbox:/…`, `file:///…`.
            scheme == "sandbox" || scheme == "file" -> raw.substringAfter(':').trimStart('/').let { "/$it" }
            scheme != null -> return null
            raw.startsWith("//") -> return null
            else -> raw
        }
        val bare = path.substringBefore('#').substringBefore('?')
        return runCatching { java.net.URLDecoder.decode(bare.replace("+", "%2B"), "UTF-8") }.getOrDefault(bare).ifBlank { null }
    }

    /** The file [href] names, or null for an ordinary link. [files] is the conversation's list, when read. */
    fun resolve(href: String, hub: String, own: List<ChatAttachment>, files: List<SessionFile>? = null, sessionId: String? = null): HubFile? {
        val word = wordOf(href, hub) ?: return null
        // The address of an attachment the reply carries (the block's own `url`, or where the hub serves it).
        own.forEach { a ->
            val id = a.attachmentId ?: return@forEach
            if (word == a.url || word == contentPath(id)) return HubFile.of(a)
        }
        val known = files.orEmpty()
        known.firstOrNull { it.attachmentId != null && word == contentPath(it.attachmentId!!) }?.let { return HubFile.of(it, sessionId ?: "") }
        return forWord(word, own, known, sessionId)
    }

    private fun forWord(mention: String, own: List<ChatAttachment>, files: List<SessionFile>, sessionId: String?): HubFile? {
        val word = mention.trim().removePrefix("./")
        if (word.isEmpty() || word.length > 4096 || word.any { it.isWhitespace() && it != ' ' }) return null
        val base = word.substringAfterLast('/')
        // The reply's own file of that name first: `flying_cat.png` means the one it carries.
        own.filter { it.attachmentId != null && it.name == base }.singleOrNull()?.let { return HubFile.of(it) }
        if (sessionId == null) return null
        val onDisk = files.filter { it.path != null }
        onDisk.firstOrNull { it.path == word || word.endsWith("/${it.path}") }?.let { return HubFile.of(it, sessionId) }
        return files.filter { it.name == base }.singleOrNull()?.let { HubFile.of(it, sessionId) }
    }
}

/** How far a download is: [read] bytes of [total] (null when the hub did not say). */
data class Progress(val read: Long, val total: Long?) {
    val fraction: Float? get() = total?.takeIf { it > 0 }?.let { (read.toFloat() / it).coerceIn(0f, 1f) }
}

/**
 * Fetches a file of the hub into the phone's cache through the generated client (the bearer goes in
 * the header, never in the address), reporting progress and stopping when its coroutine is cancelled.
 * A file is written beside its place and moved in only once whole, so a download cut short is never
 * mistaken for the file.
 */
class HubFileFetcher(private val client: OkHttpClient, private val root: File) {
    /** Where [file] is kept: a folder per file, under its own (safe) name so a viewer knows its kind. */
    fun place(file: HubFile): File = File(File(root, file.cacheKey), safeName(file.name, file.cacheKey))

    /** The file when it is already here, whole. */
    fun cached(file: HubFile): File? = place(file).takeIf { it.isFile && (file.sizeBytes == null || it.length() == file.sizeBytes) }

    suspend fun fetch(hub: String, profile: String, file: HubFile, onProgress: (Progress) -> Unit = {}): File {
        cached(file)?.let { return it }
        val job = currentCoroutineContext()[Job]
        val counting = client.newBuilder().addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            val body = response.body
            if (!response.isSuccessful || body == null) response
            else response.newBuilder().body(CountingBody(body, file.sizeBytes, onProgress) { job?.isActive != false }).build()
        }.build()
        val sessions = SessionsApi(apiBase(hub), counting)
        val downloaded = try {
            hubCall {
                when (file) {
                    is HubFile.Attachment -> sessions.sessionsDownloadAttachment(xHubProfile = profile, attachmentId = file.id)
                    is HubFile.Working -> sessions.sessionsReadFile(xHubProfile = profile, sessionId = file.sessionId, path = file.path, download = true)
                }
            }.getOrThrow()
        } catch (e: HubError) {
            if (job?.isActive == false) throw CancellationException("download cancelled")
            throw e
        }
        return withContext(Dispatchers.IO) {
            val target = place(file)
            target.parentFile?.mkdirs()
            val part = File(target.parentFile, target.name + ".part")
            try {
                downloaded.copyTo(part, overwrite = true)
                if (!part.renameTo(target)) {
                    part.copyTo(target, overwrite = true)
                }
                target
            } finally {
                part.delete()
                downloaded.delete()
            }
        }
    }

    /**
     * An address the phone's player can stream an audio or video file from, with byte ranges and no
     * bearer: the contract's one-hour ticket for this one file (DECISIONS §90, §98), resolved against
     * the hub's origin.
     */
    suspend fun streamAddress(hub: String, profile: String, file: HubFile): String {
        val sessions = SessionsApi(apiBase(hub), client)
        val ticket = hubCall {
            when (file) {
                is HubFile.Attachment -> sessions.sessionsCreateAttachmentStream(xHubProfile = profile, attachmentId = file.id)
                is HubFile.Working -> sessions.sessionsCreateFileStream(profile, file.sessionId, SessionsCreateFileStreamRequest(path = file.path))
            }
        }.getOrThrow()
        return resolve(hub, ticket.url) ?: throw HubError(-1, "bad_address", ticket.url)
    }

    companion object {
        /** A name that stays inside its folder: no separators, never empty. */
        fun safeName(name: String, fallback: String): String =
            name.replace('/', '_').replace('\\', '_').replace(':', '_').trim().ifBlank { fallback }.takeLast(200)

        /** [url] (relative to the hub, or whole) as a whole address on the hub. */
        fun resolve(hub: String, url: String): String? = hub.toHttpUrlOrNull()?.resolve(url)?.toString()
    }
}

/** A body that tells how much of it has been read, and stops reading once [active] says so. */
private class CountingBody(
    private val body: ResponseBody,
    private val size: Long?,
    private val onProgress: (Progress) -> Unit,
    private val active: () -> Boolean,
) : ResponseBody() {
    override fun contentType(): MediaType? = body.contentType()
    override fun contentLength(): Long = body.contentLength()
    private val counted: BufferedSource by lazy {
        val total = body.contentLength().takeIf { it >= 0 } ?: size
        object : ForwardingSource(body.source()) {
            var read = 0L
            override fun read(sink: Buffer, byteCount: Long): Long {
                if (!active()) throw InterruptedIOException("download cancelled")
                val n = super.read(sink, byteCount)
                if (n > 0) read += n
                onProgress(Progress(read, total))
                return n
            }
        }.buffer()
    }
    override fun source(): BufferedSource = counted
}

/**
 * The downloads of a conversation's files, one per file, for the app's life: an inline picture and
 * a tap on it share one download, leaving the chat does not cut a large one short, and a person can
 * cancel it. [hub] is the signed-in hub's address; [profile] the file's conversation's profile.
 */
class FileDownloads(
    val fetcher: HubFileFetcher,
    private val hub: () -> String?,
    private val scope: kotlinx.coroutines.CoroutineScope,
) {
    sealed interface State {
        data object Idle : State
        data class Loading(val progress: Progress?) : State
        data class Ready(val file: File) : State

        /** [error] is the hub's own words when it sent some; null when the phone could not reach it. */
        data class Failed(val error: HubError) : State
    }

    private val _states = kotlinx.coroutines.flow.MutableStateFlow<Map<String, State>>(emptyMap())
    val states: kotlinx.coroutines.flow.StateFlow<Map<String, State>> = _states
    private val jobs = java.util.concurrent.ConcurrentHashMap<String, Job>()

    fun state(file: HubFile): State = _states.value[file.cacheKey]
        ?: fetcher.cached(file)?.let { State.Ready(it) }
        ?: State.Idle

    private fun set(key: String, state: State?) = _states.update { if (state == null) it - key else it + (key to state) }

    /** Starts fetching [file] unless it is here or on its way; the state says when it is ready. */
    fun start(file: HubFile, profile: String) {
        val key = file.cacheKey
        val now = state(file)
        if (now is State.Ready && now.file.isFile) return set(key, now)
        if (jobs[key]?.isActive == true) return
        val address = hub() ?: return set(key, State.Failed(HubError(401, "unauthorized", null)))
        set(key, State.Loading(null))
        var last = 0L
        jobs[key] = scope.launch {
            try {
                val local = fetcher.fetch(address, profile, file) { p ->
                    // At most every 64 KB, or the end: enough for a bar, not a storm of states.
                    if (p.read - last >= 65_536 || p.read == p.total) {
                        last = p.read
                        set(key, State.Loading(p))
                    }
                }
                set(key, State.Ready(local))
            } catch (e: CancellationException) {
                set(key, null)
                throw e
            } catch (e: HubError) {
                set(key, State.Failed(e))
            } catch (e: Throwable) {
                set(key, State.Failed(HubError.from(e)))
            } finally {
                jobs.remove(key)
            }
        }
    }

    /** Stops a download; the file goes back to not fetched. */
    fun cancel(file: HubFile) {
        jobs.remove(file.cacheKey)?.cancel()
        set(file.cacheKey, null)
    }

    /** The player's address for an audio or video file (a one-hour ticket), or why there is none. */
    suspend fun streamAddress(file: HubFile, profile: String): Result<String> {
        val address = hub() ?: return Result.failure(HubError(401, "unauthorized", null))
        return runCatching { fetcher.streamAddress(address, profile, file) }
    }
}

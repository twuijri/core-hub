package hub.core.android.ui.components

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import hub.core.android.R
import hub.core.android.chat.AttachmentRules
import hub.core.android.chat.ChatAttachment
import hub.core.android.chat.FileDownloads
import hub.core.android.chat.FileKinds
import hub.core.android.chat.FileLinks
import hub.core.android.chat.FileOpen
import hub.core.android.chat.HubFile
import hub.core.android.chat.HubFileFetcher
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.theme.LocalTokens
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The conversation a transcript shows, for links to the files of its working folder; null in a room. */
val LocalChatSession = staticCompositionLocalOf<String?> { null }

/** Pictures up to this size are fetched as soon as they are shown; a larger one waits for a tap. */
private const val AUTO_FETCH_BYTES = 20L * 1024 * 1024

/**
 * The files a message carries, under its words (owner, 2026-09-26: «كل ملف يفتح»). A picture is
 * drawn in place and opens full screen (pinch or double-tap to zoom, share, save, open in another
 * app); any other file is a row with its kind, name and size that opens it: in the phone's viewer
 * (PDF, text, documents), in its player (audio, video, streamed from a one-hour ticket), or the
 * share sheet for anything else. A download shows its progress and can be cancelled; a failure is
 * one line with a retry. The bytes come through the generated client with the bearer header.
 */
@Composable
fun MessageFiles(files: List<ChatAttachment>, profile: String) {
    if (files.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("message.attachments")) {
        files.forEach { a ->
            val file = HubFile.of(a)
            when {
                file == null -> FileRow(a.name ?: a.kind.value, a.mime, a.sizeBytes, FileDownloads.State.Idle, onClick = null)
                a.isImage -> PictureFile(file, profile)
                else -> OpenableFile(file, profile)
            }
        }
    }
}

/**
 * Opens a file of the hub the way its kind opens, fetching it first: the same path for a message's
 * file and for a reply's link to one ([FileLinkHandler]).
 */
class FileOpener(private val context: Context, private val downloads: FileDownloads, private val profile: String) {
    /** The picture shown full screen, with the file it is. */
    var viewing by mutableStateOf<Pair<File, HubFile>?>(null)
    private var pending by mutableStateOf<HubFile?>(null)

    fun open(file: HubFile, scope: CoroutineScope) {
        if (FileKinds.openAs(file) == FileOpen.MEDIA && downloads.state(file) !is FileDownloads.State.Ready) {
            // Played from a one-hour ticket with byte ranges, so a long recording starts at once.
            scope.launch {
                val address = downloads.streamAddress(file, profile).getOrNull()
                if (address == null || !AttachmentFiles.play(context, Uri.parse(address), FileKinds.mimeOf(file.name, file.mime))) fetchThenOpen(file)
            }
            return
        }
        fetchThenOpen(file)
    }

    private fun fetchThenOpen(file: HubFile) {
        when (val state = downloads.state(file)) {
            is FileDownloads.State.Ready -> show(state.file, file)
            else -> {
                pending = file
                downloads.start(file, profile)
            }
        }
    }

    /** Called as the downloads change: opens the file the person asked for once it is here. */
    fun settle(states: Map<String, FileDownloads.State>) {
        val want = pending ?: return
        when (val s = states[want.cacheKey]) {
            is FileDownloads.State.Ready -> {
                pending = null
                show(s.file, want)
            }
            is FileDownloads.State.Failed -> pending = null
            null -> pending = null
            else -> {}
        }
    }

    private fun show(local: File, file: HubFile) {
        val ok = when (FileKinds.openAs(file)) {
            FileOpen.PICTURE -> {
                viewing = local to file
                true
            }
            FileOpen.VIEWER, FileOpen.MEDIA -> AttachmentFiles.open(context, local, file.mime)
            FileOpen.SHARE -> AttachmentFiles.share(context, local, file.mime)
        }
        if (!ok) Toast.makeText(context, context.getString(R.string.attach_open_failed), Toast.LENGTH_LONG).show()
    }
}

@Composable
private fun rememberOpener(profile: String): FileOpener {
    val context = LocalContext.current
    val downloads = context.graph.files
    val opener = remember(profile) { FileOpener(context, downloads, profile) }
    val states by downloads.states.collectAsState()
    LaunchedEffect(states) { opener.settle(states) }
    opener.viewing?.let { (local, file) -> ImageViewer(local, file) { opener.viewing = null } }
    return opener
}

/** A picture: drawn once its bytes are here; a row with its progress until then, or when it cannot be drawn. */
@Composable
private fun PictureFile(file: HubFile, profile: String) {
    val context = LocalContext.current
    val downloads = context.graph.files
    val scope = rememberCoroutineScope()
    val opener = rememberOpener(profile)
    val states by downloads.states.collectAsState()
    val state = states[file.cacheKey] ?: downloads.state(file)
    LaunchedEffect(file.cacheKey) {
        if ((file.sizeBytes ?: 0) <= AUTO_FETCH_BYTES) downloads.start(file, profile)
    }
    var picture by remember(file.cacheKey) { mutableStateOf<ImageBitmap?>(null) }
    var undrawable by remember(file.cacheKey) { mutableStateOf(false) }
    val ready = (state as? FileDownloads.State.Ready)?.file
    LaunchedEffect(ready) {
        if (ready == null) return@LaunchedEffect
        val decoded = withContext(Dispatchers.IO) { AttachmentFiles.decode(ready, 1080) }
        if (decoded == null) undrawable = true else picture = decoded
    }
    val bitmap = picture
    if (bitmap != null && ready != null) {
        Image(
            bitmap = bitmap,
            contentDescription = stringResource(R.string.attach_open, file.name),
            contentScale = ContentScale.Fit,
            modifier = Modifier.widthIn(max = 260.dp).heightIn(max = 260.dp).clip(RoundedCornerShape(12.dp))
                .clickable { opener.viewing = ready to file }.testTag("message.image"),
        )
        return
    }
    val failed = stringResource(R.string.attach_open_failed)
    FileRow(
        file.name, file.mime, file.sizeBytes, if (undrawable) FileDownloads.State.Idle else state,
        onCancel = { downloads.cancel(file) },
        onClick = {
            // A picture the phone cannot draw still opens, in whatever app can.
            if (undrawable && ready != null) {
                if (!AttachmentFiles.open(context, ready, file.mime)) Toast.makeText(context, failed, Toast.LENGTH_LONG).show()
            } else {
                opener.open(file, scope)
            }
        },
    )
}

/** Any other file: a row that opens it. */
@Composable
private fun OpenableFile(file: HubFile, profile: String) {
    val context = LocalContext.current
    val downloads = context.graph.files
    val scope = rememberCoroutineScope()
    val opener = rememberOpener(profile)
    val states by downloads.states.collectAsState()
    val state = states[file.cacheKey] ?: FileDownloads.State.Idle
    FileRow(file.name, file.mime, file.sizeBytes, state, onCancel = { downloads.cancel(file) }) { opener.open(file, scope) }
}

/**
 * One file as a row: its kind's icon, its name (the middle elided), and under it its size, how much
 * has arrived, or why it failed, in one line. While it downloads the trailing button cancels it;
 * after a failure it tries again.
 */
@Composable
fun FileRow(
    name: String,
    mime: String?,
    size: Long?,
    state: FileDownloads.State,
    onCancel: () -> Unit = {},
    onClick: (() -> Unit)?,
) {
    val t = LocalTokens.current
    val label = stringResource(R.string.attach_open, name)
    val loading = state as? FileDownloads.State.Loading
    val failed = state as? FileDownloads.State.Failed
    val detail = when {
        loading != null -> loading.progress?.let { p ->
            val fraction = p.fraction
            if (fraction != null && p.total != null) {
                stringResource(R.string.files_progress, (fraction * 100).toInt(), AttachmentRules.sizeText(p.read), AttachmentRules.sizeText(p.total))
            } else {
                AttachmentRules.sizeText(p.read)
            }
        } ?: stringResource(R.string.files_fetching)
        failed != null -> fileError(failed.error)
        size != null -> AttachmentRules.sizeText(size)
        else -> null
    }
    Column(
        Modifier.widthIn(min = 200.dp, max = 320.dp).clip(RoundedCornerShape(10.dp)).background(t.surface2)
            .let { if (onClick != null && loading == null) it.clickable(onClickLabel = label, onClick = onClick) else it }
            .padding(start = 10.dp, end = 4.dp, top = 6.dp, bottom = 6.dp)
            .testTag("message.file"),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LucideIcon(kindIcon(name, mime), null, size = 18.dp, tint = if (failed != null) t.danger else t.textMuted)
            Column(Modifier.weight(1f)) {
                Text(name, fontSize = FontTokens.sizeSm.sp, color = t.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                detail?.let {
                    Text(
                        it, fontSize = FontTokens.sizeXs.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (failed != null) t.danger else t.textMuted,
                        modifier = Modifier.testTag(if (failed != null) "message.file.error" else "message.file.detail"),
                    )
                }
            }
            when {
                loading != null -> Box(contentAlignment = Alignment.Center) {
                    Spinner(28.dp, t.textFaint)
                    HubIconButton(
                        Lucide.X, stringResource(R.string.files_cancel), onCancel, size = 32.dp, iconSize = 14.dp,
                        modifier = Modifier.testTag("message.file.cancel"),
                    )
                }
                failed != null && onClick != null ->
                    HubIconButton(Lucide.RotateCcw, stringResource(R.string.files_retry), onClick, size = 32.dp, iconSize = 16.dp)
                else -> Box(Modifier.size(8.dp))
            }
        }
        loading?.progress?.fraction?.let { f ->
            Box(Modifier.padding(top = 4.dp, end = 6.dp).fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(t.surface3)) {
                Box(Modifier.fillMaxWidth(f).height(3.dp).background(t.accent))
            }
        }
    }
}

@Composable
private fun fileError(error: HubError): String = when {
    error.offline -> stringResource(R.string.files_offline)
    error.status == 404 -> stringResource(R.string.files_gone)
    error.status == 413 -> stringResource(R.string.files_too_large)
    else -> error.text?.takeIf { it.isNotBlank() } ?: stringResource(R.string.attach_open_failed)
}

private fun kindIcon(name: String, mime: String?): Int {
    val type = FileKinds.mimeOf(name, mime)
    return when {
        type.startsWith("image/") -> Lucide.Image
        type.startsWith("audio/") -> Lucide.Music
        type.startsWith("video/") -> Lucide.Film
        FileKinds.openAs(name, mime) == FileOpen.VIEWER -> Lucide.FileText
        else -> Lucide.File
    }
}

/**
 * Links in a reply that name one of the conversation's files open it as its row does (web:
 * `Markdown.tsx`, decision §48); any other link opens in the browser, and one that no app can open
 * says so instead of doing nothing. The conversation's file list is read only when a link needs it.
 */
@Composable
fun FileLinkHandler(own: List<ChatAttachment>, profile: String, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val system = LocalUriHandler.current
    val session = LocalChatSession.current
    val scope = rememberCoroutineScope()
    val opener = rememberOpener(profile)
    val failed = stringResource(R.string.files_link_failed)
    val handler = remember(own, profile, session, system, failed) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val hub = context.graph.store.current?.hub.orEmpty()
                FileLinks.resolve(uri, hub, own)?.let { return opener.open(it, scope) }
                if (FileLinks.wordOf(uri, hub) == null || session == null) return browse(uri)
                scope.launch {
                    val signed = context.graph.store.current
                    val list = signed?.let { s ->
                        hubCall { context.graph.apis(s).sessions.sessionsListFiles(profile.ifBlank { s.profile }, session) }.getOrNull()?.items
                    }
                    val file = FileLinks.resolve(uri, hub, own, list, session)
                    if (file != null) opener.open(file, scope) else browse(uri)
                }
            }

            private fun browse(uri: String) {
                if (runCatching { system.openUri(uri) }.isFailure) Toast.makeText(context, failed, Toast.LENGTH_LONG).show()
            }
        }
    }
    CompositionLocalProvider(LocalUriHandler provides handler, content = content)
}

/** A picture full screen: pinch or double-tap to zoom, drag to look around, save, open elsewhere, share, close. */
@Composable
private fun ImageViewer(local: File, file: HubFile, onClose: () -> Unit) {
    val context = LocalContext.current
    var bitmap by remember(local) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(local) { bitmap = withContext(Dispatchers.IO) { AttachmentFiles.decode(local, 2560) } }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val saved = stringResource(R.string.files_saved)
    val notSaved = stringResource(R.string.files_save_failed)
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).testTag("message.image.viewer")) {
            bitmap?.let {
                Image(
                    it, contentDescription = file.name, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize()
                        .pointerInput(Unit) {
                            detectTapGestures(onDoubleTap = {
                                scale = if (scale > 1f) 1f else 2.5f
                                offset = Offset.Zero
                            })
                        }
                        .pointerInput(Unit) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(1f, 5f)
                                offset = if (scale == 1f) Offset.Zero else offset + pan
                            }
                        }
                        .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                )
            } ?: Spinner(28.dp, Color.White, Modifier.align(Alignment.Center))
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                HubIconButton(Lucide.X, stringResource(R.string.close), onClose, kind = IconKind.Glass)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        HubIconButton(Lucide.Download, stringResource(R.string.files_save), {
                            val ok = AttachmentFiles.save(context, local, file.name, file.mime)
                            Toast.makeText(context, if (ok) saved else notSaved, Toast.LENGTH_SHORT).show()
                        }, kind = IconKind.Glass)
                    }
                    HubIconButton(Lucide.ExternalLink, stringResource(R.string.files_open_with), { AttachmentFiles.open(context, local, file.mime) }, kind = IconKind.Glass)
                    HubIconButton(Lucide.Share2, stringResource(R.string.attach_share), { AttachmentFiles.share(context, local, file.mime) }, kind = IconKind.Glass)
                }
            }
            Text(
                file.name, color = Color.White, fontSize = FontTokens.sizeSm.sp, maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp),
            )
        }
    }
}

/** What the phone does with a file once it is here: its viewer, its player, the share sheet, the gallery. */
object AttachmentFiles {
    /** Where a file is kept: a folder per file, the file under its own name, never a path out of it. */
    fun place(root: File, id: String, name: String?): File = File(File(root, id), HubFileFetcher.safeName(name.orEmpty(), id))

    /** A picture no larger than [max] pixels on its longer side. */
    fun decode(file: File, max: Int): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= max) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }

    private fun uri(context: Context, file: File) = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)

    /** Opens the file in the app the phone has for it; the share sheet when none. */
    fun open(context: Context, file: File, mime: String?): Boolean {
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri(context, file), FileKinds.mimeOf(file.name, mime))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(view)
            true
        } catch (_: ActivityNotFoundException) {
            share(context, file, mime)
        }
    }

    /** Plays an audio or video address in the phone's player; false when it has none. */
    fun play(context: Context, address: Uri, mime: String): Boolean = try {
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(address, mime).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }

    fun share(context: Context, file: File, mime: String?): Boolean {
        val send = Intent(Intent.ACTION_SEND).setType(FileKinds.mimeOf(file.name, mime))
            .putExtra(Intent.EXTRA_STREAM, uri(context, file))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return try {
            context.startActivity(Intent.createChooser(send, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    /** A copy in the phone's Pictures (a picture) or Downloads (anything else), in the app's own folder. Android 10+. */
    fun save(context: Context, file: File, name: String, mime: String?): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val type = FileKinds.mimeOf(name, mime)
        val picture = type.startsWith("image/")
        val folder = context.getString(R.string.app_name)
        val collection = if (picture) {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, type)
            put(MediaStore.MediaColumns.RELATIVE_PATH, (if (picture) "Pictures/" else "Download/") + folder)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val item = runCatching { resolver.insert(collection, values) }.getOrNull() ?: return false
        return runCatching {
            resolver.openOutputStream(item)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
            resolver.update(item, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            true
        }.getOrElse {
            resolver.delete(item, null, null)
            false
        }
    }
}

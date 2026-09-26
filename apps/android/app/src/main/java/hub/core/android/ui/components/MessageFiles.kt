package hub.core.android.ui.components

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import hub.core.android.R
import hub.core.android.chat.ChatAttachment
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.ui.theme.LocalTokens
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The files a message carries, under its words (web: the message's attachment row, #154): a
 * picture is drawn in place, anything else is its name. A tap on a picture opens it full screen
 * (pinch to zoom, share); a tap on another file opens it in the app the phone has for it, or the
 * share sheet. The bytes come with the bearer header (`sessions.downloadAttachment`).
 */
@Composable
fun MessageFiles(files: List<ChatAttachment>, profile: String) {
    if (files.isEmpty()) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var viewing by remember { mutableStateOf<Pair<File, ChatAttachment>?>(null) }
    var opening by remember { mutableStateOf<String?>(null) }
    val failed = stringResource(R.string.attach_open_failed)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("message.attachments")) {
        files.forEach { file ->
            if (file.isImage) {
                InlineImage(file, profile) { viewing = it to file }
            } else {
                FileChip(file, busy = opening == file.attachmentId) {
                    val id = file.attachmentId ?: return@FileChip
                    opening = id
                    scope.launch {
                        val local = AttachmentFiles.fetch(context, id, file.name, profile)
                        opening = null
                        if (local == null || !AttachmentFiles.open(context, local, file.mime)) {
                            Toast.makeText(context, failed, Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }
    }
    viewing?.let { (local, file) -> ImageViewer(local, file) { viewing = null } }
}

@Composable
private fun FileChip(file: ChatAttachment, busy: Boolean = false, onClick: (() -> Unit)?) {
    val t = LocalTokens.current
    val name = file.name ?: file.kind.value
    val label = stringResource(R.string.attach_open, name)
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).background(t.surface2)
            .let { if (onClick != null) it.clickable(onClickLabel = label, onClick = onClick) else it }
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        } else {
            Icon(
                painterResource(if (file.kind == hub.core.client.model.ContentBlock.Type.IMAGE) R.drawable.lucide_image else R.drawable.lucide_file_text),
                null, Modifier.size(14.dp), tint = t.textMuted,
            )
        }
        Text(name, style = MaterialTheme.typography.bodySmall, color = t.textMuted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
    }
}

/** A picture on a message, drawn once its bytes are here; its name until then, or if they cannot be fetched. */
@Composable
private fun InlineImage(file: ChatAttachment, profile: String, onOpen: (File) -> Unit) {
    val context = LocalContext.current
    var loaded by remember(file.attachmentId) { mutableStateOf<Pair<File, ImageBitmap>?>(null) }
    LaunchedEffect(file.attachmentId) {
        val id = file.attachmentId ?: return@LaunchedEffect
        val local = AttachmentFiles.fetch(context, id, file.name, profile) ?: return@LaunchedEffect
        loaded = withContext(Dispatchers.IO) { AttachmentFiles.decode(local, 1080)?.let { local to it } }
    }
    val shown = loaded
    if (shown == null) {
        FileChip(file, onClick = null)
        return
    }
    val name = file.name ?: file.kind.value
    Image(
        bitmap = shown.second,
        contentDescription = stringResource(R.string.attach_open, name),
        contentScale = ContentScale.Fit,
        modifier = Modifier.widthIn(max = 260.dp).heightIn(max = 260.dp).clip(RoundedCornerShape(12.dp))
            .clickable { onOpen(shown.first) }.testTag("message.image"),
    )
}

/** A picture full screen: pinch to zoom, drag to look around, share, close. */
@Composable
private fun ImageViewer(local: File, file: ChatAttachment, onClose: () -> Unit) {
    val context = LocalContext.current
    var bitmap by remember(local) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(local) { bitmap = withContext(Dispatchers.IO) { AttachmentFiles.decode(local, 2560) } }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).testTag("message.image.viewer")) {
            bitmap?.let {
                Image(
                    it, contentDescription = file.name, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize()
                        .pointerInput(Unit) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(1f, 5f)
                                offset = if (scale == 1f) Offset.Zero else offset + pan
                            }
                        }
                        .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                )
            } ?: CircularProgressIndicator(Modifier.align(Alignment.Center))
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                IconButton(onClick = onClose) { Icon(Icons.Default.Close, stringResource(R.string.close), tint = Color.White) }
                IconButton(onClick = { AttachmentFiles.share(context, local, file.mime) }) {
                    Icon(Icons.Default.Share, stringResource(R.string.attach_share), tint = Color.White)
                }
            }
        }
    }
}

/**
 * The files of messages, fetched once and kept in the app's cache under their own names; shared
 * with other apps through the app's FileProvider.
 */
object AttachmentFiles {
    /** Where a file is kept: a folder per attachment, the file under its own name, never a path out of it. */
    fun place(root: File, id: String, name: String?): File {
        val safe = (name ?: "").replace('/', '_').replace('\\', '_').replace(':', '_').ifBlank { id }
        return File(File(root, id), safe)
    }

    suspend fun fetch(context: Context, id: String, name: String?, profile: String): File? = withContext(Dispatchers.IO) {
        val target = place(File(context.cacheDir, "attachments"), id, name)
        if (target.isFile && target.length() > 0) return@withContext target
        val graph = context.graph
        val session = graph.store.current ?: return@withContext null
        val scope = profile.ifBlank { session.profile }
        val downloaded = hubCall {
            graph.apis(session).sessions.sessionsDownloadAttachment(xHubProfile = scope, attachmentId = id)
        }.getOrNull() ?: return@withContext null
        runCatching {
            target.parentFile?.mkdirs()
            downloaded.copyTo(target, overwrite = true)
            downloaded.delete()
            target
        }.getOrNull()
    }

    /** A picture no larger than [max] pixels on its longer side. */
    fun decode(file: File, max: Int): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= max) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }

    /** The file's type: the one the hub gave, else its extension's. */
    fun mimeOf(file: File, mime: String?): String =
        mime?.takeIf { it.isNotBlank() }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
            ?: "application/octet-stream"

    private fun uri(context: Context, file: File) = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)

    /** Opens the file in the app the phone has for it; the share sheet when none. */
    fun open(context: Context, file: File, mime: String?): Boolean {
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri(context, file), mimeOf(file, mime))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(view)
            true
        } catch (_: ActivityNotFoundException) {
            share(context, file, mime)
        }
    }

    fun share(context: Context, file: File, mime: String?): Boolean {
        val send = Intent(Intent.ACTION_SEND).setType(mimeOf(file, mime))
            .putExtra(Intent.EXTRA_STREAM, uri(context, file))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return try {
            context.startActivity(Intent.createChooser(send, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }
}

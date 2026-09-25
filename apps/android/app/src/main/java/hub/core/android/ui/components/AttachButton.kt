package hub.core.android.ui.components

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.graphics.scale
import hub.core.android.R
import hub.core.android.graph
import hub.core.android.chat.AttachmentRules
import hub.core.android.chat.AttachmentTray
import hub.core.android.ui.theme.LocalTokens
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Reading what the person picked into files the tray can upload; photos made smaller on the way. */
object PickedFiles {
    private fun folder(context: Context): File =
        File(context.cacheDir, "outgoing/${UUID.randomUUID()}").apply { mkdirs() }

    private fun stamp() = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

    /** A file (any kind) under its own name, or null when it cannot be read. */
    fun copy(context: Context, uri: Uri, fallbackName: String? = null): File? = runCatching {
        val name = displayName(context, uri) ?: fallbackName ?: "file-${stamp()}"
        val target = File(folder(context), name.replace('/', '_'))
        context.contentResolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it) } }
            ?: return null
        target
    }.getOrNull()

    fun displayName(context: Context, uri: Uri): String? =
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    /**
     * A photo at original quality: its own bytes, untouched (HEIC, JPEG or PNG at full size, with
     * its orientation and metadata as the photo picker hands them over).
     */
    fun original(context: Context, uri: Uri): File? {
        val ext = context.contentResolver.getType(uri)?.substringAfter('/')?.let { if (it == "jpeg") "jpg" else it } ?: "jpg"
        return copy(context, uri, "photo-${stamp()}.$ext")
    }

    /** A small picture of a photo for its chip. */
    fun thumbnail(file: File): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 96) sample *= 2
        BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()

    /** A photo as the JPEG the hub receives: the longer side at most 2048 px, quality 80, upright. */
    fun photo(context: Context, uri: Uri): Pair<File, Bitmap>? = runCatching {
        val bitmap = decode(context, uri) ?: return null
        val target = File(folder(context), "photo-${stamp()}.jpg")
        target.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, AttachmentRules.PHOTO_QUALITY, it) }
        val thumb = bitmap.scale(96, (96f * bitmap.height / bitmap.width).toInt().coerceAtLeast(1))
        if (thumb !== bitmap) bitmap.recycle()
        target to thumb
    }.getOrNull()

    private fun decode(context: Context, uri: Uri): Bitmap? {
        if (Build.VERSION.SDK_INT >= 28) {
            // ImageDecoder turns the photo upright (EXIF) and decodes straight to the smaller size.
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val (w, h) = AttachmentRules.fitted(info.size.width, info.size.height)
                decoder.setTargetSize(w, h)
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= AttachmentRules.PHOTO_MAX_SIDE) sample *= 2
        val decoded = context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: return null
        val (w, h) = AttachmentRules.fitted(decoded.width, decoded.height)
        return if (w == decoded.width) decoded else decoded.scale(w, h)
    }

    /** Where the camera writes its photo: the app's cache, shared through the FileProvider. */
    fun cameraTarget(context: Context): Uri {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "camera-${stamp()}.jpg")
        return FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
    }
}

/** The «+» button: photo library (the system's photo picker), camera, or a file. */
@Composable
fun AttachButton(tray: AttachmentTray) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var cameraUri by rememberSaveable { mutableStateOf<Uri?>(null) }

    val choices by context.graph.device.choices.collectAsState()

    // «Compressed» or «Original quality», as the + menu says (remembered on This device).
    fun addPhoto(uri: Uri) = scope.launch {
        if (context.graph.device.choices.value.photoOriginal) {
            val file = withContext(Dispatchers.IO) { PickedFiles.original(context, uri) }
            if (file == null) tray.addUnreadable(PickedFiles.displayName(context, uri) ?: "photo")
            else tray.add(file, isImage = true, preview = withContext(Dispatchers.IO) { PickedFiles.thumbnail(file) }, asFile = true)
            return@launch
        }
        val picked = withContext(Dispatchers.IO) { PickedFiles.photo(context, uri) }
        if (picked == null) tray.addUnreadable(PickedFiles.displayName(context, uri) ?: "photo")
        else tray.add(picked.first, isImage = true, preview = picked.second)
    }

    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { uris ->
        uris.forEach { addPhoto(it) }
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val uri = cameraUri
        cameraUri = null
        if (taken && uri != null) addPhoto(uri)
    }
    // The app declares CAMERA (the pairing scanner), so Android asks before another app's camera
    // may take a picture for it.
    val cameraDenied = stringResource(R.string.attach_camera_denied)
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) PickedFiles.cameraTarget(context).also { cameraUri = it; camera.launch(it) }
        else Toast.makeText(context, cameraDenied, Toast.LENGTH_LONG).show()
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { uri ->
            scope.launch {
                val file = withContext(Dispatchers.IO) { PickedFiles.copy(context, uri) }
                if (file == null) {
                    tray.addUnreadable(PickedFiles.displayName(context, uri) ?: "file")
                } else {
                    val isImage = context.contentResolver.getType(uri)?.startsWith("image/") == true
                    tray.add(file, isImage = isImage)
                }
            }
        }
    }

    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("composer.attach")) {
            Icon(painterResource(R.drawable.lucide_plus), stringResource(R.string.attach_add), tint = t.textMuted, modifier = Modifier.size(22.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            // Telegram's choice for photos: compressed, or the original file.
            Text(
                stringResource(R.string.attach_photo_quality),
                style = MaterialTheme.typography.labelMedium, color = t.textMuted,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
            listOf(false to R.string.attach_compressed, true to R.string.attach_original).forEach { (original, label) ->
                DropdownMenuItem(
                    text = { Text(stringResource(label)) },
                    leadingIcon = { RadioButton(selected = choices.photoOriginal == original, onClick = null) },
                    onClick = { context.graph.device.update { it.copy(photoOriginal = original) } },
                    modifier = Modifier.testTag(if (original) "composer.photo_original" else "composer.photo_compressed"),
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text(stringResource(R.string.attach_photo)) },
                leadingIcon = { Icon(painterResource(R.drawable.lucide_image), null, modifier = Modifier.size(20.dp)) },
                onClick = {
                    open = false
                    photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
            )
            if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.attach_camera)) },
                    leadingIcon = { Icon(painterResource(R.drawable.lucide_camera), null, modifier = Modifier.size(20.dp)) },
                    onClick = {
                        open = false
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            PickedFiles.cameraTarget(context).also { cameraUri = it; camera.launch(it) }
                        } else {
                            cameraPermission.launch(Manifest.permission.CAMERA)
                        }
                    },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.attach_file)) },
                leadingIcon = { Icon(painterResource(R.drawable.lucide_file_text), null, modifier = Modifier.size(20.dp)) },
                onClick = {
                    open = false
                    files.launch(arrayOf("*/*"))
                },
            )
        }
    }
}

/** The chips above the composer: a preview (or the file's icon), the name, and ×. */
@Composable
fun AttachmentChips(items: List<AttachmentTray.Item>, onRemove: (String) -> Unit, modifier: Modifier = Modifier) {
    if (items.isEmpty()) return
    val t = LocalTokens.current
    Row(
        modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp).testTag("composer.attachments"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items.forEach { item ->
            Row(
                Modifier.background(t.surface, RoundedCornerShape(12.dp)).border(1.dp, t.border, RoundedCornerShape(12.dp)).padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)).background(t.surface2), contentAlignment = Alignment.Center) {
                    val bitmap = item.preview as? Bitmap
                    if (bitmap != null) {
                        Image(bitmap.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = Modifier.size(36.dp))
                    } else {
                        Icon(painterResource(if (item.isImage) R.drawable.lucide_image else R.drawable.lucide_file_text), null, tint = t.textMuted, modifier = Modifier.size(18.dp))
                    }
                    if (item.state == AttachmentTray.State.Uploading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
                Column(Modifier.widthIn(max = 160.dp)) {
                    Text(item.name, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    (item.state as? AttachmentTray.State.Failed)?.let { failed ->
                        Text(
                            when {
                                failed.tooLarge -> stringResource(R.string.attach_too_large, AttachmentRules.sizeText(failed.error?.maxBytes ?: AttachmentRules.MAX_BYTES))
                                failed.error != null -> errorText(failed.error)
                                else -> stringResource(R.string.attach_unreadable)
                            },
                            style = MaterialTheme.typography.labelSmall, color = t.dangerSoftText, maxLines = 2,
                        )
                    }
                }
                IconButton(onClick = { onRemove(item.id) }, modifier = Modifier.size(28.dp)) {
                    Icon(painterResource(R.drawable.lucide_x), stringResource(R.string.attach_remove, item.name), tint = t.textMuted, modifier = Modifier.size(14.dp))
                }
            }
        }
    }
}

package us.i3u.hermesstudio.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * One attachment action: the Core Hub line icon, the label, a one-line caption
 * saying what the row actually opens, and the picker it launches.
 */
internal data class AttachmentAction(
    val icon: ImageVector,
    val label: String,
    val caption: String,
    val onPick: () -> Unit,
)

/** A titled block of actions inside the sheet. */
internal data class AttachmentGroup(val title: String, val actions: List<AttachmentAction>)

/**
 * What the "+" offers, in the web client's order.
 *
 * The web composer has one "Attach files" control (`ChatInput.vue`, the same
 * 24-viewBox plus icon); on a phone that one control splits into the camera,
 * the photo library and the file picker. The wording is the web's, and the
 * two mobile clients carry the same rows in the same order.
 */
@Composable
internal fun attachmentGroups(
    onCamera: () -> Unit,
    onGallery: () -> Unit,
    onFile: () -> Unit,
): List<AttachmentGroup> = listOf(
    AttachmentGroup(
        title = stringResource(R.string.attach_group_photos),
        actions = listOf(
            AttachmentAction(
                icon = CoreHubIcons.Camera,
                label = stringResource(R.string.sheet_camera),
                caption = stringResource(R.string.attach_camera_caption),
                onPick = onCamera,
            ),
            AttachmentAction(
                icon = CoreHubIcons.Image,
                label = stringResource(R.string.sheet_gallery),
                caption = stringResource(R.string.attach_gallery_caption),
                onPick = onGallery,
            ),
        ),
    ),
    AttachmentGroup(
        title = stringResource(R.string.attach_group_documents),
        actions = listOf(
            AttachmentAction(
                icon = CoreHubIcons.Paperclip,
                label = stringResource(R.string.sheet_file),
                caption = stringResource(R.string.attach_file_caption),
                onPick = onFile,
            ),
        ),
    ),
)

/**
 * The composer's attachment sheet: a modal bottom sheet with a drag handle, a
 * title block, grouped full-width rows (icon tile, label, caption, chevron)
 * and a Close button — instead of the cramped dropdown anchored to the "+".
 *
 * The sheet closes with its own animation before the picker is launched, so
 * the camera or the document picker never opens behind a sheet that is still
 * sliding away. Everything mirrors in Arabic: the rows are laid out in
 * start/end terms and the chevron auto-mirrors.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AttachmentSheet(
    onDismiss: () -> Unit,
    onCamera: () -> Unit,
    onGallery: () -> Unit,
    onFile: () -> Unit,
) {
    val palette = CoreHub.palette
    // A sheet is its own window; carry the app's direction into it explicitly
    // so an Arabic layout stays mirrored inside.
    val direction = LocalLayoutDirection.current
    val sheetState = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    val groups = attachmentGroups(onCamera = onCamera, onGallery = onGallery, onFile = onFile)

    fun close(then: () -> Unit = {}) {
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            onDismiss()
            then()
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = RoundedCornerShape(
            topStart = CoreHubTokens.Radius.composer,
            topEnd = CoreHubTokens.Radius.composer,
        ),
        containerColor = palette.bgCard,
        contentColor = palette.textPrimary,
        tonalElevation = 0.dp,
        scrimColor = Color.Black.copy(alpha = CoreHubTokens.Metrics.scrimAlpha),
        dragHandle = { AttachmentSheetHandle() },
    ) {
        CompositionLocalProvider(LocalLayoutDirection provides direction) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(bottom = CoreHubTokens.Metrics.sheetPadding),
            ) {
                AttachmentSheetHeader()
                groups.forEachIndexed { index, group ->
                    if (index > 0) {
                        HorizontalDivider(
                            modifier = Modifier.padding(
                                horizontal = CoreHubTokens.Metrics.sheetPadding,
                                vertical = 6.dp,
                            ),
                            color = palette.borderLight,
                        )
                    }
                    AttachmentGroupHeader(group.title)
                    group.actions.forEach { action ->
                        AttachmentRow(action) { close(action.onPick) }
                    }
                }
                CloseSheetButton { close() }
            }
        }
    }
}

/** The 36 × 4 handle, accent at the idle input-border strength. */
@Composable
private fun AttachmentSheetHandle() {
    val palette = CoreHub.palette
    Box(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .width(CoreHubTokens.Metrics.sheetHandleWidth)
                .height(CoreHubTokens.Metrics.sheetHandleHeight)
                .background(palette.inputBorder, RoundedCornerShape(CoreHubTokens.Radius.pill)),
        )
    }
}

/** Title 16/600 and a muted line saying what the sheet is for. */
@Composable
private fun AttachmentSheetHeader() {
    val palette = CoreHub.palette
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = CoreHubTokens.Metrics.sheetPadding)
            .padding(bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            stringResource(R.string.attach_sheet_title),
            style = MaterialTheme.typography.titleLarge.copy(textDirection = TextDirection.Content),
            color = palette.textPrimary,
        )
        Text(
            stringResource(R.string.attach_sheet_subtitle),
            style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
            color = palette.textMuted,
        )
    }
}

/** Group label: 10/600 uppercase with the spec's letter-spacing. */
@Composable
private fun AttachmentGroupHeader(title: String) {
    val palette = CoreHub.palette
    Text(
        title.uppercase(),
        style = CoreHubTextStyles.groupHeader.copy(textDirection = TextDirection.Content),
        color = palette.textMuted,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = CoreHubTokens.Metrics.sheetPadding)
            .padding(top = 14.dp, bottom = 6.dp),
    )
}

/** One action row: icon tile, label over caption, trailing chevron. */
@Composable
private fun AttachmentRow(action: AttachmentAction, onClick: () -> Unit) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = CoreHubTokens.Metrics.sheetRowMinHeight)
            .clickable(onClick = onClick)
            .padding(horizontal = CoreHubTokens.Metrics.sheetPadding, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(CoreHubTokens.Metrics.sheetRowGap),
    ) {
        Box(
            modifier = Modifier
                .size(CoreHubTokens.Metrics.sheetIconTile)
                .background(palette.hover, RoundedCornerShape(CoreHubTokens.Radius.bubble))
                .border(1.dp, palette.borderLight, RoundedCornerShape(CoreHubTokens.Radius.bubble)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                action.icon,
                contentDescription = null,
                tint = palette.textPrimary,
                modifier = Modifier.size(CoreHubTokens.Metrics.sheetIcon),
            )
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                action.label,
                style = MaterialTheme.typography.titleMedium.copy(textDirection = TextDirection.Content),
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                action.caption,
                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
                color = palette.textMuted,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            CoreHubIcons.ChevronRight,
            contentDescription = null,
            tint = palette.textMuted,
            modifier = Modifier.size(CoreHubTokens.Metrics.sheetTrailingIcon),
        )
    }
}

/** The explicit way out, next to the handle and the scrim. */
@Composable
private fun CloseSheetButton(onClick: () -> Unit) {
    val palette = CoreHub.palette
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = CoreHubTokens.Metrics.sheetPadding)
            .padding(top = 14.dp)
            .height(CoreHubTokens.Metrics.sheetButtonHeight)
            .border(1.dp, palette.border, RoundedCornerShape(CoreHubTokens.Radius.small))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            stringResource(R.string.action_close),
            style = MaterialTheme.typography.titleMedium,
            color = palette.textSecondary,
        )
    }
}

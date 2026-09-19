package us.i3u.hermesstudio.ui.chat

import android.Manifest
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.ModelTraining
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import java.io.File
import java.util.Locale
import kotlinx.coroutines.delay
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.ContentDirectionBox
import us.i3u.hermesstudio.DetectionBlock
import us.i3u.hermesstudio.DictationHint
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.Store
import us.i3u.hermesstudio.chatProfile
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.SpeechLanguageOption
import us.i3u.hermesstudio.SpeechLanguages
import us.i3u.hermesstudio.VoiceOutput
import us.i3u.hermesstudio.VoiceSegmentKind
import us.i3u.hermesstudio.VoiceStatus
import us.i3u.hermesstudio.applyVoiceSegment
import us.i3u.hermesstudio.detectionReasonRes
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * The composer per DESIGN-SPEC: a radius-18 card at least 150 dp tall with the
 * context indicator top-end, a borderless 16 sp textarea (dir=auto, never
 * auto-focused), attachment chips with upload progress, and the toolbar
 * [+ attach] [🧠 reasoning] [⚙ settings] [model] … [mic 30] [send 30 / stop].
 * Below ~380 dp the pill labels collapse to icons.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
internal fun Composer(
    state: UiState,
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    viewModel: AppViewModel,
) {
    val context = LocalContext.current
    val palette = CoreHub.palette
    var sheet by remember { mutableStateOf<ComposerSheet?>(null) }
    var captureUri by remember { mutableStateOf<Uri?>(null) }
    var fieldFocused by remember { mutableStateOf(false) }
    var attachMenu by remember { mutableStateOf(false) }
    var settingsMenu by remember { mutableStateOf(false) }
    var speechLanguageSheet by remember { mutableStateOf(false) }

    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { readAndAttach(context, it, viewModel) }
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { readAndAttach(context, it, viewModel) }
    }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val uri = captureUri
        captureUri = null
        if (saved && uri != null) readAndAttach(context, uri, viewModel, fallbackName = "photo.jpg")
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            val uri = newCaptureUri(context)
            captureUri = uri
            takePhoto.launch(uri)
        }
    }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) viewModel.startVoiceInput() else viewModel.reportMicrophoneDenied()
    }
    // The field keeps its own selection so dictation can land at the caret and
    // an interim hypothesis can be replaced in place while the user speaks.
    var field by remember { mutableStateOf(TextFieldValue(draft, TextRange(draft.length))) }
    LaunchedEffect(draft) {
        if (field.text != draft) field = TextFieldValue(draft, TextRange(draft.length))
    }
    var voiceAnchor by remember { mutableStateOf<Int?>(null) }
    var voiceLength by remember { mutableStateOf(0) }
    LaunchedEffect(state.voiceSegment) {
        val segment = state.voiceSegment ?: return@LaunchedEffect
        val anchor = voiceAnchor ?: field.selection.end.coerceIn(0, field.text.length)
        val edit = applyVoiceSegment(field.text, anchor, voiceLength, segment.text, segment.kind)
        field = TextFieldValue(edit.text, TextRange(edit.caret))
        onDraftChange(edit.text)
        if (segment.kind == VoiceSegmentKind.Partial) {
            voiceAnchor = anchor
            voiceLength = edit.segmentLength
        } else {
            voiceAnchor = null
            voiceLength = 0
        }
        viewModel.consumeVoiceSegment(segment.serial)
    }
    LaunchedEffect(state.voice) {
        // A take that ended without a final segment leaves nothing to replace.
        if (state.voice != VoiceStatus.Listening) {
            voiceAnchor = null
            voiceLength = 0
        }
    }

    // The choice is per profile, so opening another profile's conversation has
    // to re-read it before the sheet or the next take uses it.
    LaunchedEffect(state.chatProfile) { viewModel.loadSpeechLanguages() }
    if (speechLanguageSheet) SpeechLanguageSheet(state, viewModel) { speechLanguageSheet = false }

    // The "+" opens the attachment sheet (ui/chat/AttachmentSheet.kt), not a
    // menu anchored to the button.
    if (attachMenu) {
        AttachmentSheet(
            onDismiss = { attachMenu = false },
            onCamera = { askCamera.launch(Manifest.permission.CAMERA) },
            onGallery = { pickImage.launch("image/*") },
            onFile = { pickFile.launch("*/*") },
        )
    }

    when (sheet) {
        ComposerSheet.Model -> ModalBottomSheet(onDismissRequest = { sheet = null }, sheetState = rememberModalBottomSheetState()) {
            PickerSheet(
                title = stringResource(R.string.sheet_model),
                loading = state.loadingModels,
                rows = state.models.map { option ->
                    PickerRow(label = option.id, detail = option.provider, selected = option.id == state.sessionModel) {
                        viewModel.selectModel(option)
                        sheet = null
                    }
                },
            )
        }

        ComposerSheet.Reasoning -> ModalBottomSheet(onDismissRequest = { sheet = null }, sheetState = rememberModalBottomSheetState()) {
            PickerSheet(
                title = stringResource(R.string.sheet_reasoning),
                loading = false,
                rows = REASONING_LEVELS.map { (value, label) ->
                    PickerRow(
                        label = stringResource(label),
                        detail = if (value.isBlank()) stringResource(R.string.reasoning_use_profile) else null,
                        selected = value == state.reasoningEffort,
                    ) {
                        viewModel.setReasoningEffort(value)
                        sheet = null
                    }
                },
            )
        }

        ComposerSheet.Options, null -> Unit
    }

    // The hint fades on its own; nothing to tap, nothing to dismiss, no modal.
    LaunchedEffect(state.dictationHint) {
        if (!state.dictationHint) return@LaunchedEffect
        delay(DictationHint.VISIBLE_MILLIS)
        viewModel.dismissDictationHint()
    }

    Column(modifier = Modifier.fillMaxWidth()) {
    DictationHintPopup(visible = state.dictationHint) { viewModel.dismissDictationHint() }

    Surface(
        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 7.dp),
        shape = RoundedCornerShape(CoreHubTokens.Radius.composer),
        color = palette.bgComposer,
        contentColor = palette.textPrimary,
        tonalElevation = 0.dp,
        shadowElevation = if (fieldFocused) CoreHubTokens.Shadow.composerFocused else CoreHubTokens.Shadow.composer,
    ) {
        BoxWithConstraints(modifier = Modifier.fillMaxWidth().heightIn(min = CoreHubTokens.Metrics.composerMinHeight)) {
            val compact = maxWidth < 380.dp
            // Context indicator, top-end, above the textarea (the 22 dp top padding of the spec).
            Box(modifier = Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 12.dp)) { ContextUsage(state) }
            // Two blocks with the free space between them, so the toolbar sits on
            // the card's bottom edge even when the card is at its 150 dp minimum.
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = CoreHubTokens.Metrics.composerMinHeight)
                    .padding(top = 22.dp, start = 12.dp, end = 12.dp, bottom = 9.dp),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                if (state.attachments.isNotEmpty() || state.uploads.isNotEmpty()) {
                    FlowRow(
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        state.uploads.forEach { upload ->
                            UploadChip(name = upload.name, percent = upload.percent) { viewModel.cancelUpload(upload.id) }
                        }
                        state.attachments.forEach { file ->
                            AttachmentChip(name = file.name) { viewModel.removeAttachment(file) }
                        }
                    }
                }

                if (state.voice != VoiceStatus.Idle) VoiceStatusRow(state, viewModel)
                state.dictationWarning?.let { warning ->
                    DictationWarningRow(warning) { viewModel.dismissDictationWarning() }
                }

                // The field runs in the direction of what was typed, not of
                // the interface: docs/CONTENT-DIRECTION.md, the same rule the
                // web gets from dir="auto" on the textarea. Without it an
                // Arabic draft in an English app is laid out inside an
                // LTR-anchored box and starts wherever the text happens to
                // end, rather than at the right edge.
                ContentDirectionBox(field.text) {
                    BasicTextField(
                        value = field,
                        onValueChange = { value ->
                            field = value
                            if (value.text != draft) onDraftChange(value.text)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .onFocusChanged { fieldFocused = it.isFocused },
                        // Never below 16 sp on phones; dir=auto per DESIGN-SPEC.
                        // Content is the platform's per-paragraph first-strong
                        // pass, resolved against the direction provided above.
                        textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                        cursorBrush = SolidColor(palette.accent),
                        maxLines = 6,
                        decorationBox = { inner ->
                            Box(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                                if (field.text.isEmpty()) {
                                    Text(
                                        stringResource(R.string.composer_hint),
                                        style = CoreHubTextStyles.input,
                                        color = palette.textMuted,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                                // propagateMinConstraints is the fix, not a
                                // tidy-up. A Box drops the incoming minimum
                                // width, so the text field inside was only ever
                                // as wide as its own glyphs, pinned to the
                                // layout's start; a right-aligned Arabic
                                // paragraph then began at the end of that narrow
                                // run — the middle of the composer — instead of
                                // at the card's edge. Only the width is
                                // propagated: the height stays loose, so the
                                // field does not grow to its 48 dp minimum.
                                Box(modifier = Modifier.fillMaxWidth(), propagateMinConstraints = true) { inner() }
                            }
                        },
                    )
                }
                }

                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    RoundToolbarButton(icon = Icons.Filled.Add, label = stringResource(R.string.composer_attach), enabled = !state.sending) { attachMenu = true }
                    Row(
                        modifier = Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        ToolbarChip(
                            icon = Icons.Filled.Psychology,
                            label = reasoningLabel(state.reasoningEffort),
                            compact = compact,
                            contentDescription = stringResource(R.string.sheet_reasoning),
                        ) { sheet = ComposerSheet.Reasoning }
                        Box {
                            ToolbarChip(
                                icon = CoreHubIcons.Settings,
                                label = stringResource(R.string.composer_settings),
                                compact = compact,
                                contentDescription = stringResource(R.string.composer_settings),
                            ) { settingsMenu = true }
                            DropdownMenu(expanded = settingsMenu, onDismissRequest = { settingsMenu = false }) {
                                SettingsMenuItem(stringResource(R.string.composer_voice_mode), state.speakReplies) {
                                    viewModel.setSpeakReplies(!state.speakReplies)
                                }
                                SettingsMenuItem(stringResource(R.string.composer_show_tool_calls), state.showToolCalls) {
                                    viewModel.setShowToolCalls(!state.showToolCalls)
                                }
                                SettingsMenuItem(stringResource(R.string.composer_push), state.sessionPushEnabled) {
                                    settingsMenu = false
                                    viewModel.togglePushEnabled()
                                }
                            }
                        }
                        ToolbarChip(
                            icon = Icons.Filled.ModelTraining,
                            label = state.sessionModel ?: stringResource(R.string.sheet_model),
                            compact = compact,
                            contentDescription = stringResource(R.string.sheet_model),
                            maxLabelWidth = 190.dp,
                            ltrLabel = state.sessionModel != null,
                        ) {
                            viewModel.loadModels()
                            sheet = ComposerSheet.Model
                        }
                    }
                    MicButton(
                        state = state,
                        viewModel = viewModel,
                        onRecord = { askMic.launch(Manifest.permission.RECORD_AUDIO) },
                        onPickLanguage = {
                            // The gesture the hint exists to teach has now been
                            // used, so this profile never sees the hint again.
                            viewModel.noteDictationLongPress()
                            viewModel.loadSpeechLanguages()
                            speechLanguageSheet = true
                        },
                    )
                    ComposerActionButton(state, draft, onSend, viewModel)
                }
            }
        }
    }
    }
}

/**
 * The occasional reminder that the microphone has a long press.
 *
 * Deliberately not a dialog and not a snackbar: a low-contrast line on the
 * composer's own surface, above the card, that fades in and out by itself and
 * takes no decision from anyone. [DictationHint] decides how often it appears;
 * this only draws it.
 */
@Composable
private fun DictationHintPopup(visible: Boolean, onDismiss: () -> Unit) {
    val palette = CoreHub.palette
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(),
        exit = fadeOut(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 2.dp)
                .clip(RoundedCornerShape(CoreHubTokens.Radius.pill))
                .background(palette.segmentTrack)
                .clickable(onClickLabel = stringResource(R.string.composer_dictation_hint_dismiss), onClick = onDismiss)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Filled.Mic, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(13.dp))
            Text(
                stringResource(R.string.composer_dictation_hint),
                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
                color = palette.textSecondary,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * What the finished take has to admit: it ran in a language the owner did not
 * choose. Error-coloured because the text sitting in the composer is very
 * likely nonsense, and dismissible because the owner may not care this time.
 */
@Composable
private fun DictationWarningRow(warning: String, onDismiss: () -> Unit) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.Filled.ErrorOutline, contentDescription = null, tint = palette.error, modifier = Modifier.size(14.dp))
        Text(
            warning,
            style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
            color = palette.error,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onDismiss, modifier = Modifier.size(22.dp)) {
            Icon(
                Icons.Filled.Close,
                contentDescription = stringResource(R.string.composer_dictation_warning_dismiss),
                tint = palette.textMuted,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

@Composable
private fun SettingsMenuItem(label: String, checked: Boolean, onClick: () -> Unit) {
    val palette = CoreHub.palette
    DropdownMenuItem(
        text = { Text(label) },
        trailingIcon = {
            if (checked) Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.action_selected), tint = palette.textPrimary, modifier = Modifier.size(16.dp))
            else Spacer(Modifier.size(16.dp))
        },
        onClick = onClick,
    )
}

/**
 * What the running take is actually listening for.
 *
 * Never a claim: a detecting take says only that it is detecting until the
 * engine reports a language, and a take that named none says so.
 */
@Composable
internal fun takeLanguageLabel(state: UiState): String = when {
    state.detectedLanguage.isNotBlank() ->
        stringResource(R.string.composer_take_detected, SpeechLanguages.isolatedEndonym(state.detectedLanguage))
    state.takeDetecting && state.voiceViaServer -> stringResource(R.string.composer_take_server_auto)
    // Detecting, and the engine has not named a language yet. Naming the
    // languages it was handed is the difference between "it is working on it"
    // and a strip that says "detecting" while nothing was ever requested.
    state.takeDetecting -> when {
        state.speechDetection.allowed.size >= 2 -> stringResource(
            R.string.composer_take_detecting_among,
            SpeechLanguages.nameList(state.speechDetection.allowed, stringResource(R.string.speech_language_separator)),
        )
        else -> stringResource(R.string.composer_take_detecting)
    }
    // Automatic was asked for and is not running: the strip says so and says
    // why, so a transcript in the wrong language never looks successful.
    state.takeDetectionBlock != DetectionBlock.None -> stringResource(
        R.string.composer_take_detect_off,
        SpeechLanguages.isolatedEndonym(state.takeLanguage),
        detectionReasonLabel(state.takeDetectionBlock),
    )
    // The engine has no model for the locale that was asked for.
    state.takeFallbackFrom.isNotBlank() -> stringResource(
        R.string.composer_take_fallback,
        SpeechLanguages.isolatedEndonym(state.takeFallbackFrom),
        SpeechLanguages.isolatedEndonym(state.takeLanguage),
    )
    state.takeLanguage.isNotBlank() ->
        stringResource(R.string.composer_take_language, SpeechLanguages.isolatedEndonym(state.takeLanguage))
    else -> stringResource(R.string.composer_take_language_unknown)
}

/** One [DetectionBlock] in words, with the phone's own Android version in it. */
@Composable
internal fun detectionReasonLabel(block: DetectionBlock): String = stringResource(
    detectionReasonRes(block),
    Build.VERSION.RELEASE.orEmpty(),
    Build.VERSION.SDK_INT,
)

@Composable
private fun VoiceStatusRow(state: UiState, viewModel: AppViewModel) {
    val palette = CoreHub.palette
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when (state.voice) {
            VoiceStatus.Listening -> {
                Icon(Icons.Filled.Mic, contentDescription = null, tint = palette.accent, modifier = Modifier.size(16.dp))
                Text(
                    stringResource(if (state.voiceViaServer) R.string.composer_recording else R.string.composer_listening),
                    style = CoreHubTextStyles.sessionTitle,
                    color = palette.accent,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { viewModel.cancelVoiceInput() }) { Text(stringResource(R.string.action_cancel)) }
            }
            VoiceStatus.Transcribing -> {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                Text(stringResource(R.string.composer_transcribing), style = CoreHubTextStyles.sessionTitle, modifier = Modifier.weight(1f))
            }
            VoiceStatus.Error -> {
                Icon(Icons.Filled.ErrorOutline, contentDescription = null, tint = palette.error, modifier = Modifier.size(16.dp))
                Text(
                    state.error ?: stringResource(R.string.composer_voice_failed),
                    style = CoreHubTextStyles.sessionTitle,
                    color = palette.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { viewModel.resetVoice() }) { Text(stringResource(R.string.action_dismiss)) }
            }
            VoiceStatus.Idle -> Unit
        }
    }
        if (state.voice == VoiceStatus.Listening || state.voice == VoiceStatus.Transcribing) {
            Text(
                takeLanguageLabel(state),
                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
                color = palette.textMuted,
                maxLines = 1,
                modifier = Modifier.padding(start = 24.dp),
            )
        }
    }
}

/** A file that is still uploading: name, percent, progress bar, cancel ✕. */
@Composable
private fun UploadChip(name: String, percent: Int, onCancel: () -> Unit) {
    val palette = CoreHub.palette
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(CoreHubTokens.Radius.medium))
            .background(palette.segmentTrack)
            .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 6.dp)
            .widthIn(max = 220.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                stringResource(R.string.upload_progress, name, percent),
                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            IconButton(onClick = onCancel, modifier = Modifier.size(22.dp)) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.upload_cancel), tint = palette.textMuted, modifier = Modifier.size(14.dp))
            }
        }
        LinearProgressIndicator(
            progress = { percent / 100f },
            modifier = Modifier.fillMaxWidth().height(CoreHubTokens.Metrics.contextBarHeight).clip(RoundedCornerShape(CoreHubTokens.Radius.pill)),
            color = palette.accent,
            trackColor = palette.borderLight,
        )
    }
}

@Composable
private fun AttachmentChip(name: String, onRemove: () -> Unit) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(CoreHubTokens.Radius.pill))
            .background(palette.segmentTrack)
            .padding(start = 10.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            name,
            style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content),
            color = palette.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 180.dp),
        )
        IconButton(onClick = onRemove, modifier = Modifier.size(22.dp)) {
            Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.action_remove), tint = palette.textMuted, modifier = Modifier.size(14.dp))
        }
    }
}

/** 30 dp outlined circle (the "+" button). */
@Composable
private fun RoundToolbarButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val palette = CoreHub.palette
    Box(
        modifier = Modifier
            .size(CoreHubTokens.Metrics.composerButton)
            .clip(CircleShape)
            .then(Modifier.background(Color.Transparent))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Surface(shape = CircleShape, color = Color.Transparent, border = BorderStroke(1.dp, palette.inputBorder), modifier = Modifier.size(CoreHubTokens.Metrics.composerButton)) {}
        Icon(icon, contentDescription = label, tint = if (enabled) palette.textSecondary else palette.textMuted, modifier = Modifier.size(18.dp))
    }
}

/**
 * The M1 voice input, 30 dp: idle mic / stop while listening / spinner while
 * transcribing. A long press opens the dictation-language sheet, so a single
 * Arabic message on an English phone costs one gesture instead of a trip to
 * Settings.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MicButton(
    state: UiState,
    viewModel: AppViewModel,
    onRecord: () -> Unit,
    onPickLanguage: () -> Unit,
) {
    val palette = CoreHub.palette
    val listening = state.voice == VoiceStatus.Listening
    val languageHint = stringResource(R.string.sheet_speech_language)
    Box(
        modifier = Modifier
            .size(CoreHubTokens.Metrics.composerButton)
            .clip(CircleShape)
            .background(if (listening) palette.accent else Color.Transparent)
            .semantics { onLongClick(label = languageHint) { onPickLanguage(); true } }
            .combinedClickable(
                enabled = state.voice != VoiceStatus.Transcribing,
                onLongClick = onPickLanguage,
                onClick = { if (listening) viewModel.stopVoiceInput() else onRecord() },
            ),
        contentAlignment = Alignment.Center,
    ) {
        when (state.voice) {
            VoiceStatus.Transcribing -> CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = palette.textSecondary)
            VoiceStatus.Listening -> Icon(
                Icons.Filled.Stop,
                contentDescription = stringResource(if (state.voiceViaServer) R.string.composer_stop else R.string.composer_stop_listening),
                tint = palette.textOnAccent,
                modifier = Modifier.size(18.dp),
            )
            else -> Icon(
                Icons.Filled.Mic,
                contentDescription = stringResource(R.string.composer_record),
                tint = if (state.voice == VoiceStatus.Error) palette.error else palette.textSecondary,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/** "45.0k / 256.0k · remaining 211.0k": 11 sp muted, amber above 80 %, bar 42×4. */
@Composable
internal fun ContextUsage(state: UiState) {
    val palette = CoreHub.palette
    val ratio = contextRatio(state.contextTokens, state.contextWindow)
    val color = if (ratio > CoreHubTokens.Metrics.contextWarnRatio) CoreHubTokens.Metrics.contextWarn else palette.textMuted
    Column(horizontalAlignment = Alignment.End) {
        Text(
            when {
                state.loadingContext -> stringResource(R.string.context_loading)
                state.contextWindow > 0 -> contextIndicatorText(state.contextTokens, state.contextWindow, stringResource(R.string.context_remaining))
                else -> stringResource(R.string.context_unknown)
            },
            style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
            color = color,
            maxLines = 1,
        )
        LinearProgressIndicator(
            progress = { ratio },
            modifier = Modifier.width(CoreHubTokens.Metrics.contextBarWidth).height(CoreHubTokens.Metrics.contextBarHeight).clip(RoundedCornerShape(CoreHubTokens.Radius.pill)),
            color = color,
            trackColor = palette.borderLight,
        )
    }
}

internal fun compactNumber(value: Long): String = when {
    value >= 1_000_000 -> "%.1fM".format(Locale.US, value / 1_000_000.0)
    value >= 1_000 -> "%.1fK".format(Locale.US, value / 1_000.0)
    else -> value.toString()
}.replace(".0", "")

internal enum class ComposerSheet { Options, Model, Reasoning }

internal val REASONING_LEVELS = listOf(
    "" to R.string.reasoning_default,
    "low" to R.string.reasoning_low,
    "medium" to R.string.reasoning_medium,
    "high" to R.string.reasoning_high,
    "xhigh" to R.string.reasoning_extra_high,
)

internal val VOICE_INPUT_MODES = listOf(
    Store.VOICE_INPUT_DEVICE to R.string.voice_input_device,
    Store.VOICE_INPUT_SERVER to R.string.voice_input_server,
)

@Composable
internal fun voiceInputLabel(mode: String): String = stringResource(
    VOICE_INPUT_MODES.firstOrNull { it.first == mode }?.second ?: R.string.voice_input_device,
)

/** Settings › Voice: the voice the owner picked, or the one Core Hub would pick. */
@Composable
internal fun voiceOutputLabel(state: UiState): String = when {
    state.voiceOutput == VoiceOutput.DEVICE -> stringResource(R.string.voice_output_device)
    VoiceOutput.isProvider(state.voiceOutput) -> VoiceOutput.label(state.voiceOutput)
    else -> stringResource(
        R.string.voice_output_follow_server_value,
        VoiceOutput.label(VoiceOutput.effectiveProvider(state.voiceSettings)),
    )
}

/**
 * The Voice sheet: Core Hub's own choice, every provider it has configured for
 * the profile, and the device engine. The provider Core Hub calls active is
 * marked, so the owner can see what the phone will ask for.
 */
@Composable
internal fun voiceOutputRows(state: UiState, onPick: (String) -> Unit): List<PickerRow> {
    val settings = state.voiceSettings
    val effective = VoiceOutput.label(VoiceOutput.effectiveProvider(settings))
    val stored = settings.providers.map { it.id }.toSet()
    return buildList {
        add(
            PickerRow(
                label = stringResource(R.string.voice_output_follow_server),
                detail = stringResource(R.string.voice_output_follow_server_note, effective),
                selected = state.voiceOutput == VoiceOutput.FOLLOW_SERVER,
            ) { onPick(VoiceOutput.FOLLOW_SERVER) },
        )
        VoiceOutput.listedProviders(settings).forEach { provider ->
            add(
                PickerRow(
                    label = VoiceOutput.label(provider.id),
                    detail = when {
                        provider.id == settings.activeProvider -> stringResource(R.string.voice_output_active)
                        provider.id == VoiceOutput.BUILT_IN && provider.id !in stored ->
                            stringResource(R.string.voice_output_builtin)
                        else -> stringResource(R.string.voice_output_stored)
                    },
                    selected = state.voiceOutput == provider.id,
                ) { onPick(provider.id) },
            )
        }
        add(
            PickerRow(
                label = stringResource(R.string.voice_output_device),
                detail = stringResource(R.string.voice_output_device_note),
                selected = state.voiceOutput == VoiceOutput.DEVICE,
            ) { onPick(VoiceOutput.DEVICE) },
        )
    }
}

/** Settings › Dictation language, and the mic long-press: the current choice. */
@Composable
internal fun speechLanguageLabel(state: UiState, appLanguageTag: String): String = when (val choice = SpeechLanguages.normalize(state.speechLanguage)) {
    SpeechLanguages.AUTOMATIC -> stringResource(R.string.speech_language_automatic)
    SpeechLanguages.FOLLOW_APP -> stringResource(
        R.string.speech_language_follow_app_value,
        SpeechLanguages.isolatedEndonym(SpeechLanguages.normalizeTag(appLanguageTag)),
    )
    else -> SpeechLanguages.endonym(choice)
}

/**
 * The rows of the dictation-language sheet: follow the app, detect
 * automatically, then every language the device reported.
 *
 * The automatic row is offered whatever the device can do, but its subtitle
 * tells the truth either way — the languages the engine will choose between,
 * or why it cannot choose at all.
 */
@Composable
internal fun speechLanguageRows(
    state: UiState,
    appLanguageTag: String,
    onPick: (String) -> Unit,
): List<PickerRow> {
    val choice = SpeechLanguages.normalize(state.speechLanguage)
    val options = SpeechLanguages.options(state.speechLanguages, choice)
    val detection = state.speechDetection
    val allowedNames = SpeechLanguages.nameList(
        detection.allowed,
        stringResource(R.string.speech_language_separator),
    )
    val confirmedLabel = stringResource(R.string.speech_language_confirmed)
    val unconfirmedLabel = stringResource(R.string.speech_language_unconfirmed)
    return buildList {
        add(
            PickerRow(
                label = stringResource(R.string.speech_language_follow_app),
                detail = stringResource(
                    R.string.speech_language_follow_app_note,
                    SpeechLanguages.isolatedEndonym(SpeechLanguages.normalizeTag(appLanguageTag)),
                ),
                selected = choice == SpeechLanguages.FOLLOW_APP,
            ) { onPick(SpeechLanguages.FOLLOW_APP) },
        )
        add(
            PickerRow(
                label = stringResource(R.string.speech_language_automatic),
                detail = if (detection.usable) {
                    stringResource(R.string.speech_language_automatic_note, allowedNames)
                } else {
                    // Not "this device cannot": the reason this device gave.
                    detectionReasonLabel(detection.block)
                },
                selected = choice == SpeechLanguages.AUTOMATIC,
            ) { onPick(SpeechLanguages.AUTOMATIC) },
        )
        options.forEach { option: SpeechLanguageOption ->
            add(
                PickerRow(
                    label = option.endonym,
                    detail = if (option.confirmed) confirmedLabel else unconfirmedLabel,
                    selected = choice.equals(option.tag, ignoreCase = true),
                ) { onPick(option.tag) },
            )
        }
    }
}

/**
 * The dictation-language sheet, shared by Settings and the mic long-press so
 * the two can never drift apart.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SpeechLanguageSheet(state: UiState, viewModel: AppViewModel, onDismiss: () -> Unit) {
    val palette = CoreHub.palette
    val appLanguageTag = Locale.getDefault().toLanguageTag()
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState()) {
        PickerSheet(
            title = stringResource(R.string.sheet_speech_language),
            loading = false,
            rows = speechLanguageRows(state, appLanguageTag) { choice ->
                onDismiss()
                viewModel.setSpeechLanguage(choice)
            },
        )
        // Two honest footnotes: a list nobody confirmed, and a setting that
        // sends the take somewhere this choice cannot reach.
        if (state.speechLanguages.isEmpty()) {
            SheetNote(stringResource(R.string.speech_language_unconfirmed_all), palette.textMuted)
        }
        if (state.voiceInput == Store.VOICE_INPUT_SERVER) {
            SheetNote(stringResource(R.string.speech_language_server_note), palette.textMuted)
        }
    }
}

@Composable
private fun SheetNote(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall.copy(textDirection = TextDirection.Content),
        color = color,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
    )
}

internal val APPEARANCE_LEVELS = listOf(
    "system" to R.string.appearance_system,
    "light" to R.string.appearance_light,
    "dark" to R.string.appearance_dark,
)

@Composable
internal fun reasoningLabel(effort: String): String = stringResource(
    REASONING_LEVELS.firstOrNull { it.first == effort }?.second ?: R.string.reasoning_default,
)

@Composable
internal fun appearanceLabel(appearance: String): String = stringResource(
    APPEARANCE_LEVELS.firstOrNull { it.first == appearance }?.second ?: R.string.appearance_system,
)

internal const val PHONE_REPOSITORY_URL = "https://github.com/twuijri/hermes-studio-mobile"
internal const val STUDIO_REPOSITORY_URL = "https://github.com/EKKOLearnAI/hermes-studio"

/** 30 dp accent circle: send when there is a payload, a square stop while streaming. */
@Composable
internal fun ComposerActionButton(
    state: UiState,
    draft: String,
    onSend: () -> Unit,
    viewModel: AppViewModel,
) {
    val hasPayload = draft.isNotBlank() || state.attachments.isNotEmpty()
    val palette = CoreHub.palette
    val stopping = state.abortPhase != null
    val active = hasPayload || state.sending
    val background = if (active) palette.accent else palette.bgSecondary
    val tint = if (active) palette.textOnAccent else palette.textMuted
    val uploading = state.uploads.isNotEmpty()

    Box(
        modifier = Modifier
            .size(CoreHubTokens.Metrics.composerButton)
            .clip(CircleShape)
            .background(background)
            .clickable(enabled = (state.sending && !stopping) || (hasPayload && !uploading)) {
                if (state.sending) viewModel.stopRun() else onSend()
            },
        contentAlignment = Alignment.Center,
    ) {
        when {
            stopping -> CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = tint)
            state.sending -> Box(
                modifier = Modifier.size(12.dp).background(tint, RoundedCornerShape(2.dp)),
            )
            else -> Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.composer_send), tint = tint, modifier = Modifier.size(16.dp))
        }
    }
}

/** Pill (radius 999) on the segment track; on narrow phones only the icon shows. */
@Composable
internal fun ToolbarChip(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    compact: Boolean = false,
    contentDescription: String? = null,
    maxLabelWidth: androidx.compose.ui.unit.Dp = 150.dp,
    ltrLabel: Boolean = false,
    onClick: () -> Unit,
) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(CoreHubTokens.Radius.pill))
            .background(palette.segmentTrack)
            .clickable(onClick = onClick)
            .padding(horizontal = if (compact) 8.dp else 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(icon, contentDescription = contentDescription ?: label, tint = palette.textSecondary, modifier = Modifier.size(14.dp))
        if (!compact) {
            Text(
                label,
                style = CoreHubTextStyles.sessionTitle.copy(textDirection = if (ltrLabel) TextDirection.Ltr else TextDirection.Content),
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = maxLabelWidth),
            )
            Text("⌄", style = CoreHubTextStyles.meta, color = palette.textMuted)
        }
    }
}

internal data class PickerRow(
    val label: String,
    val detail: String?,
    val selected: Boolean,
    val onClick: () -> Unit,
)

@Composable
internal fun PickerSheet(title: String, loading: Boolean, rows: List<PickerRow>) {
    val palette = CoreHub.palette
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 28.dp)) {
        SheetTitle(title)
        if (loading) {
            Row(modifier = Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator(modifier = Modifier.size(22.dp))
            }
        }
        if (!loading && rows.isEmpty()) {
            Text(
                stringResource(R.string.sheet_empty),
                color = palette.textSecondary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
        }
        rows.forEach { row ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = row.onClick)
                    .padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(row.label, style = MaterialTheme.typography.bodyLarge.copy(textDirection = TextDirection.Content))
                    row.detail?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                    }
                }
                if (row.selected) {
                    Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.action_selected))
                }
            }
        }
    }
}

@Composable
internal fun SheetTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
    )
}

@Composable
internal fun SheetRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    detail: String,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(
                detail,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
internal fun AttachOption(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier.clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(54.dp)
                .clip(RoundedCornerShape(27.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = label, tint = MaterialTheme.colorScheme.onSurface)
        }
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

/** Cache-backed target for a camera capture, shared through the FileProvider. */
internal fun newCaptureUri(context: Context): Uri {
    val dir = File(context.cacheDir, "captures").apply { mkdirs() }
    val file = File(dir, "capture-${System.currentTimeMillis()}.jpg")
    return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
}

/** Reads a picked document through the content resolver and hands it to the upload. */
internal fun readAndAttach(
    context: Context,
    uri: Uri,
    viewModel: AppViewModel,
    fallbackName: String? = null,
) {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri) ?: if (fallbackName?.endsWith(".jpg") == true) "image/jpeg" else "application/octet-stream"
    var name = fallbackName ?: "attachment"
    runCatching {
        resolver.query(uri, null, null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && cursor.moveToFirst()) name = cursor.getString(index) ?: name
        }
    }
    val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
    if (bytes == null || bytes.isEmpty()) {
        viewModel.reportAttachmentUnreadable(name)
        return
    }
    viewModel.attach(bytes, name, mime)
}

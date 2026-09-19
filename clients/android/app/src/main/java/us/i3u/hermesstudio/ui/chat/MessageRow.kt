package us.i3u.hermesstudio.ui.chat

import android.media.MediaPlayer
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CallSplit
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import us.i3u.hermesstudio.AvatarSpec
import us.i3u.hermesstudio.ChatFileLink
import us.i3u.hermesstudio.ChatLine
import us.i3u.hermesstudio.ChatLineKind
import us.i3u.hermesstudio.ChatMarkdownText
import us.i3u.hermesstudio.ChatToolStep
import us.i3u.hermesstudio.ParsedChatMessage
import us.i3u.hermesstudio.ProfileAvatar
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.ToolRunStatus
import us.i3u.hermesstudio.chatTextDirection
import us.i3u.hermesstudio.parseChatMessage
import us.i3u.hermesstudio.ui.sessions.formatStamp
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/** The buttons of the action row and where media streams from. */
data class MessageActions(
    val onCopy: (ChatLine) -> Unit,
    val onReference: (ChatLine) -> Unit,
    val onFork: (ChatLine) -> Unit,
    val onSpeak: (ChatLine) -> Unit,
    val onDownload: (ChatFileLink) -> Unit,
    /** Stream URL and request headers for an inline player; null disables players. */
    val mediaSource: ((ChatFileLink) -> Pair<String, Map<String, String>>)? = null,
    val forkEnabled: Boolean = true,
)

/** Which message is being read aloud, so its button shows pause instead of play. */
data class SpeechState(val speakingKey: String?, val paused: Boolean, val loadingKey: String?)

/**
 * One message row per DESIGN-SPEC "Message row": user bubbles end-aligned at
 * 75 %, assistant rows with a 22 dp avatar and author label at 80 %, system
 * notices with a 3 dp inline-start warning border, command acknowledgements,
 * error rows, the collapsible tool card and thinking block, inline media, and
 * the always-visible action row.
 */
@Composable
fun MessageRow(
    line: ChatLine,
    profile: String?,
    avatar: AvatarSpec?,
    bubbleColor: Color,
    bubbleShape: Shape,
    showToolCalls: Boolean,
    speech: SpeechState,
    actions: MessageActions?,
) {
    val parsed = remember(line.text) { parseChatMessage(line.text) }
    // Last line of defence against the empty bubble: a chat row with no text,
    // no attachment, no tool card, no thinking block and nothing streaming
    // would paint an avatar, an author label and a timestamp around nothing.
    // System, command and error rows draw line.text directly, so they are not
    // subject to this.
    val chatRow = line.kind == ChatLineKind.User || line.kind == ChatLineKind.Assistant
    if (chatRow &&
        parsed.text.isBlank() &&
        parsed.files.isEmpty() &&
        line.tools.isEmpty() &&
        line.reasoning.isNullOrBlank() &&
        !line.streaming
    ) {
        return
    }
    when (line.kind) {
        ChatLineKind.User -> UserRow(line, parsed, bubbleColor, bubbleShape, speech, actions)
        ChatLineKind.Assistant -> AssistantRow(line, parsed, profile, avatar, bubbleColor, bubbleShape, showToolCalls, speech, actions)
        ChatLineKind.System -> SystemRow(line)
        ChatLineKind.Command -> CommandRow(line)
        ChatLineKind.Error -> ErrorRow(line)
    }
}

@Composable
private fun UserRow(
    line: ChatLine,
    parsed: ParsedChatMessage,
    bubbleColor: Color,
    bubbleShape: Shape,
    speech: SpeechState,
    actions: MessageActions?,
) {
    BoxWithConstraints(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Column(modifier = Modifier.widthIn(max = maxWidth * 0.75f), horizontalAlignment = Alignment.End) {
            line.sender?.let { AuthorLabel(it) }
            Surface(color = bubbleColor, shape = bubbleShape, contentColor = CoreHub.palette.textPrimary) {
                Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (parsed.text.isNotBlank()) {
                        Text(parsed.text, style = CoreHubTextStyles.message.copy(textDirection = TextDirection.Content))
                    }
                    parsed.files.forEach { file -> FileOrMedia(file, actions) }
                }
            }
            actions?.let { ActionRow(line, speech, it) }
        }
    }
}

@Composable
private fun AssistantRow(
    line: ChatLine,
    parsed: ParsedChatMessage,
    profile: String?,
    avatar: AvatarSpec?,
    bubbleColor: Color,
    bubbleShape: Shape,
    showToolCalls: Boolean,
    speech: SpeechState,
    actions: MessageActions?,
) {
    val palette = CoreHub.palette
    BoxWithConstraints(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
        Row(modifier = Modifier.widthIn(max = maxWidth * 0.80f), verticalAlignment = Alignment.Top) {
            if (!profile.isNullOrBlank()) {
                ProfileAvatar(profile, avatar, size = CoreHubTokens.Metrics.messageAvatar)
                Spacer(Modifier.width(8.dp))
            }
            Column(modifier = Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                AuthorLabel(line.sender ?: profile.orEmpty().ifBlank { stringResource(R.string.conversation_your_agent) })
                if (!line.reasoning.isNullOrBlank()) ThinkingBlock(line)
                if (showToolCalls && line.tools.isNotEmpty()) ToolSummaryCard(line.tools, line.streaming)
                val showBubble = parsed.text.isNotBlank() || (line.streaming && line.tools.isEmpty() && line.reasoning.isNullOrBlank())
                if (showBubble) {
                    // Shrink-wrap short replies (intrinsic width) while long ones
                    // stop at the 80 % cap, as the web's max-width bubble does.
                    Surface(color = bubbleColor, shape = bubbleShape, contentColor = palette.textPrimary, modifier = Modifier.width(IntrinsicSize.Max)) {
                        Box(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                            if (parsed.text.isNotBlank()) ChatMarkdownText(text = parsed.text) else StreamingDots()
                        }
                    }
                } else if (line.streaming) {
                    StreamingDots(modifier = Modifier.padding(start = 6.dp))
                }
                parsed.files.forEach { file -> FileOrMedia(file, actions) }
                if (actions != null && !line.streaming) ActionRow(line, speech, actions)
            }
        }
    }
}

/** Author name, 12 sp secondary (DESIGN-SPEC typography). */
@Composable
private fun AuthorLabel(name: String) {
    Text(
        name,
        style = CoreHubTextStyles.meta.copy(fontSize = CoreHubTokens.Type.author, lineHeight = 16.sp, textDirection = TextDirection.Content),
        color = CoreHub.palette.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** System notice: 3 dp inline-start warning border, secondary text. */
@Composable
private fun SystemRow(line: ChatLine) {
    val palette = CoreHub.palette
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Box(modifier = Modifier.width(3.dp).height(20.dp).background(palette.warning, RoundedCornerShape(2.dp)).align(Alignment.CenterVertically))
        Spacer(Modifier.width(10.dp))
        Text(
            line.text,
            style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content),
            color = palette.textSecondary,
            modifier = Modifier.weight(1f),
        )
    }
}

/** A slash-command acknowledgement ("/fork", "/compact"): a mono chip on the code ground. */
@Composable
private fun CommandRow(line: ChatLine) {
    val palette = CoreHub.palette
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        Text(
            line.text,
            style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = chatTextDirection(line.text)),
            color = palette.textMuted,
            modifier = Modifier
                .background(palette.codeBg, RoundedCornerShape(CoreHubTokens.Radius.small))
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/** Error: error text on error @ 6 %. */
@Composable
private fun ErrorRow(line: ChatLine) {
    val palette = CoreHub.palette
    Surface(color = palette.errorSurface, shape = RoundedCornerShape(CoreHubTokens.Radius.bubble), modifier = Modifier.fillMaxWidth()) {
        Text(
            line.text,
            style = CoreHubTextStyles.message.copy(textDirection = TextDirection.Content),
            color = palette.error,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

/** Three pulsing dots while the reply has not produced text yet. */
@Composable
fun StreamingDots(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "streaming")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 3f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
        label = "dots",
    )
    Row(
        modifier = modifier.padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(3) { index ->
            val active = phase.toInt() % 3 == index
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .alpha(if (active) 1f else 0.35f)
                    .background(CoreHub.palette.textMuted, CircleShape),
            )
        }
    }
}

// ── thinking block ────────────────────────────────────────────────────────

/** 💭 Thinking · Observed {duration} · {count} chars — 13 sp italic at 85 %, collapsible. */
@Composable
fun ThinkingBlock(line: ChatLine) {
    val palette = CoreHub.palette
    var expanded by rememberSaveable(line.key) { mutableStateOf(false) }
    val started = line.startedAtMillis
    val ended = line.thinkingFinishedAtMillis ?: line.finishedAtMillis
    val durationText = started?.let { formatThinkingDuration((ended ?: System.currentTimeMillis()) - it) }
    val chars = thinkingCharCount(line.reasoning)
    val chevron by animateFloatAsState(if (expanded) 90f else 0f, label = "thinking-chevron")
    Column(modifier = Modifier.fillMaxWidth().alpha(CoreHubTokens.Type.thinkingAlpha)) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(CoreHubIcons.ChevronRight, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(10.dp).rotate(chevron))
            Text("💭", style = CoreHubTextStyles.thinking)
            Text(
                buildString {
                    append(stringResource(R.string.thinking_title))
                    if (durationText != null && (ended ?: 0L) - (started ?: 0L) > 0L) append(" · ").append(stringResource(R.string.thinking_observed, durationText))
                    append(" · ").append(stringResource(R.string.thinking_chars, chars))
                },
                style = CoreHubTextStyles.thinking,
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (expanded) {
            Text(
                line.reasoning.orEmpty(),
                style = CoreHubTextStyles.thinking.copy(textDirection = TextDirection.Content),
                color = palette.textSecondary,
                modifier = Modifier.padding(start = 16.dp, top = 4.dp, bottom = 4.dp),
            )
        }
    }
}

// ── tool summary card ─────────────────────────────────────────────────────

/**
 * "N tools" card: 30 dp header (chevron rotating 90°, wrench, count, up to three
 * names, trailing ••• / ✓ / ✕), then one line per tool with Thinking /
 * Arguments / Result sections when the server sent them.
 */
@Composable
fun ToolSummaryCard(tools: List<ChatToolStep>, streaming: Boolean) {
    val palette = CoreHub.palette
    var expanded by rememberSaveable(tools.firstOrNull()?.id) { mutableStateOf(false) }
    val chevron by animateFloatAsState(if (expanded) 90f else 0f, label = "tools-chevron")
    val running = tools.any { it.status == ToolRunStatus.Running } || streaming
    val failed = tools.any { it.status == ToolRunStatus.Error }
    Surface(
        modifier = Modifier.fillMaxWidth().widthIn(max = 520.dp),
        shape = RoundedCornerShape(CoreHubTokens.Radius.medium),
        color = palette.bgCard,
        border = BorderStroke(1.dp, palette.borderLight),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().height(30.dp).clickable { expanded = !expanded }.padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(CoreHubIcons.ChevronRight, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(10.dp).rotate(chevron))
                Icon(Icons.Filled.Build, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(12.dp))
                Text(
                    pluralToolsLabel(tools.size),
                    style = CoreHubTextStyles.meta.copy(fontWeight = FontWeight.Medium),
                    color = palette.textSecondary,
                    maxLines = 1,
                )
                Text(
                    toolSummaryNames(tools.map { it.name }),
                    style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = TextDirection.Ltr),
                    color = palette.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                when {
                    running -> Text("•••", style = CoreHubTextStyles.meta, color = palette.textMuted)
                    failed -> StatusBadge(ok = false)
                    else -> StatusBadge(ok = true)
                }
            }
            if (expanded) {
                Column(modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    tools.forEach { tool -> ToolLine(tool) }
                }
            }
        }
    }
}

@Composable
private fun pluralToolsLabel(count: Int): String = stringResource(R.string.tools_count, count)

@Composable
private fun StatusBadge(ok: Boolean) {
    val palette = CoreHub.palette
    val tint = if (ok) palette.success else palette.error
    Box(
        modifier = Modifier.size(15.dp).background(tint.copy(alpha = 0.14f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (ok) Icons.Filled.Check else Icons.Filled.Close,
            contentDescription = stringResource(if (ok) R.string.tool_status_done else R.string.tool_status_failed),
            tint = tint,
            modifier = Modifier.size(11.dp),
        )
    }
}

/** One tool line: 11 sp mono name, preview, running spinner / success / error; taps open its details. */
@Composable
private fun ToolLine(tool: ChatToolStep) {
    val palette = CoreHub.palette
    var open by rememberSaveable(tool.id) { mutableStateOf(false) }
    val chevron by animateFloatAsState(if (open) 90f else 0f, label = "tool-chevron")
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(CoreHubTokens.Radius.small))
                .clickable(enabled = tool.hasDetails) { open = !open }
                .padding(horizontal = 4.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (tool.hasDetails) {
                Icon(CoreHubIcons.ChevronRight, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(10.dp).rotate(chevron))
            } else {
                Icon(Icons.Filled.Build, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(12.dp))
            }
            Text(
                tool.name,
                style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = TextDirection.Ltr),
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            tool.detail?.takeIf { it.isNotBlank() && !open }?.let { preview ->
                Text(
                    preview,
                    style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr),
                    color = palette.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            } ?: Spacer(Modifier.weight(1f))
            tool.durationSeconds?.let {
                Text(formatToolDuration(it), style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textMuted)
            }
            when (tool.status) {
                ToolRunStatus.Running -> CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp, color = palette.textMuted)
                ToolRunStatus.Done -> StatusBadge(ok = true)
                ToolRunStatus.Error -> StatusBadge(ok = false)
            }
        }
        if (open && tool.hasDetails) {
            Column(modifier = Modifier.padding(start = 16.dp, top = 2.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                tool.reasoning?.takeIf { it.isNotBlank() }?.let { DetailSection(stringResource(R.string.thinking_title), it, mono = false) }
                tool.arguments?.takeIf { it.isNotBlank() }?.let { DetailSection(stringResource(R.string.tool_arguments), it, mono = true) }
                tool.output?.takeIf { it.isNotBlank() }?.let { output ->
                    val note = if (tool.outputTruncated) "\n" + stringResource(R.string.tool_output_truncated, tool.outputOriginalLength?.toString() ?: "?") else ""
                    DetailSection(stringResource(R.string.tool_result), output + note, mono = true)
                }
            }
        }
    }
}

@Composable
private fun DetailSection(label: String, body: String, mono: Boolean) {
    val palette = CoreHub.palette
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = CoreHubTextStyles.groupHeader, color = palette.textMuted)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.codeBg, RoundedCornerShape(CoreHubTokens.Radius.small))
                .horizontalScroll(rememberScrollState())
                .padding(8.dp),
        ) {
            // Code and JSON stay LTR; free-form reasoning follows its own script.
            Text(
                body,
                style = if (mono) CoreHubTextStyles.code.copy(fontSize = CoreHubTokens.Type.meta, lineHeight = CoreHubTokens.Type.code, textDirection = TextDirection.Ltr)
                else CoreHubTextStyles.thinking.copy(textDirection = TextDirection.Content),
                color = palette.textPrimary,
                maxLines = 60,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ── action row ────────────────────────────────────────────────────────────

/** play/pause · copy · reference · fork · time — 24 dp buttons, radius 6, always visible on phones. */
@Composable
fun ActionRow(line: ChatLine, speech: SpeechState, actions: MessageActions) {
    val palette = CoreHub.palette
    val speakingThis = speech.speakingKey == line.key
    val loadingThis = speech.loadingKey == line.key
    Row(
        modifier = Modifier.padding(top = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (loadingThis) {
            Box(modifier = Modifier.size(CoreHubTokens.Metrics.actionButton), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp, color = palette.textMuted)
            }
        } else {
            ActionButton(
                icon = if (speakingThis && !speech.paused) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                label = stringResource(
                    when {
                        speakingThis && !speech.paused -> R.string.message_pause
                        speakingThis -> R.string.message_resume
                        else -> R.string.message_play
                    },
                ),
                active = speakingThis,
            ) { actions.onSpeak(line) }
        }
        ActionButton(Icons.Filled.ContentCopy, stringResource(R.string.message_copy)) { actions.onCopy(line) }
        ActionButton(Icons.Filled.FormatQuote, stringResource(R.string.message_reference)) { actions.onReference(line) }
        ActionButton(Icons.Filled.CallSplit, stringResource(R.string.message_fork), enabled = actions.forkEnabled) { actions.onFork(line) }
        val stamp = formatStamp(line.timestamp)
        if (stamp.isNotBlank()) {
            Text(stamp, style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textMuted, modifier = Modifier.padding(start = 4.dp))
        }
    }
}

@Composable
private fun ActionButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean = true,
    active: Boolean = false,
    onClick: () -> Unit,
) {
    val palette = CoreHub.palette
    Box(
        modifier = Modifier
            .size(CoreHubTokens.Metrics.actionButton)
            .clip(RoundedCornerShape(CoreHubTokens.Radius.small))
            .background(if (active) palette.selected else Color.Transparent)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.4f),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = if (active) palette.textPrimary else palette.textMuted, modifier = Modifier.size(14.dp))
    }
}

// ── files and media ───────────────────────────────────────────────────────

@Composable
private fun FileOrMedia(file: ChatFileLink, actions: MessageActions?) {
    val source = actions?.mediaSource?.invoke(file)
    when {
        source != null && chatMediaKind(file.fileName) == ChatMediaKind.Video -> VideoCard(file, source.first, source.second)
        source != null && chatMediaKind(file.fileName) == ChatMediaKind.Audio -> AudioCard(file, source.first, source.second)
        else -> ChatFileCard(file = file, onDownload = { actions?.onDownload?.invoke(file) })
    }
}

/** "on the device" badge for `device://` links. */
@Composable
private fun DeviceBadge() {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier.background(palette.tagBackground, RoundedCornerShape(CoreHubTokens.Radius.tag)).padding(horizontal = 6.dp, vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Icon(Icons.Filled.PhoneAndroid, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(10.dp))
        Text(stringResource(R.string.file_on_device), style = CoreHubTextStyles.categoryTag, color = palette.textMuted)
    }
}

/** A download card for anything that is not playable inline. */
@Composable
fun ChatFileCard(file: ChatFileLink, onDownload: () -> Unit) {
    val palette = CoreHub.palette
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onDownload),
        color = palette.bgCard,
        shape = RoundedCornerShape(CoreHubTokens.Radius.bubble),
        border = BorderStroke(1.dp, palette.borderLight),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Icon(Icons.AutoMirrored.Filled.InsertDriveFile, contentDescription = null, tint = palette.textSecondary)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(file.label, style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content), maxLines = 2, overflow = TextOverflow.Ellipsis, color = palette.textPrimary)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (file.fileName != file.label) {
                        Text(
                            file.fileName,
                            style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = TextDirection.Ltr),
                            color = palette.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                    if (parseDeviceFile(file.path) != null) DeviceBadge()
                }
            }
            Icon(Icons.Filled.Download, contentDescription = stringResource(R.string.download_action), tint = palette.textSecondary, modifier = Modifier.size(20.dp))
        }
    }
}

/** Inline audio: the platform MediaPlayer streams with the bearer header (HTTP ranges on the server). */
@Composable
private fun AudioCard(file: ChatFileLink, url: String, headers: Map<String, String>) {
    val palette = CoreHub.palette
    val context = LocalContext.current
    var playing by remember(url) { mutableStateOf(false) }
    var prepared by remember(url) { mutableStateOf(false) }
    var failed by remember(url) { mutableStateOf(false) }
    var position by remember(url) { mutableIntStateOf(0) }
    var duration by remember(url) { mutableIntStateOf(0) }
    val player = remember(url) { MediaPlayer() }
    DisposableEffect(url) {
        runCatching {
            player.setDataSource(context, Uri.parse(url), headers)
            player.setOnPreparedListener { ready -> prepared = true; duration = ready.duration.coerceAtLeast(0) }
            player.setOnCompletionListener { playing = false; position = 0 }
            player.setOnErrorListener { _, _, _ -> failed = true; playing = false; true }
            player.prepareAsync()
        }.onFailure { failed = true }
        onDispose { runCatching { player.stop() }; runCatching { player.release() } }
    }
    LaunchedEffect(playing) {
        while (playing) {
            position = runCatching { player.currentPosition }.getOrDefault(0)
            delay(400)
        }
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = palette.bgCard,
        shape = RoundedCornerShape(CoreHubTokens.Radius.bubble),
        border = BorderStroke(1.dp, palette.borderLight),
    ) {
        Row(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                modifier = Modifier
                    .size(CoreHubTokens.Metrics.composerButton)
                    .clip(CircleShape)
                    .background(palette.accent)
                    .clickable(enabled = prepared && !failed) {
                        if (playing) runCatching { player.pause() } else runCatching { player.start() }
                        playing = !playing
                    },
                contentAlignment = Alignment.Center,
            ) {
                when {
                    failed -> Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.voice_playback_failed), tint = palette.textOnAccent, modifier = Modifier.size(16.dp))
                    !prepared -> CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = palette.textOnAccent)
                    else -> Icon(
                        if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = stringResource(if (playing) R.string.message_pause else R.string.message_play),
                        tint = palette.textOnAccent,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(file.fileName, style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Ltr), maxLines = 1, overflow = TextOverflow.Ellipsis, color = palette.textPrimary, modifier = Modifier.weight(1f, fill = false))
                    if (parseDeviceFile(file.path) != null) DeviceBadge()
                }
                LinearProgressIndicator(
                    progress = { if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f },
                    modifier = Modifier.fillMaxWidth().height(CoreHubTokens.Metrics.contextBarHeight).clip(RoundedCornerShape(CoreHubTokens.Radius.pill)),
                    color = palette.accent,
                    trackColor = palette.borderLight,
                )
            }
            Text(formatClock(if (playing || position > 0) position else duration), style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textMuted)
        }
    }
}

/** Inline video through VideoView + MediaController; headers carry the bearer token. */
@Composable
private fun VideoCard(file: ChatFileLink, url: String, headers: Map<String, String>) {
    val palette = CoreHub.palette
    val direction = LocalLayoutDirection.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(210.dp)
                .clip(RoundedCornerShape(CoreHubTokens.Radius.bubble))
                .background(Color.Black),
        ) {
            AndroidView(
                modifier = Modifier.fillMaxWidth().height(210.dp),
                factory = { context ->
                    VideoView(context).apply {
                        layoutDirection = if (direction == LayoutDirection.Rtl) android.view.View.LAYOUT_DIRECTION_RTL else android.view.View.LAYOUT_DIRECTION_LTR
                        val controller = MediaController(context)
                        controller.setAnchorView(this)
                        setMediaController(controller)
                        setVideoURI(Uri.parse(url), headers)
                        setOnPreparedListener { it.isLooping = false }
                        setOnErrorListener { _, _, _ -> true }
                    }
                },
                onRelease = { view -> runCatching { view.stopPlayback() } },
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(file.fileName, style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = TextDirection.Ltr), color = palette.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (parseDeviceFile(file.path) != null) DeviceBadge()
        }
    }
}

internal fun formatClock(milliseconds: Int): String {
    val total = (milliseconds.coerceAtLeast(0) / 1000)
    val minutes = total / 60
    val seconds = total % 60
    return "%d:%02d".format(java.util.Locale.US, minutes, seconds)
}

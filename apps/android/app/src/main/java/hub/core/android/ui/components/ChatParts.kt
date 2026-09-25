package hub.core.android.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.AbsoluteRoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.chat.ChatMessage
import hub.core.android.chat.Turn
import hub.core.android.generated.LayoutTokens
import hub.core.android.ui.theme.LocalGlassLevel
import hub.core.android.ui.theme.LocalReducedMotion
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.Mono
import hub.core.android.ui.theme.glass
import hub.core.client.model.Approval
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalKind
import hub.core.client.model.ToolCall
import hub.core.client.model.ToolCallStatus
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private val contentStyle = TextStyle(textDirection = TextDirection.Content)

/**
 * One turn. **The person is always on the right, the agent always on the left, in every
 * locale** (DESIGN.md, owner decision 2026-09-22): the row fixes its own direction to LTR and
 * the content inside keeps deciding its own.
 */
@Composable
fun TurnView(turn: Turn, youLabel: String) {
    val t = LocalTokens.current
    val uiDirection = LocalLayoutDirection.current
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val maxBubble = maxWidth * LayoutTokens.bubbleMaxFraction
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = if (turn.fromPerson) Alignment.End else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(LayoutTokens.groupGap.dp),
            ) {
                Text(
                    if (turn.fromPerson) youLabel else turn.authorName,
                    style = MaterialTheme.typography.labelMedium,
                    color = t.textMuted,
                )
                turn.messages.forEach { message ->
                    CompositionLocalProvider(LocalLayoutDirection provides uiDirection) {
                        if (turn.fromPerson) PersonBubble(message, Modifier.widthIn(max = maxBubble)) else AgentMessage(message)
                    }
                }
            }
        }
    }
}

@Composable
private fun PersonBubble(message: ChatMessage, modifier: Modifier) {
    val t = LocalTokens.current
    // The corner nearest the person's own side (the right, always) is the tightened one.
    val shape = AbsoluteRoundedCornerShape(topLeft = 16.dp, topRight = 4.dp, bottomRight = 16.dp, bottomLeft = 16.dp)
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Surface(color = t.userBubble, contentColor = t.userBubbleText, shape = shape, modifier = modifier.border(0.5.dp, t.userBubbleBorder, shape)) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                InContentDirection(message.text) {
                    Text(message.text, style = MaterialTheme.typography.bodyLarge.merge(contentStyle))
                }
                Attachments(message)
            }
        }
    }
}

@Composable
private fun AgentMessage(message: ChatMessage) {
    val t = LocalTokens.current
    val clipboard = LocalClipboardManager.current
    val shape = AbsoluteRoundedCornerShape(topLeft = 4.dp, topRight = 16.dp, bottomRight = 16.dp, bottomLeft = 16.dp)
    Surface(
        color = t.agentBubble, contentColor = t.agentBubbleText, shape = shape,
        modifier = Modifier.fillMaxWidth().border(0.5.dp, t.agentBubbleBorder, shape),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!message.streaming && message.reasoning.isNotBlank()) ReasoningFold(message.reasoning, message.reasoningMs)
            message.toolCalls.forEach { ToolCallCard(it) }
            if (message.text.isNotBlank()) MarkdownView(message.text)
            Attachments(message)
            if (!message.streaming && message.text.isNotBlank()) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    IconButton(onClick = { clipboard.setText(AnnotatedString(message.text)) }, modifier = Modifier.size(32.dp)) {
                        Icon(Glyphs.Copy, contentDescription = stringResource(R.string.chat_copy), modifier = Modifier.size(16.dp), tint = t.textFaint)
                    }
                }
            }
        }
    }
}

@Composable
private fun Attachments(message: ChatMessage) {
    if (message.attachments.isEmpty()) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        message.attachments.forEach { a ->
            ProfileBadge(a.name ?: a.kind.value)
        }
    }
}

/** After a run, the reasoning is history: one quiet line, the text behind a closed disclosure. */
@Composable
private fun ReasoningFold(text: String, durationMs: Int?) {
    val t = LocalTokens.current
    var open by rememberSaveable { mutableStateOf(false) }
    Column {
        Row(
            Modifier.clickable { open = !open }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (durationMs != null) stringResource(R.string.chat_thought_for, (durationMs + 500) / 1000)
                else stringResource(R.string.chat_reasoning),
                style = MaterialTheme.typography.labelMedium, color = t.textMuted,
            )
            Icon(if (open) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown, null, tint = t.textMuted, modifier = Modifier.size(16.dp))
        }
        if (open) {
            InContentDirection(text) {
                Text(text, style = MaterialTheme.typography.bodyMedium.merge(contentStyle), color = t.textMuted)
            }
        }
    }
}

private val pretty = Json { prettyPrint = true }

/** A tool call: its name and one-line preview, its state; opened, the arguments and the output. */
@Composable
fun ToolCallCard(call: ToolCall) {
    val t = LocalTokens.current
    var open by rememberSaveable(call.id) { mutableStateOf(false) }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Surface(color = t.surface2, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.clickable { open = !open }.padding(horizontal = 10.dp, vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Glyphs.Tool, null, modifier = Modifier.size(16.dp), tint = t.textMuted)
                    Text(call.name, style = MaterialTheme.typography.labelLarge)
                    Text(
                        call.preview.orEmpty(), fontFamily = Mono, style = MaterialTheme.typography.bodySmall, color = t.textMuted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    when (call.status) {
                        ToolCallStatus.RUNNING, ToolCallStatus.AWAITING_APPROVAL ->
                            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        ToolCallStatus.SUCCEEDED -> Icon(Icons.Default.Check, stringResource(R.string.chat_tool_done), tint = t.statusRunning, modifier = Modifier.size(16.dp))
                        else -> Icon(Icons.Default.Warning, stringResource(R.string.chat_tool_failed), tint = t.danger, modifier = Modifier.size(16.dp))
                    }
                    call.durationMs?.let {
                        Text(stringResource(R.string.chat_seconds, it / 1000.0), style = MaterialTheme.typography.labelSmall, color = t.textFaint)
                    }
                }
                if (open) {
                    call.arguments?.takeIf { it.isNotEmpty() }?.let { args ->
                        Text(stringResource(R.string.chat_tool_arguments), style = MaterialTheme.typography.labelSmall, color = t.textMuted, modifier = Modifier.padding(top = 8.dp))
                        CodeText(pretty.encodeToString(JsonObject.serializer(), JsonObject(args)))
                    }
                    call.output?.takeIf { it.isNotEmpty() }?.let { out ->
                        Text(stringResource(R.string.chat_tool_output), style = MaterialTheme.typography.labelSmall, color = t.textMuted, modifier = Modifier.padding(top = 8.dp))
                        CodeText(out + if (call.outputTruncated) "\n…" else "")
                    }
                }
            }
        }
    }
}

@Composable
private fun CodeText(text: String) {
    val t = LocalTokens.current
    Box(Modifier.fillMaxWidth().heightIn(max = 240.dp).background(t.codeBg, MaterialTheme.shapes.small).verticalScroll(rememberScrollState())) {
        Text(
            text, fontFamily = Mono, color = t.codeText, softWrap = false,
            style = MaterialTheme.typography.bodySmall.copy(textDirection = TextDirection.Ltr),
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(8.dp),
        )
    }
}

/** Seconds since [startedAt], counting up once a second; never made up when there is no start. */
@Composable
fun rememberElapsedSeconds(startedAt: Long?): Long? {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(startedAt) {
        while (startedAt != null) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    return startedAt?.let { ((now - it) / 1000).coerceAtLeast(0) }
}

/**
 * «●●● Thinking · 12s · shell» above the composer while a run is alive (DESIGN.md): something
 * moving, the word, and the seconds counting — never fewer. Reduced motion stops the dots; the
 * count keeps going, because it is information.
 */
@Composable
fun ThinkingIndicator(startedAt: Long?, step: String?, queued: Boolean) {
    val t = LocalTokens.current
    val seconds = rememberElapsedSeconds(startedAt)
    val reduced = LocalReducedMotion.current
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Dots(reduced)
        val parts = buildList {
            add(stringResource(if (queued) R.string.chat_queued else R.string.chat_thinking))
            if (seconds != null) add(stringResource(R.string.chat_seconds_short, seconds))
            if (!step.isNullOrBlank()) add(step)
        }
        Text(parts.joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = t.textMuted)
    }
}

@Composable
private fun Dots(reduced: Boolean) {
    val t = LocalTokens.current
    val transition = rememberInfiniteTransition(label = "thinking")
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        repeat(3) { i ->
            val alpha = if (reduced) 1f else transition.animateFloat(
                initialValue = 0.25f, targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(600, delayMillis = i * 150), RepeatMode.Reverse), label = "dot$i",
            ).value
            Box(Modifier.size(6.dp).alpha(alpha).background(t.thinking, CircleShape))
        }
    }
}

/** A decision the agent is blocked on: the exact command, and allow once / in this chat / always / deny. */
@Composable
fun ApprovalCard(approval: Approval, onRespond: (ApprovalDecision) -> Unit) {
    val t = LocalTokens.current
    Surface(color = t.warningSoft, contentColor = t.warningSoftText, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(
                    when (approval.kind) {
                        ApprovalKind.MEMORY_WRITE -> R.string.approval_memory
                        ApprovalKind.SKILL_WRITE -> R.string.approval_skill
                        ApprovalKind.PLAN -> R.string.approval_plan
                        ApprovalKind.WORKFLOW_STEP -> R.string.approval_step
                        else -> R.string.approval_tool
                    },
                    approval.agent.name,
                ),
                style = MaterialTheme.typography.labelMedium,
            )
            InContentDirection(approval.title) { Text(approval.title, style = MaterialTheme.typography.titleSmall.merge(contentStyle)) }
            approval.description?.takeIf { it.isNotBlank() }?.let { d ->
                InContentDirection(d) { Text(d, style = MaterialTheme.typography.bodyMedium.merge(contentStyle)) }
            }
            approval.command?.takeIf { it.isNotBlank() }?.let { CodeText(it) }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Button(onClick = { onRespond(ApprovalDecision.APPROVE_ONCE) }) { Text(stringResource(R.string.approval_once)) }
                OutlinedButton(onClick = { onRespond(ApprovalDecision.APPROVE_SESSION) }) { Text(stringResource(R.string.approval_session)) }
                if (approval.allowAlways) {
                    OutlinedButton(onClick = { onRespond(ApprovalDecision.APPROVE_ALWAYS) }) { Text(stringResource(R.string.approval_always)) }
                }
                TextButton(onClick = { onRespond(ApprovalDecision.DENY) }) { Text(stringResource(R.string.approval_deny), color = t.danger) }
            }
        }
    }
}

private val RECOMMENDED = Regex(" \\(Recommended\\)$", RegexOption.IGNORE_CASE)

/** `m:ss` from seconds, for the question's countdown. */
fun countdown(seconds: Long): String = "%d:%02d".format(seconds / 60, seconds % 60)

/**
 * A question the agent waits on (`clarify`), above the composer: the choices as numbered rows
 * — a tap answers — and a line for one's own answer, Skip and Send. It counts down to
 * `expires_at`; the agent's suggested choice carries a «Recommended» badge.
 */
@Composable
fun QuestionCard(approval: Approval, onAnswer: (String) -> Unit, onSkip: () -> Unit) {
    val t = LocalTokens.current
    var own by rememberSaveable(approval.id) { mutableStateOf("") }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(approval.id) { while (true) { now = System.currentTimeMillis(); delay(1_000) } }
    val left = approval.expiresAt?.let { ((it.toInstant().toEpochMilli() - now) / 1000).coerceAtLeast(0) }
    Surface(color = t.surface, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().border(0.5.dp, t.borderStrong, MaterialTheme.shapes.large)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Glyphs.Help, null, modifier = Modifier.size(16.dp), tint = t.accent)
                Spacer(Modifier.size(6.dp))
                Text(stringResource(R.string.question_title), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                if (left != null) Text(stringResource(R.string.question_left, countdown(left)), style = MaterialTheme.typography.labelSmall, color = t.textMuted)
                IconButton(onClick = onSkip) { Icon(Icons.Default.Close, stringResource(R.string.question_skip), modifier = Modifier.size(16.dp)) }
            }
            InContentDirection(approval.title) { Text(approval.title, style = MaterialTheme.typography.titleSmall.merge(contentStyle)) }
            approval.choices.forEachIndexed { index, choice ->
                val recommended = RECOMMENDED.containsMatchIn(choice.label)
                Surface(color = t.surface2, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().clickable { onAnswer(choice.value) }) {
                    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("${index + 1}", style = MaterialTheme.typography.labelLarge, color = t.accent)
                        val label = choice.label.replace(RECOMMENDED, "")
                        InContentDirection(label) {
                            Text(label, style = MaterialTheme.typography.bodyMedium.merge(contentStyle), modifier = Modifier.weight(1f))
                        }
                        if (recommended) ProfileBadge(stringResource(R.string.question_recommended))
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = own, onValueChange = { own = it }, singleLine = true,
                    placeholder = { Text(stringResource(R.string.question_own)) },
                    textStyle = MaterialTheme.typography.bodyMedium.merge(contentStyle),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { if (own.isNotBlank()) onAnswer(own.trim()) }),
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { if (own.isNotBlank()) onAnswer(own.trim()) }, enabled = own.isNotBlank()) {
                    Text(stringResource(R.string.question_send))
                }
            }
        }
    }
}

/**
 * The floating composer (glass, DESIGN.md). While a run is alive Stop sits beside Send; a
 * message sent then waits in the hub's queue behind the run.
 */
@Composable
fun Composer(
    text: String,
    onText: (String) -> Unit,
    placeholder: String,
    running: Boolean,
    sending: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    extra: @Composable () -> Unit = {},
) {
    val t = LocalTokens.current
    val shape = RoundedCornerShape(24.dp)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).glass(t, LocalGlassLevel.current, shape).padding(4.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        extra()
        TextField(
            value = text,
            onValueChange = onText,
            placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            textStyle = MaterialTheme.typography.bodyLarge.merge(contentStyle),
            maxLines = 6,
            colors = TextFieldDefaults.colors(
                focusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                unfocusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                disabledContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
            ),
            modifier = Modifier.weight(1f),
        )
        if (running) {
            IconButton(onClick = onStop) { Icon(Glyphs.Stop, stringResource(R.string.chat_stop), tint = t.danger) }
        }
        FilledIconButton(
            onClick = onSend,
            enabled = text.isNotBlank() && !sending,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = t.accent, contentColor = t.accentText),
        ) {
            Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.chat_send))
        }
    }
}

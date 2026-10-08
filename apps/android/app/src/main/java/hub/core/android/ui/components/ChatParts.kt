package hub.core.android.ui.components

import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.AbsoluteRoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.chat.ChatMessage
import hub.core.android.chat.Turn
import hub.core.android.generated.ControlTokens
import hub.core.android.generated.FontTokens
import hub.core.android.generated.LayoutTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.ItemShape
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.kit.floatingChrome
import hub.core.android.ui.theme.LocalReducedMotion
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.Mono
import hub.core.client.model.Approval
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalKind
import hub.core.client.model.ToolCall
import hub.core.client.model.ToolCallStatus
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private val contentStyle = TextStyle(textDirection = TextDirection.Content)
private val big = RadiusTokens.lg.dp
private val small = RadiusTokens.sm.dp

/**
 * One turn. **The person is always on the right, the agent always on the left, in every
 * locale** (DESIGN.md, owner decision 2026-09-22): the row fixes its own direction to LTR and
 * the content inside keeps deciding its own. As on iOS: the header once per turn — «You», or the
 * agent's face and name — then the person's filled bubbles or the agent's solid cards.
 */
@Composable
fun TurnView(
    turn: Turn,
    youLabel: String,
    profile: String = "",
    mine: Boolean = turn.fromPerson,
    agent: AgentIdentity? = null,
    /** The message whose time shows under it (a light tap toggles it; tester feedback, 2026-10-05). */
    timeShown: String? = null,
    /** A light tap on a message: the screen shows its time, or hides it again. */
    onTapMessage: ((ChatMessage) -> Unit)? = null,
) {
    val t = LocalTokens.current
    val uiDirection = LocalLayoutDirection.current
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val maxBubble = maxWidth * LayoutTokens.bubbleMaxFraction
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(LayoutTokens.groupGap.dp),
            ) {
                // An agent's turn wears its face and its registry name (never the placeholder
                // «agent»); in a room another person is on the left under their own name.
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!mine && agent != null) AgentAvatar(agent, profile, LayoutTokens.avatarSm.dp)
                    CompositionLocalProvider(LocalLayoutDirection provides uiDirection) {
                        Text(
                            when {
                                mine -> youLabel
                                agent != null -> agent.name
                                else -> turn.authorName
                            },
                            fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted,
                        )
                    }
                }
                val reply = LocalMessageActions.current?.reply
                turn.messages.forEach { message ->
                    CompositionLocalProvider(LocalLayoutDirection provides uiDirection) {
                        // Swipe toward the reading start to reply (§150); never on a reply still
                        // streaming or the empty shell a run opens with.
                        SwipeToReply(
                            enabled = reply != null && !message.streaming && !message.isEmpty,
                            onReply = { reply?.invoke(message) },
                        ) {
                            val onTap = onTapMessage?.let { tap -> { tap(message) } }
                            if (mine) PersonBubble(message, Modifier.widthIn(max = maxBubble), profile, onTap) else AgentMessage(message, profile, onTap)
                        }
                        val createdAt = message.createdAt
                        if (timeShown == message.id && createdAt != null) MessageTimeLine(createdAt)
                    }
                }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun PersonBubble(message: ChatMessage, modifier: Modifier, profile: String, onTap: (() -> Unit)?) {
    val t = LocalTokens.current
    // The corner nearest the person's own side (the right, always) is the tightened one.
    val shape = AbsoluteRoundedCornerShape(topLeft = big, topRight = small, bottomRight = big, bottomLeft = big)
    // In a chat, a long press on your message offers copy, reply and fork (apps batch 1).
    val actions = LocalMessageActions.current
    val clipboard = LocalClipboardManager.current
    var menu by remember { mutableStateOf(false) }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
      Box {
        Column(
            modifier.background(t.userBubble, shape).border(1.dp, t.userBubbleBorder, shape)
                .then(
                    if (actions != null && message.text.isNotEmpty()) {
                        Modifier.clip(shape).combinedClickable(onClick = { onTap?.invoke() }, onLongClick = { menu = true })
                    } else if (onTap != null) {
                        Modifier.clip(shape).clickable(onClick = onTap)
                    } else Modifier,
                )
                .padding(horizontal = 12.dp, vertical = 8.dp).testTag("message.user"),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (message.text.isNotEmpty()) {
                InContentDirection(message.text) {
                    Text(message.text, fontSize = FontTokens.sizeMd.sp, color = t.userBubbleText, style = contentStyle, lineHeight = FontTokens.leadingNormal.em)
                }
            }
            MessageFiles(message.attachments, profile)
        }
        if (actions != null) {
            hub.core.android.ui.kit.HubMenu(menu, { menu = false }) {
                MessageActionItems(message, actions, copy = { clipboard.setText(AnnotatedString(message.text)) }) { menu = false }
            }
        }
      }
    }
}

@Composable
private fun AgentMessage(message: ChatMessage, profile: String, onTap: (() -> Unit)?) {
    val t = LocalTokens.current
    val clipboard = LocalClipboardManager.current
    val shape = AbsoluteRoundedCornerShape(topLeft = small, topRight = big, bottomRight = big, bottomLeft = big)
    // A long press on a reply opens the same menu as a long press on yours (§150): copy, read
    // aloud, reply, fork. The «…» under it stays; this is one more way in. Not while it streams.
    val longPressActions = LocalMessageActions.current
    var pressMenu by remember { mutableStateOf(false) }
    val pressable = longPressActions != null && !message.streaming && message.text.isNotBlank()
    // A light tap shows its time (tester feedback, 2026-10-05). Its buttons, links, files and
    // steps take their own taps first, so this is only the card and its words.
    val tap by androidx.compose.runtime.rememberUpdatedState(onTap)
    val tappable = onTap != null
    Box {
    Column(
        Modifier.fillMaxWidth().background(t.agentBubble, shape).border(1.dp, t.agentBubbleBorder, shape)
            .then(
                if (pressable || tappable) {
                    Modifier.pointerInput(message.id, pressable, tappable) {
                        val longPress: ((androidx.compose.ui.geometry.Offset) -> Unit)? =
                            if (pressable) { _ -> pressMenu = true } else null
                        val lightTap: ((androidx.compose.ui.geometry.Offset) -> Unit)? =
                            if (tappable) { _ -> tap?.invoke() } else null
                        detectTapGestures(onLongPress = longPress, onTap = lightTap)
                    }
                } else Modifier,
            )
            .padding(if (hub.core.android.ui.screens.LocalChatDisplay.current.compact) 8.dp else 12.dp).testTag("message.agent"),
        verticalArrangement = Arrangement.spacedBy(if (hub.core.android.ui.screens.LocalChatDisplay.current.compact) 4.dp else 8.dp),
    ) {
        CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides t.agentBubbleText) {
            // The person's Display preferences (HubDisplay.kt): reasoning and tool calls may be hidden.
            val display = hub.core.android.ui.screens.LocalChatDisplay.current
            if (display.showReasoning && !message.streaming && message.reasoning.isNotBlank()) ReasoningFold(message.reasoning, message.reasoningMs)
            if (display.showToolCalls) ToolActivityView(message.toolCalls, live = message.streaming)
            // A link in the reply that names one of its files opens it (FileLinkHandler).
            if (message.text.isNotBlank()) FileLinkHandler(message.attachments, profile) { MarkdownView(message.text) }
            MessageFiles(message.attachments, profile)
            if (!message.streaming && message.text.isNotBlank()) {
                val actions = LocalMessageActions.current
                var menu by remember { mutableStateOf(false) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    HubIconButton(
                        Lucide.Copy, stringResource(R.string.chat_copy), { clipboard.setText(AnnotatedString(message.text)) },
                        size = ControlTokens.heightSm.dp, iconSize = 14.dp, tint = t.textFaint,
                    )
                    // In a chat: «…» for read aloud, reply and fork from here (apps batch 1).
                    if (actions != null) {
                        Box {
                            HubIconButton(
                                Lucide.Ellipsis, stringResource(R.string.chat_controls_message_actions), { menu = true },
                                size = ControlTokens.heightSm.dp, iconSize = 14.dp, tint = t.textFaint, modifier = Modifier.testTag("message.more"),
                            )
                            hub.core.android.ui.kit.HubMenu(menu, { menu = false }) {
                                MessageActionItems(message, actions, copy = null) { menu = false }
                            }
                        }
                    }
                }
            }
        }
    }
    if (pressable && longPressActions != null) {
        hub.core.android.ui.kit.HubMenu(pressMenu, { pressMenu = false }) {
            MessageActionItems(message, longPressActions, copy = { clipboard.setText(AnnotatedString(message.text)) }) { pressMenu = false }
        }
    }
    }
}

/** The time a message was said, small and faint, under it on its own side (MessageTime). */
@Composable
private fun MessageTimeLine(createdAt: java.time.OffsetDateTime) {
    val t = LocalTokens.current
    // «Yesterday %1$s», filled with the clock time once the rule knows it is yesterday.
    val yesterday = stringResource(R.string.chat_time_yesterday)
    val text = hub.core.android.chat.MessageTime.text(createdAt) { clock -> String.format(java.util.Locale.getDefault(), yesterday, clock) }
    Text(
        text, fontSize = FontTokens.sizeXs.sp, color = t.textFaint,
        modifier = Modifier.padding(horizontal = 4.dp).testTag("message.time"),
    )
}

/** After a run, the reasoning is history: one quiet line, the text behind a closed disclosure. */
@Composable
private fun ReasoningFold(text: String, durationMs: Int?) {
    val t = LocalTokens.current
    var open by rememberSaveable { mutableStateOf(false) }
    Column {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (durationMs != null) stringResource(R.string.chat_thought_for, (durationMs + 500) / 1000)
                else stringResource(R.string.chat_reasoning),
                fontSize = FontTokens.sizeSm.sp, color = t.textMuted, modifier = Modifier.weight(1f),
            )
            LucideIcon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, null, size = 16.dp, tint = t.textMuted)
        }
        if (open) {
            InContentDirection(text) {
                Text(text, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, style = contentStyle, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

private val pretty = Json { prettyPrint = true }

/**
 * A tool call, as on iOS: its state as an icon, its name in mono, a one-line preview and the
 * time it took; opened, the arguments and the output.
 */
@Composable
fun ToolCallCard(call: ToolCall) {
    val t = LocalTokens.current
    var open by rememberSaveable(call.id) { mutableStateOf(false) }
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Column(
            Modifier.fillMaxWidth().background(t.surface2, RoundedCornerShape(RadiusTokens.md.dp))
                .clickable { open = !open }.padding(horizontal = 8.dp, vertical = 7.dp).testTag("tool.${call.name}"),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (call.status) {
                    ToolCallStatus.RUNNING -> Spinner(16.dp, t.textMuted)
                    ToolCallStatus.AWAITING_APPROVAL -> LucideIcon(Lucide.Hand, null, size = 16.dp, tint = t.warningSoftText)
                    ToolCallStatus.SUCCEEDED -> LucideIcon(Lucide.CircleCheck, stringResource(R.string.chat_tool_done), size = 16.dp, tint = t.statusRunning)
                    else -> LucideIcon(Lucide.CircleX, stringResource(R.string.chat_tool_failed), size = 16.dp, tint = t.danger)
                }
                Text(call.name, fontFamily = Mono, fontWeight = FontWeight.SemiBold, fontSize = FontTokens.sizeSm.sp, color = t.text)
                Text(
                    call.preview.orEmpty(), fontFamily = Mono, fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                call.durationMs?.let {
                    Text(stringResource(R.string.chat_seconds, it / 1000.0), fontSize = FontTokens.sizeXs.sp, color = t.textFaint)
                }
                LucideIcon(if (open) Lucide.ChevronUp else Lucide.ChevronDown, null, size = 14.dp, tint = t.textFaint)
            }
            if (open) {
                call.arguments?.takeIf { it.isNotEmpty() }?.let { args ->
                    Text(stringResource(R.string.chat_tool_arguments), fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted)
                    CodeText(pretty.encodeToString(JsonObject.serializer(), JsonObject(args)))
                }
                call.output?.takeIf { it.isNotEmpty() }?.let { out ->
                    Text(stringResource(R.string.chat_tool_output), fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted)
                    CodeText(out + if (call.outputTruncated) "\n…" else "")
                }
            }
        }
    }
}

@Composable
private fun CodeText(text: String) {
    val t = LocalTokens.current
    Box(
        Modifier.fillMaxWidth().heightIn(max = 240.dp).background(t.codeBg, RoundedCornerShape(RadiusTokens.sm.dp))
            .verticalScroll(rememberScrollState()),
    ) {
        Text(
            text, fontFamily = Mono, color = t.codeText, softWrap = false, fontSize = FontTokens.sizeXs.sp,
            style = TextStyle(textDirection = TextDirection.Ltr),
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
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("chat.thinking"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Dots(reduced)
        val parts = buildList {
            add(stringResource(if (queued) R.string.chat_queued else R.string.chat_thinking))
            if (seconds != null) add(stringResource(R.string.chat_seconds_short, seconds))
            if (!step.isNullOrBlank()) add(step)
        }
        Text(parts.joinToString(" · "), fontSize = FontTokens.sizeSm.sp, color = t.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Dots(reduced: Boolean) {
    val t = LocalTokens.current
    val transition = rememberInfiniteTransition(label = "thinking")
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        repeat(3) { i ->
            val alpha = if (reduced) 1f else transition.animateFloat(
                initialValue = 0.35f, targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(600, delayMillis = i * 150), RepeatMode.Reverse), label = "dot$i",
            ).value
            Box(Modifier.size(6.dp).alpha(alpha).background(t.thinking, CircleShape))
        }
    }
}

/**
 * A decision the agent is blocked on, as on iOS: who asks and what, the exact command, then
 * «allow once» as the one primary action and the others quieter beside it — deny in red.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ApprovalCard(approval: Approval, onRespond: (ApprovalDecision) -> Unit) {
    val t = LocalTokens.current
    val shape = RoundedCornerShape(RadiusTokens.lg.dp)
    Column(
        Modifier.fillMaxWidth().background(t.surface, shape).background(t.warningSoft.copy(alpha = 0.35f), shape)
            .border(1.dp, t.border, shape).padding(12.dp).testTag("approval.${approval.id}"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LucideIcon(Lucide.Hand, null, size = 14.dp, tint = t.warningSoftText)
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
                fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = t.warningSoftText,
            )
        }
        InContentDirection(approval.title) {
            Text(approval.title, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, color = t.text, style = contentStyle)
        }
        approval.description?.takeIf { it.isNotBlank() }?.let { d ->
            InContentDirection(d) { Text(d, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, style = contentStyle) }
        }
        approval.command?.takeIf { it.isNotBlank() }?.let { CodeText(it) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            HubButton(stringResource(R.string.approval_once), { onRespond(ApprovalDecision.APPROVE_ONCE) }, size = ControlSize.Md)
            HubButton(stringResource(R.string.approval_session), { onRespond(ApprovalDecision.APPROVE_SESSION) }, kind = ButtonKind.Secondary, size = ControlSize.Md)
            if (approval.allowAlways) {
                HubButton(stringResource(R.string.approval_always), { onRespond(ApprovalDecision.APPROVE_ALWAYS) }, kind = ButtonKind.Secondary, size = ControlSize.Md)
            }
            HubButton(stringResource(R.string.approval_deny), { onRespond(ApprovalDecision.DENY) }, kind = ButtonKind.Danger, size = ControlSize.Md)
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
    val shape = RoundedCornerShape(RadiusTokens.lg.dp)
    Column(
        Modifier.fillMaxWidth().background(t.surface, shape).border(1.dp, t.borderStrong.copy(alpha = 0.6f), shape).padding(12.dp)
            .testTag("question.${approval.id}"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LucideIcon(Lucide.CircleQuestionMark, null, size = 16.dp, tint = t.accent)
            Text(stringResource(R.string.question_title), fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted, modifier = Modifier.weight(1f))
            if (left != null) Badge(stringResource(R.string.question_left, countdown(left)), tone = BadgeTone.Neutral)
            HubIconButton(Lucide.X, stringResource(R.string.question_skip), onSkip, size = ControlTokens.heightSm.dp, iconSize = 14.dp)
        }
        InContentDirection(approval.title) {
            Text(approval.title, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, style = contentStyle)
        }
        approval.choices.forEachIndexed { index, choice ->
            val recommended = RECOMMENDED.containsMatchIn(choice.label)
            Row(
                Modifier.fillMaxWidth().background(t.surface2, ItemShape).clickable { onAnswer(choice.value) }.padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("${index + 1}", fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.SemiBold, color = t.accent)
                val label = choice.label.replace(RECOMMENDED, "")
                InContentDirection(label) {
                    Text(label, fontSize = FontTokens.sizeSm.sp, style = contentStyle, modifier = Modifier.weight(1f))
                }
                if (recommended) Badge(stringResource(R.string.question_recommended), tone = BadgeTone.Accent)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HubTextField(
                own, { own = it }, placeholder = stringResource(R.string.question_own), size = ControlSize.Md,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (own.isNotBlank()) onAnswer(own.trim()) }),
                modifier = Modifier.weight(1f),
            )
            HubButton(stringResource(R.string.question_send), { if (own.isNotBlank()) onAnswer(own.trim()) }, size = ControlSize.Md, enabled = own.isNotBlank())
        }
    }
}

/**
 * The floating composer (glass, DESIGN.md), laid out as on iOS and the web: «+» at the start,
 * the text, then the microphone and Send at the end — Send an accent disc with an arrow when
 * there is something to send, a quiet disc otherwise. While a run is alive and nothing is typed,
 * Stop takes Send's place; a message sent then waits in the hub's queue behind the run.
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
    /** The «+» (files and photos); at the start of the field. */
    leading: @Composable () -> Unit = {},
    /** The microphone; at the end, before Send. */
    trailing: @Composable () -> Unit = {},
    /** Files are attached and uploaded: the message may go without words. */
    hasAttachments: Boolean = false,
    /** Lets the screen put the cursor in the field (a reply chosen from a message, §150). */
    focus: androidx.compose.ui.focus.FocusRequester? = null,
    /** Send's spoken name, when it says more than «Send» (e.g. «Send on Telegram», §153). */
    sendLabel: String? = null,
) {
    val t = LocalTokens.current
    val canSend = (text.isNotBlank() || hasAttachments) && !sending
    val style = TextStyle(color = t.text, fontSize = FontTokens.sizeMd.sp, textDirection = TextDirection.Content, lineHeight = 1.4.em)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).floatingChrome()
            .padding(horizontal = 4.dp, vertical = 4.dp).testTag("composer"),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        leading()
        BasicTextField(
            value = text,
            onValueChange = onText,
            textStyle = style,
            maxLines = 6,
            cursorBrush = SolidColor(t.accent),
            modifier = Modifier.weight(1f).defaultMinSize(minHeight = ControlTokens.heightMd.dp)
                .then(if (focus != null) Modifier.focusRequester(focus) else Modifier).testTag("composer.input"),
            decorationBox = { inner ->
                Box(Modifier.defaultMinSize(minHeight = ControlTokens.heightMd.dp).padding(horizontal = 6.dp, vertical = 6.dp), contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) Text(placeholder, style = style.copy(color = t.textFaint), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
            },
        )
        trailing()
        if (running && text.isBlank() && !hasAttachments) {
            StopButton(stringResource(R.string.chat_stop), onStop, Modifier.testTag("composer.stop"))
        } else {
            HubIconButton(
                Lucide.ArrowUp, sendLabel ?: stringResource(R.string.chat_send), onSend,
                kind = IconKind.Accent, enabled = canSend, size = ControlTokens.heightMd.dp, iconSize = 18.dp,
                modifier = Modifier.testTag("composer.send"),
            )
        }
    }
}

/** Stop: a filled square on the danger disc, the size of Send. */
@Composable
fun StopButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, size: androidx.compose.ui.unit.Dp = ControlTokens.heightMd.dp) {
    val t = LocalTokens.current
    Box(
        modifier.size(size).background(t.danger, CircleShape).clickable(onClickLabel = label, role = androidx.compose.ui.semantics.Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(size * 0.34f).background(t.dangerText, RoundedCornerShape(2.dp)))
    }
}

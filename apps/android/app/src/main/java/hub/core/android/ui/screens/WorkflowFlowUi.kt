package hub.core.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.InContentDirection
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Chip
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubCheckbox
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.ItemShape
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.ToggleRow
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Session
import hub.core.client.model.WorkflowFailureAlert
import hub.core.client.model.WorkflowNode
import hub.core.client.model.WorkflowRules
import hub.core.client.model.WorkflowSend
import hub.core.client.model.WorkflowSendResult
import hub.core.client.model.WorkflowStepTestResult
import hub.core.client.model.WorkflowTrigger
import hub.core.client.model.WorkflowTriggerDelivery
import hub.core.client.model.WorkflowTriggerDeliveryStatus
import hub.core.client.model.WorkflowTriggerPatch
import hub.core.client.model.WorkflowTriggerPreset
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * The editor's new sections on the phone (WorkflowFlow.kt has their rules): a condition's several
 * rules, a "Send message" step's targets and its test, the failure alert, "Test this step", and a
 * saved workflow's Triggers. The words are the web's (strings_workflow_tools.xml); ids, addresses,
 * events and JSON read left to right in a monospace face, a person's words in their own direction.
 */

/** Text that is an id, an address, an event or JSON: left to right, monospace, whatever the UI language. */
@Composable
internal fun LtrMono(text: String, modifier: Modifier = Modifier, size: TextUnit = FontTokens.sizeXs.sp, color: androidx.compose.ui.graphics.Color? = null) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Text(
            text, modifier, fontSize = size, fontFamily = FontFamily.Monospace, color = color ?: LocalTokens.current.text,
            style = TextStyle(textDirection = TextDirection.Ltr),
        )
    }
}

/** Calls [onDone] when focus leaves the field (the web's onBlur): a value "saved when editing ends". */
@Composable
private fun editingEnd(onDone: () -> Unit): Modifier {
    val had = remember { booleanArrayOf(false) }
    val latest by androidx.compose.runtime.rememberUpdatedState(onDone)
    return Modifier.onFocusChanged { state ->
        if (had[0] && !state.hasFocus) latest()
        had[0] = state.hasFocus
    }
}

@Composable
internal fun operatorWords(op: String): String = when (op) {
    "==" -> stringResource(R.string.wfe_op_eq)
    "!=" -> stringResource(R.string.wfe_op_ne)
    ">" -> stringResource(R.string.wfe_op_gt)
    ">=" -> stringResource(R.string.wfe_op_gte)
    "<" -> stringResource(R.string.wfe_op_lt)
    "<=" -> stringResource(R.string.wfe_op_lte)
    "contains" -> stringResource(R.string.wfe_op_contains)
    "matches" -> stringResource(R.string.wfe_op_matches)
    "exists" -> stringResource(R.string.wfe_op_exists)
    "empty" -> stringResource(R.string.wfe_op_empty)
    // An operator this app does not know is shown, and kept, as it is.
    else -> op
}

/** A comparison picked from the operator words, as a button that opens a menu. */
@Composable
private fun OperatorPicker(op: String, onPick: (String) -> Unit, tag: String) {
    var open by remember { mutableStateOf(false) }
    Box {
        HubButton(
            operatorWords(op), { open = true }, kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.ChevronDown,
            modifier = Modifier.testTag(tag),
        )
        HubMenu(open, { open = false }) {
            WorkflowDraftRules.OPERATORS.forEach { o ->
                MenuItem(operatorWords(o), { open = false; onPick(o) }, checked = o == op, modifier = Modifier.testTag("$tag.$o"))
            }
        }
    }
}

// ---------------------------------------------------------------------- several rules (§123)

/** A condition's several rules: all must hold or any one; each a path, a comparison and a value. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RulesForm(node: WorkflowNode, draft: WorkflowDraft, rules: WorkflowRules, onRules: (WorkflowRules) -> Unit) {
    val t = LocalTokens.current
    val suggestions = WorkflowFlowRules.suggestions(draft, node.id)
    var focused by remember(node.id) { mutableStateOf<Int?>(null) }
    Column(Modifier.testTag("workflow.editor.step.${node.id}.rules"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.wft_rules_match), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        Segmented(
            listOf(
                Segment(WorkflowRules.Match.ALL, stringResource(R.string.wft_rules_all), tag = "workflow.editor.step.${node.id}.match.all"),
                Segment(WorkflowRules.Match.ANY, stringResource(R.string.wft_rules_any), tag = "workflow.editor.step.${node.id}.match.any"),
            ),
            rules.match, { onRules(rules.copy(match = it)) }, Modifier.fillMaxWidth(), size = ControlSize.Sm,
        )
        rules.items.forEachIndexed { index, rule ->
            val tag = "workflow.editor.step.${node.id}.rule.$index"
            Column(
                Modifier.fillMaxWidth().background(t.surface2, ItemShape).padding(8.dp).testTag(tag),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                HubTextField(
                    rule.path, { v -> onRules(WorkflowFlowRules.setRule(rules, index) { it.copy(path = v) }) },
                    Modifier.fillMaxWidth().onFocusChanged { if (it.hasFocus) focused = index },
                    placeholder = "trigger.event", label = stringResource(R.string.wfe_condition_path), mono = true, size = ControlSize.Md,
                    fieldTag = "$tag.path",
                )
                if (focused == index) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        suggestions.forEach { path ->
                            Chip(path, rule.path == path, { onRules(WorkflowFlowRules.setRule(rules, index) { it.copy(path = path) }) }, size = ControlSize.Sm)
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.weight(1f)) {
                        OperatorPicker(rule.operator, { o -> onRules(WorkflowFlowRules.setRule(rules, index) { it.copy(operator = o) }) }, "$tag.operator")
                    }
                    HubIconButton(
                        Lucide.X, stringResource(R.string.wft_rules_remove), { onRules(WorkflowFlowRules.removeRule(rules, index)) },
                        enabled = rules.items.size > 1, size = 32.dp, iconSize = 16.dp, modifier = Modifier.testTag("$tag.remove"),
                    )
                }
                if (rule.operator !in WorkflowDraftRules.UNARY) {
                    HubTextField(
                        rule.value.orEmpty(), { v -> onRules(WorkflowFlowRules.setRule(rules, index) { it.copy(value = v) }) },
                        Modifier.fillMaxWidth(), label = stringResource(R.string.wfe_condition_value), size = ControlSize.Md, fieldTag = "$tag.value",
                    )
                }
            }
        }
        HubButton(
            stringResource(R.string.wft_rules_add), { onRules(WorkflowFlowRules.addRule(rules)) }, kind = ButtonKind.Secondary,
            size = ControlSize.Sm, icon = Lucide.Plus, modifier = Modifier.testTag("workflow.editor.step.${node.id}.rule.add"),
        )
        Text(stringResource(R.string.wft_rules_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    }
}

// ---------------------------------------------------------------------- Send message (§124)

/** Telegram and/or a conversation of this hub, as a `WorkflowSend`'s targets; targets of other platforms stay. */
@Composable
internal fun SendTargetsForm(
    send: WorkflowSend,
    profile: String,
    ops: WorkflowFlowOps,
    tag: String,
    /** Offer Telegram formatting (§137): a step's words; a failure alert is always plain. */
    formatting: Boolean = false,
    onChange: (WorkflowSend) -> Unit,
) {
    val t = LocalTokens.current
    val telegram = WorkflowFlowRules.target(send, "telegram")
    val conversation = WorkflowFlowRules.target(send, "core_hub")
    var chat by remember(tag) { mutableStateOf(telegram?.chatId.orEmpty()) }
    var conversations by remember(profile) { mutableStateOf<List<Session>?>(null) }
    LaunchedEffect(profile, conversation != null) {
        if (conversation != null && conversations == null) ops.conversations(profile).onSuccess { conversations = it }
    }
    CheckRow(stringResource(R.string.wft_send_telegram), telegram != null, "$tag.telegram") { on ->
        onChange(WorkflowFlowRules.setTarget(send, "telegram", if (on) WorkflowFlowRules.telegram(chat, if (formatting) "plain" else null) else null))
    }
    if (telegram != null) {
        HubTextField(
            chat, { v -> chat = v; onChange(WorkflowFlowRules.setTarget(send, "telegram", WorkflowFlowRules.telegram(v, telegram.formatting))) },
            Modifier.fillMaxWidth(), placeholder = "-1001234567890", label = stringResource(R.string.wft_send_chat_id), mono = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text), size = ControlSize.Md, fieldTag = "$tag.chat",
        )
        Text(stringResource(R.string.wft_send_telegram_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        if (formatting) FormattingPicker(send, WorkflowFlowRules.formattingOf(telegram), tag, onChange)
    }
    CheckRow(stringResource(R.string.wft_send_conversation), conversation != null, "$tag.conversation") { on ->
        onChange(WorkflowFlowRules.setTarget(send, "core_hub", if (on) WorkflowFlowRules.conversation(null) else null))
    }
    if (conversation != null) {
        var open by remember { mutableStateOf(false) }
        val untitled = stringResource(R.string.wft_send_untitled)
        Box {
            HubButton(
                conversation.title?.takeIf { it.isNotBlank() } ?: conversation.sessionId?.let { untitled } ?: stringResource(R.string.wft_send_pick),
                { open = true }, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.MessagesSquare,
                modifier = Modifier.testTag("$tag.session"),
            )
            HubMenu(open, { open = false }) {
                conversations.orEmpty().forEach { session ->
                    MenuItem(
                        session.title?.takeIf { it.isNotBlank() } ?: untitled,
                        { open = false; onChange(WorkflowFlowRules.setTarget(send, "core_hub", WorkflowFlowRules.conversation(session))) },
                        checked = session.id == conversation.sessionId, modifier = Modifier.testTag("$tag.session.${session.id}"),
                    )
                }
            }
        }
        Text(stringResource(R.string.wft_send_conversation_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    }
}

/** How Telegram reads the words (§137): plain text, HTML or MarkdownV2, with what each means. */
@Composable
private fun FormattingPicker(send: WorkflowSend, current: String, tag: String, onChange: (WorkflowSend) -> Unit) {
    val t = LocalTokens.current
    var open by remember { mutableStateOf(false) }
    val name = @Composable { value: String ->
        when (value) {
            "html" -> stringResource(R.string.wft_send_formatting_html)
            "markdown_v2" -> stringResource(R.string.wft_send_formatting_markdown_v2)
            else -> stringResource(R.string.wft_send_formatting_plain)
        }
    }
    Text(stringResource(R.string.wft_send_formatting), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium)
    Box {
        HubButton(
            name(current), { open = true }, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.Type,
            modifier = Modifier.testTag("$tag.formatting"),
        )
        HubMenu(open, { open = false }) {
            WorkflowFlowRules.FORMATTINGS.forEach { value ->
                MenuItem(
                    name(value), { open = false; onChange(WorkflowFlowRules.withFormatting(send, value)) },
                    checked = value == current, modifier = Modifier.testTag("$tag.formatting.$value"),
                )
            }
        }
    }
    Text(
        stringResource(
            when (current) {
                "html" -> R.string.wft_send_formatting_html_hint
                "markdown_v2" -> R.string.wft_send_formatting_markdown_v2_hint
                else -> R.string.wft_send_formatting_plain_hint
            },
        ),
        fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
    )
}

@Composable
private fun CheckRow(label: String, checked: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = 6.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        HubCheckbox(checked, onChange)
        Text(label, fontSize = FontTokens.sizeMd.sp, color = LocalTokens.current.text)
    }
}

/** A "Send message" step: where its words go, and "Send test message". */
@Composable
internal fun SendStepForm(node: WorkflowNode, profile: String, ops: WorkflowFlowOps, onNode: (WorkflowNode) -> Unit) {
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val send = node.send ?: WorkflowSend(emptyList())
    var busy by remember(node.id) { mutableStateOf(false) }
    var result by remember(node.id) { mutableStateOf<WorkflowSendResult?>(null) }
    var error by remember(node.id) { mutableStateOf<HubError?>(null) }
    // A value for each variable of the words, typed for the test (2026-09-29).
    var values by remember(node.id) { mutableStateOf(mapOf<String, String>()) }
    val variables = WorkflowFlowRules.variablesIn(node.input)
    val missing = WorkflowFlowRules.missingIn(node.input, values)
    Column(Modifier.testTag("workflow.editor.step.${node.id}.send"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.wft_send_targets), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium)
        SendTargetsForm(send, profile, ops, "workflow.editor.step.${node.id}.send", formatting = true) { next -> onNode(node.copy(send = next)) }
        if (variables.isNotEmpty()) {
            Text(stringResource(R.string.wft_send_sample_title), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium)
            Text(stringResource(R.string.wft_send_sample_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            variables.forEach { path ->
                HubTextField(
                    values[path].orEmpty(), { values = values + (path to it) },
                    label = "{{$path}}", singleLine = false, maxLines = 4, size = ControlSize.Md,
                    fieldTag = "workflow.editor.step.${node.id}.send.value.$path",
                )
            }
        }
        if (!node.input.isNullOrBlank()) {
            Text(stringResource(R.string.wft_send_preview), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium)
            val preview = WorkflowFlowRules.fill(node.input, values).trim()
            InContentDirection(preview) {
                Text(preview, Modifier.testTag("workflow.editor.step.${node.id}.send.preview"), fontSize = FontTokens.sizeSm.sp, color = t.text)
            }
        }
        if (missing.isNotEmpty()) {
            Text(
                stringResource(R.string.wft_send_missing, missing.joinToString(" ") { "{{$it}}" }),
                Modifier.testTag("workflow.editor.step.${node.id}.send.missing"), fontSize = FontTokens.sizeXs.sp, color = t.danger,
            )
        }
        HubButton(
            stringResource(R.string.wft_send_test),
            {
                busy = true
                error = null
                scope.launch {
                    ops.testSend(profile, WorkflowFlowRules.sendTest(send, node.input, values))
                        .onSuccess { result = it }.onFailure { error = it as? HubError; result = null }
                    busy = false
                }
            },
            kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Send, loading = busy,
            enabled = WorkflowFlowRules.canTestSend(send, node.input, values), modifier = Modifier.testTag("workflow.editor.step.${node.id}.send.test"),
        )
        ErrorNotice(error)
        result?.let { r ->
            Text(
                stringResource(
                    when (r.status) {
                        WorkflowSendResult.Status.SENT -> R.string.wft_send_status_sent
                        WorkflowSendResult.Status.PARTIAL -> R.string.wft_send_status_partial
                        WorkflowSendResult.Status.FAILED -> R.string.wft_send_status_failed
                    },
                ),
                Modifier.testTag("workflow.editor.step.${node.id}.send.result"), fontSize = FontTokens.sizeXs.sp,
            )
            r.failures.forEach { f ->
                val line = "${f.target}: ${f.reason}"
                InContentDirection(line) { Text(line, fontSize = FontTokens.sizeXs.sp, color = t.danger) }
            }
        }
    }
}

// ---------------------------------------------------------------------- the failure alert (§127)

/** Who is told when a run fails: the inbox, and optionally the targets of a "Send message" step. */
@Composable
internal fun FailureAlertForm(alert: WorkflowFailureAlert?, profile: String, ops: WorkflowFlowOps, onChange: (WorkflowFailureAlert?) -> Unit) {
    val t = LocalTokens.current
    val inbox = alert?.inbox == true
    val send = alert?.send ?: WorkflowSend(emptyList())
    Column(Modifier.fillMaxWidth().testTag("workflow.editor.alert"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionTitle(stringResource(R.string.wft_alert_title))
        ToggleRow(
            stringResource(R.string.wft_alert_inbox), inbox, { on -> onChange(WorkflowFlowRules.alert(on, send)) },
            Modifier.testTag("workflow.editor.alert.inbox"),
        )
        SendTargetsForm(send, profile, ops, "workflow.editor.alert") { next -> onChange(WorkflowFlowRules.alert(inbox, next)) }
        Text(stringResource(R.string.wft_alert_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    }
}

// ---------------------------------------------------------------------- test this step (§127)

/** "Test this step", folded until asked: a sample input and event; nothing is saved and no run is made. */
@Composable
internal fun StepTestPanel(node: WorkflowNode, profile: String, ops: WorkflowFlowOps) {
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val tag = "workflow.editor.step.${node.id}.test"
    var open by remember(node.id) { mutableStateOf(false) }
    var input by remember(node.id) { mutableStateOf("") }
    var trigger by remember(node.id) { mutableStateOf(WorkflowFlowRules.SAMPLE_TRIGGER) }
    var execute by remember(node.id) { mutableStateOf(false) }
    var badJson by remember(node.id) { mutableStateOf(false) }
    var busy by remember(node.id) { mutableStateOf(false) }
    var result by remember(node.id) { mutableStateOf<WorkflowStepTestResult?>(null) }
    var error by remember(node.id) { mutableStateOf<HubError?>(null) }
    val state = stringResource(if (open) R.string.sidebar_group_expanded else R.string.sidebar_group_collapsed)
    HubButton(
        stringResource(R.string.wft_test_title), { open = !open }, kind = ButtonKind.Ghost, size = ControlSize.Sm,
        icon = if (open) Lucide.ChevronUp else Lucide.ChevronDown, modifier = Modifier.semantics { stateDescription = state }.testTag(tag),
    )
    if (!open) return
    HubTextField(
        input, { input = it }, Modifier.fillMaxWidth(), placeholder = stringResource(R.string.wft_test_input), label = stringResource(R.string.wft_test_input),
        singleLine = false, maxLines = 3, size = ControlSize.Md, fieldTag = "$tag.input",
    )
    HubTextField(
        trigger, { trigger = it }, Modifier.fillMaxWidth(), label = stringResource(R.string.wft_test_trigger), singleLine = false,
        minLines = 4, maxLines = 10, mono = true, size = ControlSize.Md, fieldTag = "$tag.trigger",
    )
    if (badJson) Text(stringResource(R.string.wft_test_bad_json), fontSize = FontTokens.sizeXs.sp, color = t.danger, modifier = Modifier.testTag("$tag.bad_json"))
    if (node.kind == WorkflowNode.Kind.AGENT) {
        CheckRow(stringResource(R.string.wft_test_execute), execute, "$tag.execute") { execute = it }
    }
    HubButton(
        stringResource(R.string.wft_test_run),
        {
            val body = WorkflowFlowRules.stepTest(node, input, trigger, execute)
            badJson = body == null
            if (body != null) {
                busy = true
                error = null
                scope.launch {
                    ops.testStep(profile, body).onSuccess { result = it }.onFailure { error = it as? HubError; result = null }
                    busy = false
                }
            }
        },
        kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Play, loading = busy, modifier = Modifier.testTag("$tag.run"),
    )
    ErrorNotice(error)
    result?.let { r ->
        Column(Modifier.testTag("$tag.result"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            r.answer?.let { yes -> Text(stringResource(if (yes) R.string.wft_test_yes else R.string.wft_test_no), fontSize = FontTokens.sizeXs.sp) }
            r.rendered?.let { words -> SampleBox(words) }
            if (r.executed && node.kind == WorkflowNode.Kind.AGENT) r.output?.let { SampleBox(it) }
            r.error?.let { e -> InContentDirection(e) { Text(e, fontSize = FontTokens.sizeXs.sp, color = t.danger) } }
        }
    }
}

@Composable
private fun SampleBox(text: String) {
    val t = LocalTokens.current
    InContentDirection(text) {
        Text(text, Modifier.fillMaxWidth().background(t.surface2, ItemShape).padding(8.dp), fontSize = FontTokens.sizeXs.sp)
    }
}

// ---------------------------------------------------------------------- triggers (§123)

@Composable
private fun presetLabel(preset: WorkflowTriggerPreset): String = stringResource(
    when (preset) {
        WorkflowTriggerPreset.CLICKUP -> R.string.wft_preset_clickup
        WorkflowTriggerPreset.GITHUB -> R.string.wft_preset_github
        WorkflowTriggerPreset.GENERIC_HMAC -> R.string.wft_preset_generic_hmac
        WorkflowTriggerPreset.TOKEN -> R.string.wft_preset_token
    },
)

@Composable
private fun secretHint(preset: WorkflowTriggerPreset): String = stringResource(
    when (preset) {
        WorkflowTriggerPreset.CLICKUP -> R.string.wft_secret_hint_clickup
        WorkflowTriggerPreset.GITHUB -> R.string.wft_secret_hint_github
        WorkflowTriggerPreset.GENERIC_HMAC -> R.string.wft_secret_hint_generic_hmac
        WorkflowTriggerPreset.TOKEN -> R.string.wft_secret_hint_token
    },
)

@Composable
internal fun deliveryWords(status: WorkflowTriggerDeliveryStatus): String = stringResource(
    when (status) {
        WorkflowTriggerDeliveryStatus.RECEIVED -> R.string.wft_status_received
        WorkflowTriggerDeliveryStatus.DUPLICATE -> R.string.wft_status_duplicate
        WorkflowTriggerDeliveryStatus.SIGNATURE_REJECTED -> R.string.wft_status_signature_rejected
        WorkflowTriggerDeliveryStatus.FILTERED_OUT -> R.string.wft_status_filtered_out
        WorkflowTriggerDeliveryStatus.RUN_STARTED -> R.string.wft_status_run_started
        WorkflowTriggerDeliveryStatus.RUN_SUCCEEDED -> R.string.wft_status_run_succeeded
        WorkflowTriggerDeliveryStatus.RUN_FAILED -> R.string.wft_status_run_failed
    },
)

/**
 * A workflow's inbound triggers: each an address on this hub another service posts events to. A
 * new workflow says to save first; an older hub (404) hides the section.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun WorkflowTriggersSection(workflowId: String?, profile: String, hub: String, ops: WorkflowFlowOps, onShowRun: (String) -> Unit) {
    val t = LocalTokens.current
    val model = remember(profile, workflowId) { workflowId?.let { WorkflowTriggersModel(ops, profile, it) } }
    val ui by (model?.ui ?: remember { kotlinx.coroutines.flow.MutableStateFlow(TriggersUi()) }).collectAsState()
    LaunchedEffect(model) { model?.load() }
    if (!ui.supported) return
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().testTag("workflow.editor.triggers"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle(stringResource(R.string.wft_triggers_title))
        Text(stringResource(R.string.wft_triggers_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        if (model == null) {
            Text(stringResource(R.string.wft_triggers_save_first), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            return@Column
        }
        ui.errors[""]?.let { ErrorNotice(it) }
        ui.items.forEach { trigger ->
            TriggerCard(trigger, ui, hub, model, onShowRun)
        }
        var preset by remember { mutableStateOf(WorkflowTriggerPreset.CLICKUP) }
        Text(stringResource(R.string.wft_triggers_preset), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            WorkflowFlowRules.PRESETS.forEach { p ->
                Chip(presetLabel(p), p == preset, { preset = p }, size = ControlSize.Sm, modifier = Modifier.testTag("workflow.editor.trigger.preset.${p.value}"))
            }
        }
        val name = presetLabel(preset)
        HubButton(
            stringResource(R.string.wft_triggers_add), { scope.launch { model.create(preset, name) } }, kind = ButtonKind.Secondary,
            size = ControlSize.Sm, icon = Lucide.Plus, loading = "create" in ui.busy, modifier = Modifier.testTag("workflow.editor.trigger.add"),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TriggerCard(trigger: WorkflowTrigger, ui: TriggersUi, hub: String, model: WorkflowTriggersModel, onShowRun: (String) -> Unit) {
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val tag = "workflow.editor.trigger.${trigger.id}"
    var open by remember(trigger.id) { mutableStateOf(true) }
    var secret by remember(trigger.id) { mutableStateOf("") }
    var copied by remember(trigger.id) { mutableStateOf(false) }
    var testEvent by remember(trigger.id) { mutableStateOf("") }
    var eventsText by remember(trigger.id) { mutableStateOf(trigger.events.joinToString(", ")) }
    var header by remember(trigger.id) { mutableStateOf(trigger.signatureHeader.orEmpty()) }
    var prefix by remember(trigger.id) { mutableStateOf(trigger.signaturePrefix.orEmpty()) }
    var deleting by remember(trigger.id) { mutableStateOf(false) }
    val url = WorkflowDraftRules.triggerUrl(hub, trigger.path)
    fun patch(p: WorkflowTriggerPatch) = scope.launch { model.patch(trigger, p) }
    LaunchedEffect(trigger.id, open) {
        // The delivery log while the card is open, read again every five seconds (as on the web).
        while (open) {
            model.deliveries(trigger.id)
            delay(5_000)
        }
    }
    val state = stringResource(if (open) R.string.sidebar_group_expanded else R.string.sidebar_group_collapsed)
    HubCard(Modifier.testTag(tag), padding = 12.dp) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.semantics { stateDescription = state }.testTag("$tag.header"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            InContentDirection(trigger.name) {
                Text(trigger.name, Modifier.weight(1f), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Badge(presetLabel(trigger.preset), tone = BadgeTone.Accent)
            LucideIcon(if (open) Lucide.ChevronUp else Lucide.ChevronDown, null, size = 16.dp, tint = t.textMuted)
        }
        if (!open) return@HubCard
        ToggleRow(stringResource(R.string.wft_triggers_enabled), trigger.enabled, { on -> patch(WorkflowTriggerPatch(enabled = on)) }, Modifier.testTag("$tag.enabled"))
        // The address to give the sender.
        Text(stringResource(R.string.wft_triggers_url), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LtrMono(url, Modifier.weight(1f).background(t.surface2, ItemShape).padding(8.dp).testTag("$tag.url"))
            HubButton(
                stringResource(if (copied) R.string.wft_triggers_copied else R.string.wft_triggers_copy),
                { clipboard.setText(AnnotatedString(url)); copied = true }, kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Copy,
                modifier = Modifier.testTag("$tag.copy"),
            )
        }
        Text(stringResource(R.string.wft_triggers_url_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        // The secret: typed, saved, cleared — never shown back.
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            HubTextField(
                secret, { secret = it }, Modifier.weight(1f), label = stringResource(R.string.wft_triggers_secret),
                placeholder = if (trigger.secretStored) "[stored]" else null, mono = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                visualTransformation = PasswordVisualTransformation(), size = ControlSize.Md, fieldTag = "$tag.secret",
            )
            HubButton(
                stringResource(R.string.wfe_save), {
                    val typed = secret
                    secret = ""
                    scope.launch { model.saveSecret(trigger, typed) }
                },
                kind = ButtonKind.Secondary, size = ControlSize.Md, enabled = secret.isNotBlank(), loading = "${trigger.id}:secret" in ui.busy,
                modifier = Modifier.testTag("$tag.secret.save"),
            )
        }
        Text(secretHint(trigger.preset), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        Text(
            stringResource(if (trigger.secretStored) R.string.wft_secret_stored else R.string.wft_secret_missing),
            fontSize = FontTokens.sizeXs.sp, color = if (trigger.secretStored) t.textMuted else t.warningSoftText,
            modifier = Modifier.testTag("$tag.secret.state"),
        )
        if (trigger.preset == WorkflowTriggerPreset.GENERIC_HMAC || trigger.preset == WorkflowTriggerPreset.TOKEN) {
            HubTextField(
                header, { header = it }, Modifier.fillMaxWidth().then(editingEnd { if (header.trim() != trigger.signatureHeader.orEmpty()) patch(WorkflowFlowRules.header(header)) }),
                label = stringResource(R.string.wft_triggers_header), placeholder = if (trigger.preset == WorkflowTriggerPreset.TOKEN) "X-Webhook-Token" else "X-Signature",
                mono = true, size = ControlSize.Md, fieldTag = "$tag.header_name",
            )
            if (trigger.preset == WorkflowTriggerPreset.GENERIC_HMAC) {
                HubTextField(
                    prefix, { prefix = it }, Modifier.fillMaxWidth().then(editingEnd { if (prefix.trim() != trigger.signaturePrefix.orEmpty()) patch(WorkflowFlowRules.prefix(prefix)) }),
                    label = stringResource(R.string.wft_triggers_prefix), placeholder = "sha256=", mono = true, size = ControlSize.Md, fieldTag = "$tag.prefix",
                )
                Text(stringResource(R.string.wft_triggers_encoding), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                val encoding = trigger.signatureEncoding?.value ?: "hex"
                Segmented(
                    listOf(Segment("hex", "hex", tag = "$tag.encoding.hex"), Segment("base64", "base64", tag = "$tag.encoding.base64")),
                    encoding,
                    { v ->
                        patch(WorkflowTriggerPatch(signatureEncoding = if (v == "base64") WorkflowTriggerPatch.SignatureEncoding.BASE64 else WorkflowTriggerPatch.SignatureEncoding.HEX))
                    },
                    Modifier.fillMaxWidth(), size = ControlSize.Sm,
                )
            }
        }
        // The events it takes.
        Text(stringResource(R.string.wft_triggers_events), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium)
        if (trigger.preset == WorkflowTriggerPreset.CLICKUP) {
            Column(Modifier.testTag("$tag.events")) {
                WorkflowFlowRules.CLICKUP_EVENTS.forEach { event ->
                    val on = event in trigger.events
                    Row(
                        Modifier.fillMaxWidth().clickable { patch(WorkflowTriggerPatch(events = WorkflowFlowRules.toggleEvent(trigger.events, event, !on))) }
                            .padding(vertical = 4.dp).testTag("$tag.event.$event"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        HubCheckbox(on, { next -> patch(WorkflowTriggerPatch(events = WorkflowFlowRules.toggleEvent(trigger.events, event, next))) })
                        LtrMono(event, size = FontTokens.sizeSm.sp)
                    }
                }
            }
        } else {
            HubTextField(
                eventsText, { eventsText = it },
                Modifier.fillMaxWidth().then(
                    editingEnd {
                        val next = WorkflowFlowRules.eventsFromText(eventsText)
                        if (next != trigger.events) patch(WorkflowTriggerPatch(events = next))
                    },
                ),
                placeholder = "issues, pull_request", mono = true, size = ControlSize.Md, fieldTag = "$tag.events_text",
            )
        }
        Text(stringResource(R.string.wft_triggers_events_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        // A test event through the whole receiving path, without contacting anyone.
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            HubTextField(
                testEvent, { testEvent = it }, Modifier.weight(1f), label = stringResource(R.string.wft_triggers_test_event),
                placeholder = trigger.events.firstOrNull(), mono = true, size = ControlSize.Md, fieldTag = "$tag.test_event",
            )
            HubButton(
                stringResource(R.string.wft_triggers_test), { scope.launch { model.test(trigger, testEvent) } },
                kind = ButtonKind.Secondary, size = ControlSize.Md, enabled = WorkflowFlowRules.canTest(trigger),
                loading = "${trigger.id}:test" in ui.busy, modifier = Modifier.testTag("$tag.test"),
            )
        }
        ui.tested[trigger.id]?.let { Text(deliveryWords(it), fontSize = FontTokens.sizeXs.sp, modifier = Modifier.testTag("$tag.test.result")) }
        ui.errors[trigger.id]?.let { ErrorNotice(it) }
        Deliveries(ui.deliveries[trigger.id].orEmpty(), tag, onShowRun)
        HubButton(
            stringResource(R.string.wft_trigger_delete), { deleting = true }, kind = ButtonKind.Ghost, size = ControlSize.Sm,
            icon = Lucide.Trash, modifier = Modifier.testTag("$tag.delete"),
        )
    }
    if (deleting) {
        ConfirmDialog(
            title = stringResource(R.string.wft_delete_title),
            body = stringResource(R.string.wft_delete_body),
            confirm = stringResource(R.string.wft_trigger_delete),
            onConfirm = { deleting = false; scope.launch { model.delete(trigger) } },
            onDismiss = { deleting = false },
            danger = true,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Deliveries(rows: List<WorkflowTriggerDelivery>, tag: String, onShowRun: (String) -> Unit) {
    val t = LocalTokens.current
    Text(stringResource(R.string.wft_deliveries), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium)
    if (rows.isEmpty()) {
        Text(stringResource(R.string.wft_no_deliveries), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        return
    }
    rows.forEach { row ->
        Column(
            Modifier.fillMaxWidth().background(t.surface2, ItemShape).padding(8.dp).testTag("$tag.delivery.${row.id}"),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Badge(deliveryWords(row.status), tone = WorkflowFlowRules.deliveryTone(row.status))
                if (row.filtered) Badge(stringResource(R.string.wft_filtered))
                if (row.test) Badge(stringResource(R.string.wft_test_badge), tone = BadgeTone.Info)
                Text(localTime(row.receivedAt), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
            WorkflowFlowRules.deliveryLine(row)?.let { LtrMono(it) }
            row.error?.takeIf { it.isNotBlank() }?.let { e -> InContentDirection(e) { Text(e, fontSize = FontTokens.sizeXs.sp, color = t.danger) } }
            row.workflowRunId?.let { run ->
                Text(
                    stringResource(R.string.wft_open_run), fontSize = FontTokens.sizeXs.sp, color = t.accent,
                    modifier = Modifier.clickable { onShowRun(run) }.padding(vertical = 2.dp).testTag("$tag.delivery.${row.id}.run"),
                )
            }
        }
    }
}

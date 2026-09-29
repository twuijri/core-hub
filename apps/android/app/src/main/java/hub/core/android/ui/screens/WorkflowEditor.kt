package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.rememberAgents
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Chip
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.ToggleRow
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.SchedulesRerunWorkflowFromNodeRequest
import hub.core.client.model.Workflow
import hub.core.client.model.WorkflowCheck
import hub.core.client.model.WorkflowEdge
import hub.core.client.model.WorkflowIssue
import hub.core.client.model.WorkflowNode
import hub.core.client.model.WorkflowNodePosition
import hub.core.client.model.WorkflowRules
import hub.core.client.model.WorkflowSend
import hub.core.client.model.WorkflowTrigger
import hub.core.client.model.WorkflowValidation
import hub.core.client.model.WorkflowWrite
import java.math.BigDecimal
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Making and editing a workflow on the phone (the web's WorkflowEditor, DECISIONS §52) — before
 * 2026-09-27 the phone only ran workflows and said they are drawn on the web. The phone has no
 * canvas: the steps are a list, each with its own form (an agent and its prompt, a condition as
 * «what · comparison · value», a wait, a message, an approval's question) and the connections
 * that leave it (on success / on failure / always; yes / no for a condition). The drawing is the
 * contract's own `WorkflowWrite`, so a workflow drawn on the web keeps its positions here, and a
 * step added here is placed after the last one. The hub judges the drawing
 * (`schedules.validateWorkflow`) as it changes; problems block saving, warnings do not.
 */

/** The drawing being edited. */
data class WorkflowDraft(
    val name: String = "",
    val description: String = "",
    val workingDir: String? = null,
    val nodes: List<WorkflowNode> = emptyList(),
    val edges: List<WorkflowEdge> = emptyList(),
    /** Who is told when a run fails (§127), as loaded or as the person left it. */
    val onFailure: hub.core.client.model.WorkflowFailureAlert? = null,
    /**
     * The person changed the failure alert in this editing session: only then is it written
     * (null as an explicit null); untouched, it is left out so the saved one — or one this app
     * does not understand — is kept.
     */
    val alertTouched: Boolean = false,
)

object WorkflowDraftRules {
    const val MAX_DELAY_SECONDS = 3600
    private const val NODE_WIDTH = 208
    private const val NODE_HEIGHT = 76
    private const val GAP_X = 72
    private const val GAP_Y = 40
    private val ID = Regex("^[A-Za-z0-9_-]{1,40}$")

    val OPERATORS = listOf("==", "!=", ">", ">=", "<", "<=", "contains", "matches", "exists", "empty")
    val UNARY = setOf("exists", "empty")

    fun from(workflow: Workflow): WorkflowDraft =
        WorkflowDraft(workflow.name, workflow.description.orEmpty(), workflow.workingDir, workflow.nodes, workflow.edges, workflow.onFailure)

    /** A duplicate: the same drawing under «<name> (copy)», with its failure alert. */
    fun copyOf(workflow: Workflow, name: String): WorkflowDraft =
        from(workflow).copy(name = name, alertTouched = workflow.onFailure != null)

    /** The failure alert as the form left it (§127); from now on it is written. */
    fun withAlert(draft: WorkflowDraft, alert: hub.core.client.model.WorkflowFailureAlert?): WorkflowDraft =
        draft.copy(onFailure = alert, alertTouched = true)

    fun nextNodeId(kind: WorkflowNode.Kind, nodes: List<WorkflowNode>): String {
        val taken = nodes.map { it.id }.toSet()
        var n = 1
        while ("${kind.value}_$n" in taken) n++
        return "${kind.value}_$n"
    }

    fun nextEdgeId(edges: List<WorkflowEdge>): String {
        val taken = edges.map { it.id }.toSet()
        var n = 1
        while ("e$n" in taken) n++
        return "e$n"
    }

    private fun defaultInput(kind: WorkflowNode.Kind): String = when (kind) {
        WorkflowNode.Kind.DELAY -> "60"
        WorkflowNode.Kind.CONDITION -> "input exists"
        else -> ""
    }

    /** Where a new step goes: after the last one along the reading direction, below it when that spot is taken. */
    fun place(nodes: List<WorkflowNode>): WorkflowNodePosition {
        val anchor = nodes.lastOrNull() ?: return WorkflowNodePosition(BigDecimal(40), BigDecimal(40))
        var x = anchor.position.x.toInt() + NODE_WIDTH + GAP_X
        var y = anchor.position.y.toInt()
        fun overlaps() = nodes.any { kotlin.math.abs(it.position.x.toInt() - x) < NODE_WIDTH && kotlin.math.abs(it.position.y.toInt() - y) < NODE_HEIGHT }
        var guard = 0
        while (overlaps() && guard++ < 50) y += NODE_HEIGHT + GAP_Y
        return WorkflowNodePosition(BigDecimal(x), BigDecimal(y))
    }

    fun add(draft: WorkflowDraft, kind: WorkflowNode.Kind, title: String, agentId: String? = null): WorkflowDraft {
        val node = WorkflowNode(
            id = nextNodeId(kind, draft.nodes), kind = kind, title = title, skills = emptyList(), approvalRequired = false,
            position = place(draft.nodes), agentId = if (kind == WorkflowNode.Kind.AGENT) agentId else null, input = defaultInput(kind),
        )
        return draft.copy(nodes = draft.nodes + node)
    }

    fun update(draft: WorkflowDraft, id: String, change: (WorkflowNode) -> WorkflowNode): WorkflowDraft =
        draft.copy(nodes = draft.nodes.map { if (it.id == id) change(it) else it })

    /** A step goes with every connection to or from it. */
    fun remove(draft: WorkflowDraft, id: String): WorkflowDraft =
        draft.copy(nodes = draft.nodes.filter { it.id != id }, edges = draft.edges.filter { it.from != id && it.to != id })

    /** One connection per pair and route; never a step to itself. */
    fun connect(draft: WorkflowDraft, from: String, to: String, route: WorkflowEdge.Route): WorkflowDraft {
        if (from == to || draft.edges.any { it.from == from && it.to == to && it.route == route }) return draft
        if (draft.nodes.none { it.id == from } || draft.nodes.none { it.id == to }) return draft
        return draft.copy(edges = draft.edges + WorkflowEdge(nextEdgeId(draft.edges), from, to, route))
    }

    fun disconnect(draft: WorkflowDraft, edgeId: String): WorkflowDraft = draft.copy(edges = draft.edges.filter { it.id != edgeId })

    /** The drawing as `createWorkflow` / `updateWorkflow` take it; [editing] clears an emptied description. */
    fun toWrite(draft: WorkflowDraft, editing: Boolean = false): WorkflowWrite {
        val description = draft.description.trim().takeIf { it.isNotEmpty() }
        return WorkflowWrite(
            name = draft.name.trim(), description = description, workingDir = draft.workingDir,
            nodes = draft.nodes.map { n ->
                val agent = n.kind == WorkflowNode.Kind.AGENT
                n.copy(
                    agentId = if (agent) n.agentId else null, model = if (agent) n.model else null, provider = if (agent) n.provider else null,
                    approvalRequired = if (n.kind == WorkflowNode.Kind.APPROVAL) false else n.approvalRequired,
                )
            },
            edges = draft.edges,
            onFailure = if (draft.alertTouched) draft.onFailure else null,
            sendNull = buildSet {
                if (editing && description == null) add(WorkflowWrite.Clearable.DESCRIPTION)
                if (draft.alertTouched && draft.onFailure == null) add(WorkflowWrite.Clearable.ON_FAILURE)
            },
        )
    }

    /**
     * The drawing as the hub's live check takes it (`WorkflowCheck`): what saving sends, without the
     * name — the check never reads it, and a hub older than the check's own body refused an empty one.
     */
    fun toCheck(draft: WorkflowDraft): WorkflowCheck {
        val write = toWrite(draft)
        return WorkflowCheck(description = write.description, workingDir = write.workingDir, nodes = write.nodes, edges = write.edges, onFailure = write.onFailure)
    }

    /** A trigger's address on the hub the phone is signed in to. */
    fun triggerUrl(hub: String, path: String): String = hub.trimEnd('/') + path

    /** An agent step's model: a catalogue key, or null for the agent's own; the provider goes with the key. */
    fun withModel(node: WorkflowNode, model: String?): WorkflowNode = node.copy(model = model?.takeIf { it.isNotBlank() }, provider = null)

    /** What the model button says: the model's label when the catalogue knows it, its id otherwise, null for the agent's own. */
    fun modelLabel(model: String?, options: List<hub.core.android.chat.ChatControls.ModelOption>): String? =
        hub.core.android.chat.ChatControls.modelLabel(model, options)

    fun idsValid(draft: WorkflowDraft): Boolean = draft.nodes.all { ID.matches(it.id) }

    /** Saving needs a name; the hub's problems block it too (the web's rule). */
    fun canSave(draft: WorkflowDraft, validation: WorkflowValidation?): Boolean =
        draft.name.isNotBlank() && idsValid(draft) && (validation == null || validation.problems.isEmpty())

    /** Every step with a path to this one: the outputs its text may read. */
    fun upstreamOf(draft: WorkflowDraft, id: String): List<WorkflowNode> {
        val into = draft.edges.groupBy({ it.to }, { it.from })
        val seen = mutableSetOf<String>()
        val stack = ArrayDeque(into[id].orEmpty())
        while (stack.isNotEmpty()) {
            val next = stack.removeLast()
            if (next == id || !seen.add(next)) continue
            stack.addAll(into[next].orEmpty())
        }
        return draft.nodes.filter { it.id in seen }
    }

    /** A condition's text as «path · operator · value»; null when it is not one comparison. */
    fun splitCondition(text: String): Triple<String, String, String>? {
        val t = text.trim()
        if (t.isEmpty()) return Triple("", "==", "")
        for (u in UNARY) if (t.endsWith(" $u")) return Triple(t.dropLast(u.length + 1).trim(), u, "")
        for (op in listOf("==", "!=", ">=", "<=", "contains", "matches", ">", "<")) {
            val at = t.indexOf(" $op ")
            if (at == -1) continue
            val raw = t.substring(at + op.length + 2).trim()
            val quoted = Regex("^\"(.*)\"$", RegexOption.DOT_MATCHES_ALL).find(raw) ?: Regex("^'(.*)'$", RegexOption.DOT_MATCHES_ALL).find(raw)
            return Triple(t.substring(0, at).trim(), op, quoted?.groupValues?.get(1) ?: raw)
        }
        return null
    }

    /** The three parts as the engine reads them; a value that is not a number is quoted. */
    fun joinCondition(path: String, op: String, value: String): String {
        val p = path.trim()
        if (op in UNARY) return "$p $op"
        val numeric = value.trim().isNotEmpty() && value.trim().toDoubleOrNull() != null
        return "$p $op ${if (numeric) value.trim() else "\"$value\""}"
    }

    /** A wait as typed (a number and its unit) in seconds, or null when it is not 0–3600 s. */
    fun delaySeconds(amount: String, minutes: Boolean): Int? {
        val n = amount.trim().toIntOrNull() ?: return null
        val s = if (minutes) n * 60 else n
        return s.takeIf { it in 0..MAX_DELAY_SECONDS }
    }
}

/** The calls the editor makes, each in the workflow's own profile. */
class WorkflowEditOps(private val apis: () -> HubApis?) {
    private suspend fun <T> call(block: suspend (HubApis) -> T): Result<T> {
        val api = apis() ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { block(api) }
    }

    suspend fun validate(profile: String, check: WorkflowCheck) = call { it.schedules.schedulesValidateWorkflow(profile, check) }
    suspend fun create(profile: String, write: WorkflowWrite) = call { it.schedules.schedulesCreateWorkflow(profile, write) }
    suspend fun update(profile: String, id: String, write: WorkflowWrite) = call { it.schedules.schedulesUpdateWorkflow(profile, id, write) }
    suspend fun delete(workflow: Workflow) = call { it.schedules.schedulesDeleteWorkflow(workflow.profile, workflow.id) }
    suspend fun rerun(profile: String, runId: String, fromNode: String) =
        call { it.schedules.schedulesRerunWorkflowFromNode(profile, runId, SchedulesRerunWorkflowFromNodeRequest(fromNode)) }
}

@Composable
internal fun wfKindLabel(kind: WorkflowNode.Kind): String = stringResource(
    when (kind) {
        WorkflowNode.Kind.AGENT -> R.string.wfe_kind_agent
        WorkflowNode.Kind.CONDITION -> R.string.wfe_kind_condition
        WorkflowNode.Kind.DELAY -> R.string.wfe_kind_delay
        WorkflowNode.Kind.NOTIFY -> R.string.wfe_kind_notify
        WorkflowNode.Kind.APPROVAL -> R.string.wfe_kind_approval
    },
)

@Composable
private fun routeLabel(route: WorkflowEdge.Route, condition: Boolean): String = stringResource(
    when (route) {
        WorkflowEdge.Route.SUCCESS -> if (condition) R.string.wfe_cond_yes else R.string.wfe_route_success
        WorkflowEdge.Route.FAILURE -> if (condition) R.string.wfe_cond_no else R.string.wfe_route_failure
        WorkflowEdge.Route.ALWAYS -> R.string.wfe_route_always
    },
)

/** The hub's finding in the page's words when its code is known, the hub's otherwise. */
@Composable
private fun issueText(issue: WorkflowIssue): String {
    val d = issue.detail.orEmpty()
    return when (issue.code) {
        "node_id_missing" -> stringResource(R.string.wfe_issue_node_id_missing)
        "node_id_duplicate" -> stringResource(R.string.wfe_issue_node_id_duplicate)
        "edge_from_unknown" -> stringResource(R.string.wfe_issue_edge_from_unknown)
        "edge_to_unknown" -> stringResource(R.string.wfe_issue_edge_to_unknown)
        "condition_unreadable" -> stringResource(R.string.wfe_issue_condition_unreadable, d)
        "delay_out_of_range" -> stringResource(R.string.wfe_issue_delay_out_of_range, d)
        "template_root_unknown" -> stringResource(R.string.wfe_issue_template_root_unknown, d)
        "template_step_unknown" -> stringResource(R.string.wfe_issue_template_step_unknown, d)
        "workflow_empty" -> stringResource(R.string.wfe_issue_workflow_empty)
        "no_start" -> stringResource(R.string.wfe_issue_no_start)
        "many_starts" -> stringResource(R.string.wfe_issue_many_starts, d)
        "agent_missing" -> stringResource(R.string.wfe_issue_agent_missing)
        else -> issue.message
    }
}

/**
 * The editor as a sheet: [workflow] null (or [start] for a duplicate) makes a new one in
 * [profile]; otherwise it edits that workflow in its own profile. [onSaved] gets what the hub kept.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun WorkflowEditorSheet(
    workflow: Workflow?,
    profile: String,
    ops: WorkflowEditOps,
    onDismiss: () -> Unit,
    onSaved: (Workflow) -> Unit,
    start: WorkflowDraft? = null,
    /** A delivery's "Open the run" (Triggers): the run view of that run. */
    onShowRun: (String) -> Unit = {},
) {
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    val where = workflow?.profile ?: profile
    var draft by remember(workflow?.id) { mutableStateOf(start ?: workflow?.let(WorkflowDraftRules::from) ?: WorkflowDraft()) }
    var validation by remember { mutableStateOf<WorkflowValidation?>(null) }
    var checking by remember { mutableStateOf(false) }
    var checkError by remember { mutableStateOf<HubError?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<HubError?>(null) }
    val agents = ChatAgents.startable(rememberAgents(where))
    // The profile's chat models, for an agent step's own model (the web's StepPanel picker).
    val graph = androidx.compose.ui.platform.LocalContext.current.graph
    // Triggers, send and step tests, conversations (WorkflowFlow.kt).
    val flow = remember { WorkflowFlowOps { graph.store.current?.let(graph::apis) } }
    var models by remember(where) { mutableStateOf<List<hub.core.android.chat.ChatControls.ModelOption>>(emptyList()) }
    var modelsLoaded by remember(where) { mutableStateOf(false) }
    LaunchedEffect(where) {
        val s = graph.store.current ?: return@LaunchedEffect
        runCatching { hub.core.android.chat.ChatActions(graph.apis(s)).catalogue(where) }.onSuccess { models = it }
        modelsLoaded = true
    }
    // The hub judges the drawing as it changes (a pause first, so typing is not a request a key).
    LaunchedEffect(draft) {
        if (draft.nodes.isEmpty()) { validation = null; return@LaunchedEffect }
        delay(600)
        checking = true
        ops.validate(where, WorkflowDraftRules.toCheck(draft)).onSuccess { validation = it; checkError = null }.onFailure { checkError = it as HubError }
        checking = false
    }
    HubSheet(onDismiss, Modifier.testTag("workflow.editor"), title = stringResource(if (workflow == null) R.string.wfe_new else R.string.wfe_edit)) {
        Column(Modifier.heightIn(max = 640.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            HubTextField(draft.name, { draft = draft.copy(name = it) }, Modifier.fillMaxWidth(), label = stringResource(R.string.wfe_name), size = ControlSize.Md, fieldTag = "workflow.editor.name")
            HubTextField(
                draft.description, { draft = draft.copy(description = it) }, Modifier.fillMaxWidth(), label = stringResource(R.string.wfe_description),
                singleLine = false, maxLines = 3, size = ControlSize.Md, fieldTag = "workflow.editor.description",
            )
            // The hub's verdict on the drawing.
            val v = validation
            when {
                checking -> Text(stringResource(R.string.wfe_checking), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                checkError != null -> Text(stringResource(R.string.wfe_check_failed, checkError?.text ?: checkError?.code.orEmpty()), fontSize = FontTokens.sizeXs.sp, color = t.danger)
                v != null && v.problems.isEmpty() && v.warnings.isEmpty() -> Badge(stringResource(R.string.wfe_valid), tone = BadgeTone.Success, dot = true)
                v != null -> Column(Modifier.testTag("workflow.editor.issues"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (v.problems.isNotEmpty()) Badge(stringResource(R.string.wfe_problems, v.problems.size.toString()), tone = BadgeTone.Danger, dot = true)
                    v.problems.forEach { Text("• " + issueText(it) + (it.nodeId?.let { id -> " ($id)" } ?: ""), fontSize = FontTokens.sizeXs.sp, color = t.danger) }
                    if (v.warnings.isNotEmpty()) Badge(stringResource(R.string.wfe_warnings, v.warnings.size.toString()), tone = BadgeTone.Warning, dot = true)
                    v.warnings.forEach { Text("• " + issueText(it), fontSize = FontTokens.sizeXs.sp, color = t.warningSoftText) }
                }
            }
            SectionTitle(stringResource(R.string.workflows_steps))
            if (draft.nodes.isEmpty()) Text(stringResource(R.string.wfe_no_steps), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            draft.nodes.forEach { node ->
                StepEditor(node, draft, agents.map { it.id to it.name }, models, modelsLoaded, where, flow, onDraft = { draft = it })
            }
            Text(stringResource(R.string.wfe_palette), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            val titleOf: Map<WorkflowNode.Kind, String> = WorkflowNode.Kind.entries.associateWith { wfKindLabel(it) }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                WorkflowNode.Kind.entries.forEach { kind ->
                    HubButton(
                        titleOf.getValue(kind), { draft = WorkflowDraftRules.add(draft, kind, titleOf.getValue(kind), agents.firstOrNull()?.id) },
                        kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = stepIcon(kind), modifier = Modifier.testTag("workflow.editor.add.${kind.value}"),
                    )
                }
                // A notice that sends (§124): kept as a `notify` step, so an older app still loads it.
                val sendTitle = stringResource(R.string.wft_send_title)
                HubButton(
                    sendTitle, { draft = WorkflowFlowRules.addSendStep(draft, sendTitle) },
                    kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Send, modifier = Modifier.testTag("workflow.editor.add.send"),
                )
            }
            Text(stringResource(R.string.wft_send_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            // Who is told when a run fails (§127): written only once changed here.
            FailureAlertForm(draft.onFailure, where, flow) { alert -> draft = WorkflowDraftRules.withAlert(draft, alert) }
            WorkflowTriggersSection(workflow?.id, where, graph.store.current?.hub.orEmpty(), flow, onShowRun)
            ErrorNotice(error)
            if (draft.name.isBlank()) Text(stringResource(R.string.wfe_name_required), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            else if (validation?.problems?.isNotEmpty() == true) Text(stringResource(R.string.wfe_save_blocked), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            HubButton(
                stringResource(R.string.wfe_save),
                {
                    saving = true
                    scope.launch {
                        val write = WorkflowDraftRules.toWrite(draft, editing = workflow != null)
                        val result = if (workflow == null) ops.create(where, write) else ops.update(where, workflow.id, write)
                        result.onSuccess { onSaved(it) }.onFailure { error = it as HubError }
                        saving = false
                    }
                },
                icon = Lucide.Check, fill = true, loading = saving, enabled = WorkflowDraftRules.canSave(draft, validation) && !checking,
                modifier = Modifier.fillMaxWidth().testTag("workflow.editor.save"),
            )
        }
    }
}

/** One step's form and the connections that leave it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StepEditor(
    node: WorkflowNode,
    draft: WorkflowDraft,
    agents: List<Pair<String, String>>,
    models: List<hub.core.android.chat.ChatControls.ModelOption>,
    modelsLoaded: Boolean,
    profile: String,
    flow: WorkflowFlowOps,
    onDraft: (WorkflowDraft) -> Unit,
) {
    val t = LocalTokens.current
    fun change(transform: (WorkflowNode) -> WorkflowNode) = onDraft(WorkflowDraftRules.update(draft, node.id, transform))
    HubCard(Modifier.testTag("workflow.editor.step.${node.id}"), padding = 12.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Badge(if (node.send != null) stringResource(R.string.wft_send_title) else wfKindLabel(node.kind))
            Text(node.id, Modifier.weight(1f), fontSize = FontTokens.sizeXs.sp, fontFamily = FontFamily.Monospace, color = t.textMuted)
            HubIconButton(
                Lucide.Trash, stringResource(R.string.wfe_delete_step), { onDraft(WorkflowDraftRules.remove(draft, node.id)) }, size = 32.dp, iconSize = 16.dp,
                modifier = Modifier.testTag("workflow.editor.step.${node.id}.delete"),
            )
        }
        HubTextField(node.title, { v -> change { it.copy(title = v) } }, Modifier.fillMaxWidth(), label = stringResource(R.string.wfe_title), size = ControlSize.Md, fieldTag = "workflow.editor.step.${node.id}.title")
        val input = node.input.orEmpty()
        val tokens = listOf("{{input}}" to stringResource(R.string.wfe_insert_input)) +
            WorkflowDraftRules.upstreamOf(draft, node.id).map { "{{steps.${it.id}.output}}" to stringResource(R.string.wfe_insert_step, it.title.ifBlank { it.id }) }
        when (node.kind) {
            WorkflowNode.Kind.AGENT -> {
                Text(stringResource(R.string.wfe_agent), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                if (agents.isEmpty()) Text(stringResource(R.string.wfe_agent_none), fontSize = FontTokens.sizeXs.sp, color = t.danger)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    agents.forEach { (id, name) -> Chip(name, node.agentId == id, { change { it.copy(agentId = id) } }, size = ControlSize.Sm) }
                }
                // The step's own model, or the agent's (null): chosen from the profile's chat models.
                var picking by remember(node.id) { mutableStateOf(false) }
                Text(stringResource(R.string.wfe_model), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                HubButton(
                    WorkflowDraftRules.modelLabel(node.model, models) ?: stringResource(R.string.wfe_model_default),
                    { picking = true }, kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Layers,
                    modifier = Modifier.testTag("workflow.editor.step.${node.id}.model"),
                )
                if (picking) {
                    hub.core.android.ui.components.ModelPickerSheet(
                        models, modelsLoaded, node.model, allowDefault = true,
                        onChoose = { value -> picking = false; change { WorkflowDraftRules.withModel(it, value) } },
                        onDismiss = { picking = false },
                    )
                }
                // The same conversation every run (§136): chosen on the web, shown and kept here.
                node.conversation?.takeIf { it.mode == "reuse" }?.let { conversation ->
                    Column(Modifier.testTag("workflow.editor.step.${node.id}.conversation")) {
                        Text(stringResource(R.string.wft_conversation_reuse), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                        Text(conversation.sessionId ?: "—", fontSize = FontTokens.sizeXs.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
                        if (conversation.createIfMissing == true) {
                            Text(stringResource(R.string.wft_conversation_create), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                        }
                        Text(stringResource(R.string.wft_conversation_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    }
                }
                HubTextField(
                    input, { v -> change { it.copy(input = v) } }, Modifier.fillMaxWidth(), label = stringResource(R.string.wfe_prompt),
                    singleLine = false, minLines = 3, maxLines = 8, size = ControlSize.Md, fieldTag = "workflow.editor.step.${node.id}.input",
                )
                InsertChips(tokens) { token -> change { it.copy(input = input + token) } }
            }
            WorkflowNode.Kind.CONDITION -> {
                val parts = WorkflowDraftRules.splitCondition(input)
                val rules = node.rules
                // Several rules (§123): on, they start from the single line; off, they go (an explicit null).
                ToggleRow(
                    stringResource(R.string.wft_rules_toggle), rules != null, { on -> change { WorkflowFlowRules.withRules(it, on) } },
                    Modifier.testTag("workflow.editor.step.${node.id}.rules.toggle"),
                )
                if (rules != null) {
                    RulesForm(node, draft, rules) { next -> change { it.copy(rules = next) } }
                } else if (parts == null) {
                    Text(stringResource(R.string.wfe_condition_raw_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    HubTextField(input, { v -> change { it.copy(input = v) } }, Modifier.fillMaxWidth(), label = stringResource(R.string.wfe_condition_text), mono = true, size = ControlSize.Md)
                } else {
                    val (path, op, value) = parts
                    HubTextField(
                        path, { v -> change { it.copy(input = WorkflowDraftRules.joinCondition(v, op, value)) } }, Modifier.fillMaxWidth(),
                        label = stringResource(R.string.wfe_condition_path), mono = true, size = ControlSize.Md, fieldTag = "workflow.editor.step.${node.id}.path",
                    )
                    Text(stringResource(R.string.wfe_condition_path_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        WorkflowDraftRules.OPERATORS.forEach { o ->
                            Chip(operatorLabel(o), o == op, { change { it.copy(input = WorkflowDraftRules.joinCondition(path, o, value)) } }, size = ControlSize.Sm)
                        }
                    }
                    if (op !in WorkflowDraftRules.UNARY) {
                        HubTextField(
                            value, { v -> change { it.copy(input = WorkflowDraftRules.joinCondition(path, op, v)) } }, Modifier.fillMaxWidth(),
                            label = stringResource(R.string.wfe_condition_value), size = ControlSize.Md, fieldTag = "workflow.editor.step.${node.id}.value",
                        )
                    }
                }
                Text(stringResource(R.string.wfe_condition_routes_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
            WorkflowNode.Kind.DELAY -> {
                val seconds = input.trim().toIntOrNull()
                var minutes by remember(node.id) { mutableStateOf(seconds != null && seconds >= 60 && seconds % 60 == 0) }
                var amount by remember(node.id) { mutableStateOf(seconds?.let { if (minutes) (it / 60).toString() else it.toString() } ?: input) }
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HubTextField(
                        amount, { v -> amount = v.filter(Char::isDigit).take(5); WorkflowDraftRules.delaySeconds(amount, minutes)?.let { s -> change { it.copy(input = s.toString()) } } },
                        Modifier.weight(1f), label = stringResource(R.string.wfe_delay_amount), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        size = ControlSize.Md, error = if (WorkflowDraftRules.delaySeconds(amount, minutes) == null) stringResource(R.string.wfe_delay_hint) else null,
                        fieldTag = "workflow.editor.step.${node.id}.delay",
                    )
                    Segmented(
                        listOf(Segment(false, stringResource(R.string.wfe_seconds)), Segment(true, stringResource(R.string.wfe_minutes))),
                        minutes, { m -> minutes = m; WorkflowDraftRules.delaySeconds(amount, m)?.let { s -> change { it.copy(input = s.toString()) } } },
                        Modifier.weight(1f), size = ControlSize.Md,
                    )
                }
                Text(stringResource(R.string.wfe_delay_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
            WorkflowNode.Kind.NOTIFY -> {
                HubTextField(
                    input, { v -> change { it.copy(input = v) } }, Modifier.fillMaxWidth(),
                    label = stringResource(if (node.send != null) R.string.wft_send_message else R.string.wfe_notify_text),
                    singleLine = false, minLines = 2, maxLines = 6, size = ControlSize.Md, fieldTag = "workflow.editor.step.${node.id}.input",
                )
                InsertChips(tokens) { token -> change { it.copy(input = input + token) } }
                if (node.send != null) {
                    // A "Send message" step (§124): where its words go, and a test send.
                    SendStepForm(node, profile, flow) { next -> change { next } }
                } else {
                    Text(stringResource(R.string.wfe_notify_to), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                }
            }
            WorkflowNode.Kind.APPROVAL -> {
                HubTextField(
                    input, { v -> change { it.copy(input = v) } }, Modifier.fillMaxWidth(), label = stringResource(R.string.wfe_approval_question),
                    singleLine = false, minLines = 2, maxLines = 6, size = ControlSize.Md, fieldTag = "workflow.editor.step.${node.id}.input",
                )
                Text(stringResource(R.string.wfe_approval_who), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
        }
        if (node.kind != WorkflowNode.Kind.APPROVAL) {
            ToggleRow(stringResource(R.string.wfe_approval_required), node.approvalRequired, { v -> change { it.copy(approvalRequired = v) } })
        }
        // The step tried on its own with a sample (§127); folded until asked.
        StepTestPanel(node, profile, flow)
        Connections(node, draft, onDraft)
    }
}

@Composable
private fun operatorLabel(op: String): String = stringResource(
    when (op) {
        "==" -> R.string.wfe_op_eq
        "!=" -> R.string.wfe_op_ne
        ">" -> R.string.wfe_op_gt
        ">=" -> R.string.wfe_op_gte
        "<" -> R.string.wfe_op_lt
        "<=" -> R.string.wfe_op_lte
        "contains" -> R.string.wfe_op_contains
        "matches" -> R.string.wfe_op_matches
        "exists" -> R.string.wfe_op_exists
        else -> R.string.wfe_op_empty
    },
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InsertChips(tokens: List<Pair<String, String>>, onInsert: (String) -> Unit) {
    Text(stringResource(R.string.wfe_insert), fontSize = FontTokens.sizeXs.sp, color = LocalTokens.current.textMuted)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        tokens.forEach { (token, label) -> Chip(label, false, { onInsert(token) }, size = ControlSize.Sm) }
    }
}

/** The connections leaving a step, each removable, and a new one: the next step and when. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Connections(node: WorkflowNode, draft: WorkflowDraft, onDraft: (WorkflowDraft) -> Unit) {
    val t = LocalTokens.current
    val condition = node.kind == WorkflowNode.Kind.CONDITION
    val out = draft.edges.filter { it.from == node.id }
    Text(stringResource(R.string.wfe_connections), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium, color = t.text)
    if (out.isEmpty()) Text(stringResource(R.string.wfe_no_connections), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    out.forEach { edge ->
        val to = draft.nodes.firstOrNull { it.id == edge.to }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("workflow.editor.edge.${edge.id}")) {
            Text("→ ${to?.title?.ifBlank { to.id } ?: edge.to}", Modifier.weight(1f), fontSize = FontTokens.sizeSm.sp)
            Badge(routeLabel(edge.route, condition), tone = when (edge.route) {
                WorkflowEdge.Route.SUCCESS -> BadgeTone.Success
                WorkflowEdge.Route.FAILURE -> BadgeTone.Danger
                WorkflowEdge.Route.ALWAYS -> BadgeTone.Neutral
            })
            HubIconButton(Lucide.X, stringResource(R.string.wfe_delete_edge), { onDraft(WorkflowDraftRules.disconnect(draft, edge.id)) }, size = 28.dp, iconSize = 14.dp)
        }
    }
    val others = draft.nodes.filter { it.id != node.id }
    if (others.isEmpty()) return
    var target by remember(node.id) { mutableStateOf<String?>(null) }
    var route by remember(node.id) { mutableStateOf(WorkflowEdge.Route.SUCCESS) }
    Text(stringResource(R.string.wfe_connect_target), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        others.forEach { o -> Chip(o.title.ifBlank { o.id }, target == o.id, { target = o.id }, size = ControlSize.Sm) }
    }
    Segmented(
        listOf(WorkflowEdge.Route.SUCCESS, WorkflowEdge.Route.FAILURE, WorkflowEdge.Route.ALWAYS).map { Segment(it, routeLabel(it, condition)) },
        route, { route = it }, Modifier.fillMaxWidth(), size = ControlSize.Sm,
    )
    HubButton(
        stringResource(R.string.wfe_connect_add), { target?.let { onDraft(WorkflowDraftRules.connect(draft, node.id, it, route)); target = null } },
        kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Link, enabled = target != null, modifier = Modifier.testTag("workflow.editor.step.${node.id}.connect"),
    )
}

package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.AppGraph
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.realtime.Envelope
import hub.core.android.realtime.SCHEDULES_NAMESPACE
import hub.core.android.realtime.SESSIONS_NAMESPACE
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.InContentDirection
import hub.core.android.ui.components.Loading
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.StatusDot
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.generated.TokenColors
import hub.core.client.api.SchedulesApi
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalResponse
import hub.core.client.model.Money
import hub.core.client.model.Workflow
import hub.core.client.model.WorkflowLimits
import hub.core.client.model.WorkflowLimitsOverride
import hub.core.client.model.WorkflowNode
import hub.core.client.model.WorkflowRun
import hub.core.client.model.WorkflowRunRequest
import hub.core.client.model.WorkflowStep
import hub.core.client.model.WorkflowStepStatus
import java.math.BigDecimal
import java.time.Duration
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Workflows on the phone (B12): every workflow of every profile the person may enter, run with the
 * limits the hub supports, and a read-only view of a run whose steps follow it live — a waiting
 * step is approved or denied right there. The graph itself is drawn and edited on the web.
 */
object Workflows {
    private val done = setOf(WorkflowRun.Status.SUCCEEDED, WorkflowRun.Status.FAILED, WorkflowRun.Status.CANCELLED)

    /** A run that will not change any more: no more polling. */
    fun finished(run: WorkflowRun): Boolean = run.status in done

    /** One line of a run view: a node, and the latest attempt of it when the run reached it. */
    data class StepRow(val nodeId: String, val title: String, val kind: WorkflowNode.Kind?, val status: WorkflowStepStatus, val step: WorkflowStep?)

    /**
     * The run's steps in the order they ran, then the workflow's nodes the run has not reached
     * yet as `pending` (only while the run can still reach them: a finished run shows what ran).
     */
    fun rows(workflow: Workflow?, run: WorkflowRun): List<StepRow> {
        val nodes = workflow?.nodes.orEmpty().associateBy { it.id }
        val ran = run.steps.map { step ->
            val node = nodes[step.nodeId]
            StepRow(step.nodeId, node?.title ?: step.nodeId, node?.kind, step.status, step)
        }
        if (finished(run)) return ran
        val seen = run.steps.map { it.nodeId }.toSet()
        val rest = workflow?.nodes.orEmpty().filter { it.id !in seen }.map { StepRow(it.id, it.title, it.kind, WorkflowStepStatus.PENDING, null) }
        return ran + rest
    }

    /** The step waiting for a person's yes or no, with the approval to answer. */
    fun waiting(run: WorkflowRun): WorkflowStep? =
        run.steps.firstOrNull { it.status == WorkflowStepStatus.WAITING_APPROVAL && it.approvalId != null }

    /** What a person typed for one run's limits, before it is checked. */
    data class LimitsInput(val minutes: String = "", val cost: String = "", val stepMinutes: String = "")

    /** Why the typed limits cannot be sent, or null. */
    enum class LimitProblem { DURATION, COST, STEP }

    /**
     * The typed limits as the run's own (`WorkflowRunRequest.limits`): an empty field keeps the
     * workflow's; minutes become seconds within the hub's bounds (a week, a day); a cost is a
     * positive USD amount with at most two decimals. Null when nothing was typed.
     */
    fun limits(input: LimitsInput): Pair<WorkflowLimitsOverride?, LimitProblem?> {
        fun minutes(text: String, maxSeconds: Int): Int? {
            val n = text.trim().toIntOrNull() ?: return null
            val seconds = n.toLong() * 60
            return if (n >= 1 && seconds <= maxSeconds) seconds.toInt() else null
        }
        val duration = input.minutes.trim().takeIf { it.isNotEmpty() }?.let { minutes(it, 604_800) ?: return null to LimitProblem.DURATION }
        val step = input.stepMinutes.trim().takeIf { it.isNotEmpty() }?.let { minutes(it, 86_400) ?: return null to LimitProblem.STEP }
        val cost = input.cost.trim().takeIf { it.isNotEmpty() }?.let { text ->
            val amount = text.replace(',', '.').toBigDecimalOrNull()?.takeIf { it > BigDecimal.ZERO && it.scale() <= 2 }
                ?: return null to LimitProblem.COST
            Money(amount.setScale(2).toPlainString(), "USD")
        }
        if (duration == null && step == null && cost == null) return null to null
        return WorkflowLimitsOverride(maxDurationSeconds = duration, maxCost = cost, stepTimeoutSeconds = step) to null
    }

    /** A workflow's limits as short facts («30 min», «$2.00», «10 min a step»); empty when it has none. */
    fun hasLimits(limits: WorkflowLimits): Boolean = limits.maxDurationSeconds != null || limits.maxCost != null || limits.stepTimeoutSeconds != null

    /** Seconds as whole minutes, rounded up, for the facts above. */
    fun minutes(seconds: Int): Int = (seconds + 59) / 60

    /** How long a step worked: its end (or now) minus its start; null before it starts. */
    fun duration(step: WorkflowStep, now: java.time.OffsetDateTime = java.time.OffsetDateTime.now()): Duration? {
        val start = step.startedAt ?: return null
        return Duration.between(start, step.finishedAt ?: now).coerceAtLeast(Duration.ZERO)
    }

    /** An event that may change a workflow or a run on screen. */
    fun touches(e: Envelope): Boolean =
        (e.namespace == SCHEDULES_NAMESPACE && (e.event.startsWith("workflow") || e.event.startsWith("step."))) ||
            (e.namespace == SESSIONS_NAMESPACE && e.event.startsWith("approval."))
}

data class WorkflowsUi(
    val items: List<Workflow> = emptyList(),
    val loading: Boolean = true,
    val error: HubError? = null,
    /** The workflow whose sheet is open, and its latest runs. */
    val opened: Workflow? = null,
    val runs: List<WorkflowRun>? = null,
    /** The run shown, live. */
    val run: WorkflowRun? = null,
    val acting: Boolean = false,
    val notice: Int? = null,
)

/**
 * What the Workflows list does, apart from Android's lifecycle so it is tested against a
 * scripted hub. Every call about a workflow or a run goes to its own profile (ADR 0016).
 */
class WorkflowsModel(private val apis: () -> HubApis?, private val home: () -> String) {
    private val _ui = MutableStateFlow(WorkflowsUi())
    val ui: StateFlow<WorkflowsUi> = _ui.asStateFlow()

    private suspend fun <T> call(block: suspend (HubApis) -> T): Result<T> {
        val api = apis() ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { block(api) }
    }

    suspend fun load() {
        call { it.schedules.schedulesListWorkflows(home(), profiles = SchedulesApi.ProfilesSchedulesListWorkflows.ALL, limit = 200) }
            .onSuccess { page -> _ui.update { it.copy(items = page.items, loading = false, error = null, opened = it.opened?.let { o -> page.items.firstOrNull { w -> w.id == o.id } ?: o }) } }
            .onFailure { e -> _ui.update { it.copy(loading = false, error = e as HubError) } }
    }

    suspend fun open(workflow: Workflow) {
        _ui.update { it.copy(opened = workflow, runs = null, run = null, notice = null, error = null) }
        loadRuns()
    }

    suspend fun loadRuns() {
        val w = _ui.value.opened ?: return
        call { it.schedules.schedulesListWorkflowRuns(w.profile, w.id, limit = 10) }
            .onSuccess { page -> _ui.update { it.copy(runs = page.items) } }
            .onFailure { e -> _ui.update { it.copy(runs = emptyList(), error = e as HubError) } }
    }

    fun close() = _ui.update { it.copy(opened = null, runs = null, run = null, notice = null) }

    /** Back from a run to its workflow. */
    fun closeRun() = _ui.update { it.copy(run = null) }

    /** Starts a run with its input and limits and shows it; false when the hub refused. */
    suspend fun run(workflow: Workflow, input: String, limits: WorkflowLimitsOverride?): Boolean {
        _ui.update { it.copy(acting = true, error = null) }
        val request = WorkflowRunRequest(input = input.trim().ifEmpty { null }, limits = limits)
        val accepted = call { it.schedules.schedulesRunWorkflow(workflow.profile, workflow.id, UUID.randomUUID().toString(), request) }
        return accepted.fold(
            onSuccess = { a ->
                _ui.update { it.copy(acting = false, notice = R.string.workflows_started) }
                openRun(workflow.profile, a.workflowRunId)
                true
            },
            onFailure = { e -> _ui.update { it.copy(acting = false, error = e as HubError) }; false },
        )
    }

    suspend fun openRun(profile: String, runId: String) {
        call { it.schedules.schedulesGetWorkflowRun(profile, runId) }
            .onSuccess { run -> _ui.update { it.copy(run = run, error = null) } }
            .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
    }

    /** Reads the shown run again (the poll and the realtime events). */
    suspend fun refreshRun() {
        val run = _ui.value.run ?: return
        call { it.schedules.schedulesGetWorkflowRun(run.profile, run.id) }
            .onSuccess { fresh -> _ui.update { if (it.run?.id == fresh.id) it.copy(run = fresh) else it } }
    }

    /** Answers the waiting step: yes continues the run from it, no fails it with the reason. */
    suspend fun respond(approve: Boolean, reason: String? = null) {
        val run = _ui.value.run ?: return
        val step = Workflows.waiting(run) ?: return
        _ui.update { it.copy(acting = true, error = null) }
        val answer = ApprovalResponse(
            decision = if (approve) ApprovalDecision.APPROVE_ONCE else ApprovalDecision.DENY,
            answer = reason?.trim()?.ifEmpty { null },
        )
        call { it.sessions.sessionsRespondApproval(run.profile, step.approvalId!!, answer) }
            .onSuccess { _ui.update { it.copy(acting = false) }; refreshRun() }
            .onFailure { e -> _ui.update { it.copy(acting = false, error = e as HubError) } }
    }

    suspend fun cancel() {
        val run = _ui.value.run ?: return
        _ui.update { it.copy(acting = true, error = null) }
        call { it.schedules.schedulesCancelWorkflowRun(run.profile, run.id) }
            .onSuccess { fresh -> _ui.update { it.copy(acting = false, run = fresh) } }
            .onFailure { e -> _ui.update { it.copy(acting = false, error = e as HubError) } }
    }
}

class WorkflowsViewModel(graph: AppGraph) : ViewModel() {
    val model = WorkflowsModel({ graph.store.current?.let(graph::apis) }, { graph.store.current?.profile ?: "default" })
    val ui: StateFlow<WorkflowsUi> = model.ui

    init {
        graph.realtime.subscribeAll(SCHEDULES_NAMESPACE)
        viewModelScope.launch { model.load() }
        viewModelScope.launch {
            graph.realtime.events.collect { e ->
                if (!Workflows.touches(e)) return@collect
                model.load()
                model.refreshRun()
            }
        }
        // A run still going is read again every two seconds besides the events (as on the web).
        viewModelScope.launch {
            while (true) {
                delay(2_000)
                val run = model.ui.value.run
                if (run != null && !Workflows.finished(run)) model.refreshRun()
            }
        }
    }

    fun reload() = viewModelScope.launch { model.load() }
    fun open(w: Workflow) = viewModelScope.launch { model.open(w) }
    fun close() = model.close()
    fun closeRun() = model.closeRun()
    fun run(w: Workflow, input: String, limits: WorkflowLimitsOverride?) = viewModelScope.launch { model.run(w, input, limits) }
    fun openRun(profile: String, id: String) = viewModelScope.launch { model.openRun(profile, id) }
    fun respond(approve: Boolean, reason: String?) = viewModelScope.launch { model.respond(approve, reason) }
    fun cancel() = viewModelScope.launch { model.cancel() }
}

@Composable
private fun workflowState(status: Workflow.Status): Pair<String, BadgeTone> = when (status) {
    Workflow.Status.RUNNING -> stringResource(R.string.workflow_running) to BadgeTone.Success
    Workflow.Status.WAITING -> stringResource(R.string.workflow_waiting) to BadgeTone.Warning
    Workflow.Status.ERROR -> stringResource(R.string.workflow_error) to BadgeTone.Danger
    Workflow.Status.IDLE -> stringResource(R.string.workflow_idle) to BadgeTone.Neutral
}

@Composable
fun runState(status: WorkflowRun.Status): Pair<String, BadgeTone> = when (status) {
    WorkflowRun.Status.QUEUED -> stringResource(R.string.job_queued) to BadgeTone.Neutral
    WorkflowRun.Status.RUNNING -> stringResource(R.string.job_running) to BadgeTone.Info
    WorkflowRun.Status.WAITING -> stringResource(R.string.workflow_waiting) to BadgeTone.Warning
    WorkflowRun.Status.SUCCEEDED -> stringResource(R.string.job_succeeded) to BadgeTone.Success
    WorkflowRun.Status.FAILED -> stringResource(R.string.job_failed) to BadgeTone.Danger
    WorkflowRun.Status.CANCELLED -> stringResource(R.string.job_cancelled) to BadgeTone.Neutral
}

@Composable
private fun stepLabel(status: WorkflowStepStatus): String = stringResource(
    when (status) {
        WorkflowStepStatus.PENDING -> R.string.step_pending
        WorkflowStepStatus.QUEUED -> R.string.job_queued
        WorkflowStepStatus.RUNNING -> R.string.job_running
        WorkflowStepStatus.WAITING_APPROVAL -> R.string.step_waiting_approval
        WorkflowStepStatus.SUCCEEDED -> R.string.job_succeeded
        WorkflowStepStatus.FAILED -> R.string.job_failed
        WorkflowStepStatus.SKIPPED -> R.string.step_skipped
        WorkflowStepStatus.CANCELLED -> R.string.job_cancelled
        WorkflowStepStatus.REJECTED -> R.string.step_rejected
    },
)

private fun stepColor(t: TokenColors, status: WorkflowStepStatus): Color = when (status) {
    WorkflowStepStatus.RUNNING, WorkflowStepStatus.QUEUED -> t.statusRunning
    WorkflowStepStatus.WAITING_APPROVAL -> t.warningSoftText
    WorkflowStepStatus.SUCCEEDED -> t.successSoftText
    WorkflowStepStatus.FAILED, WorkflowStepStatus.REJECTED -> t.statusBlocked
    else -> t.textFaint
}

private fun stepIcon(kind: WorkflowNode.Kind?): Int = when (kind) {
    WorkflowNode.Kind.APPROVAL -> Lucide.Hand
    WorkflowNode.Kind.CONDITION -> Lucide.ListFilter
    WorkflowNode.Kind.DELAY -> Lucide.Clock
    WorkflowNode.Kind.NOTIFY -> Lucide.Bell
    else -> Lucide.Bot
}

/** A workflow's limits as short facts, for its card and sheet. */
@Composable
private fun limitFacts(limits: WorkflowLimits): List<String> = listOfNotNull(
    limits.maxDurationSeconds?.let { stringResource(R.string.workflow_limit_duration, Workflows.minutes(it)) },
    limits.maxCost?.let { stringResource(R.string.workflow_limit_cost, it.amount) },
    limits.stepTimeoutSeconds?.let { stringResource(R.string.workflow_limit_step, Workflows.minutes(it)) },
)

/** The Workflows half of Schedules: a card per workflow; a tap opens its sheet. */
@Composable
fun WorkflowsList(shell: ShellViewModel, onOpenChat: (String, String) -> Unit) {
    val context = LocalContext.current
    val vm: WorkflowsViewModel = viewModel { WorkflowsViewModel(context.graph) }
    val ui by vm.ui.collectAsState()
    val t = LocalTokens.current
    val badges = ui.items.map { it.profile }.distinct().size > 1
    Column(Modifier.fillMaxSize()) {
        if (ui.opened == null) ui.error?.let { ErrorNotice(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        if (ui.loading) {
            Loading()
            return@Column
        }
        LazyColumn(
            Modifier.fillMaxSize().testTag("workflows.list"),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (ui.items.isEmpty()) item { EmptyState(stringResource(R.string.workflows_empty), body = stringResource(R.string.workflows_empty_body), icon = Lucide.Workflow) }
            items(ui.items, key = { it.profile + "/" + it.id }) { w ->
                HubCard(Modifier.testTag("workflow.card.${w.id}"), onClick = { vm.open(w) }, padding = 14.dp) {
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        InContentDirection(w.name) {
                            Text(w.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        if (badges) Badge(shell.profileName(w.profile), tone = BadgeTone.Accent)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val (label, tone) = workflowState(w.status)
                        Badge(label, tone = tone, dot = true)
                        Text(
                            (listOf(stringResource(R.string.workflow_counts, w.nodes.size, w.runCount)) + limitFacts(w.limits)).joinToString(" · "),
                            fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    w.description?.takeIf { it.isNotBlank() }?.let { d ->
                        InContentDirection(d) { Text(d, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
        }
    }
    ui.opened?.let { w ->
        HubSheet(onDismiss = vm::close) {
            val run = ui.run
            if (run == null) WorkflowSheet(w, ui, vm, shell)
            else RunView(w, run, ui, vm, onOpenChat = { id -> vm.close(); onOpenChat(id, run.profile) })
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkflowSheet(w: Workflow, ui: WorkflowsUi, vm: WorkflowsViewModel, shell: ShellViewModel) {
    val t = LocalTokens.current
    var input by remember(w.id) { mutableStateOf("") }
    var limits by remember(w.id) { mutableStateOf(Workflows.LimitsInput()) }
    var showLimits by remember(w.id) { mutableStateOf(false) }
    val (override, problem) = Workflows.limits(limits)
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("workflow.sheet"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        InContentDirection(w.name) { Text(w.name, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val (label, tone) = workflowState(w.status)
            Badge(label, tone = tone, dot = true)
            Badge(shell.profileName(w.profile), tone = BadgeTone.Accent)
            limitFacts(w.limits).forEach { Badge(it) }
        }
        w.description?.takeIf { it.isNotBlank() }?.let { d -> InContentDirection(d) { Text(d, fontSize = FontTokens.sizeSm.sp, color = t.textMuted) } }
        ErrorNotice(ui.error)
        ui.notice?.let { NoticeBox(stringResource(it), BadgeTone.Success) }
        HubTextField(
            input, { input = it }, placeholder = stringResource(R.string.workflows_input_hint), label = stringResource(R.string.workflows_input),
            singleLine = false, maxLines = 4, fieldTag = "workflow.input",
        )
        // The limits the hub supports, for this run only; empty keeps the workflow's.
        HubButton(
            stringResource(R.string.workflows_run_limits), { showLimits = !showLimits }, kind = ButtonKind.Ghost, size = ControlSize.Sm,
            icon = if (showLimits) Lucide.ChevronUp else Lucide.ChevronDown, modifier = Modifier.testTag("workflow.limits.toggle"),
        )
        if (showLimits) {
            val numbers = KeyboardOptions(keyboardType = KeyboardType.Number)
            HubTextField(
                limits.minutes, { limits = limits.copy(minutes = it) }, label = stringResource(R.string.workflows_limit_minutes),
                placeholder = w.limits.maxDurationSeconds?.let { Workflows.minutes(it).toString() }, keyboardOptions = numbers, size = ControlSize.Md,
                error = if (problem == Workflows.LimitProblem.DURATION) stringResource(R.string.workflows_limit_minutes_bad) else null,
                fieldTag = "workflow.limit.minutes",
            )
            HubTextField(
                limits.cost, { limits = limits.copy(cost = it) }, label = stringResource(R.string.workflows_limit_cost),
                placeholder = w.limits.maxCost?.amount, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), size = ControlSize.Md,
                error = if (problem == Workflows.LimitProblem.COST) stringResource(R.string.workflows_limit_cost_bad) else null,
                fieldTag = "workflow.limit.cost",
            )
            HubTextField(
                limits.stepMinutes, { limits = limits.copy(stepMinutes = it) }, label = stringResource(R.string.workflows_limit_step),
                placeholder = w.limits.stepTimeoutSeconds?.let { Workflows.minutes(it).toString() }, keyboardOptions = numbers, size = ControlSize.Md,
                error = if (problem == Workflows.LimitProblem.STEP) stringResource(R.string.workflows_limit_step_bad) else null,
                fieldTag = "workflow.limit.step",
            )
        }
        HubButton(
            stringResource(R.string.workflows_run), { vm.run(w, input, override) }, icon = Lucide.Play, fill = true,
            enabled = problem == null && w.nodes.isNotEmpty(), loading = ui.acting, modifier = Modifier.fillMaxWidth().testTag("workflow.run"),
        )
        SectionTitle(stringResource(R.string.workflows_runs))
        when (val runs = ui.runs) {
            null -> Loading(Modifier.padding(16.dp))
            else -> if (runs.isEmpty()) Text(stringResource(R.string.schedules_no_runs), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            else GroupedList {
                runs.forEach { run ->
                    Item(
                        run.startedAt?.let(::localTime) ?: run.createdAt.let(::localTime),
                        subtitle = run.error ?: run.input,
                        chevron = true,
                        tag = "workflow.run.${run.id}",
                        onClick = { vm.openRun(run.profile, run.id) },
                        trailing = { val (label, tone) = runState(run.status); Badge(label, tone = tone, dot = true) },
                    )
                }
            }
        }
        Text(stringResource(R.string.workflows_edit_on_web), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    }
}

/** A run, read-only and live: its state, then each step with what it did; a waiting step asks here. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RunView(w: Workflow, run: WorkflowRun, ui: WorkflowsUi, vm: WorkflowsViewModel, onOpenChat: (String) -> Unit) {
    val t = LocalTokens.current
    var denying by remember(run.id) { mutableStateOf(false) }
    var reason by remember(run.id) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("workflow.run.view"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            HubIconButton(Lucide.ArrowLeft, stringResource(R.string.back), vm::closeRun, size = 36.dp, iconSize = 18.dp, modifier = Modifier.testTag("workflow.run.back"))
            InContentDirection(w.name) { Text(w.name, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val (label, tone) = runState(run.status)
            Badge(label, tone = tone, dot = true, modifier = Modifier.testTag("workflow.run.status"))
            run.startedAt?.let { Badge(localTime(it)) }
            run.cost?.let { Badge(stringResource(R.string.workflow_limit_cost, it.amount)) }
        }
        run.input?.takeIf { it.isNotBlank() }?.let { i -> InContentDirection(i) { Text(i, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, maxLines = 3) } }
        run.error?.let { NoticeBox(it, BadgeTone.Danger) }
        ErrorNotice(ui.error)
        Workflows.waiting(run)?.let { step ->
            val title = w.nodes.firstOrNull { it.id == step.nodeId }?.title ?: step.nodeId
            NoticeBox(stringResource(R.string.workflows_waiting_step, title), BadgeTone.Warning, Modifier.testTag("workflow.run.waiting")) {
                if (denying) {
                    HubTextField(reason, { reason = it }, placeholder = stringResource(R.string.workflows_deny_reason), size = ControlSize.Md, singleLine = false, maxLines = 3)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HubButton(stringResource(R.string.workflows_deny), { vm.respond(false, reason); denying = false }, kind = ButtonKind.Danger, size = ControlSize.Md, loading = ui.acting, modifier = Modifier.testTag("workflow.run.deny.confirm"))
                        HubButton(stringResource(R.string.cancel), { denying = false }, kind = ButtonKind.Ghost, size = ControlSize.Md)
                    }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HubButton(stringResource(R.string.workflows_approve), { vm.respond(true, null) }, size = ControlSize.Md, icon = Lucide.Check, loading = ui.acting, modifier = Modifier.testTag("workflow.run.approve"))
                        HubButton(stringResource(R.string.workflows_deny), { denying = true }, kind = ButtonKind.Danger, size = ControlSize.Md, icon = Lucide.X, enabled = !ui.acting, modifier = Modifier.testTag("workflow.run.deny"))
                    }
                }
            }
        }
        SectionTitle(stringResource(R.string.workflows_steps))
        GroupedList {
            Workflows.rows(w, run).forEach { row ->
                Item(
                    row.title,
                    icon = stepIcon(row.kind),
                    subtitle = listOfNotNull(
                        stepLabel(row.status),
                        row.step?.let { Workflows.duration(it) }?.let { stringResource(R.string.workflows_seconds, it.seconds) },
                        row.step?.error ?: row.step?.output?.lineSequence()?.firstOrNull { it.isNotBlank() },
                    ).joinToString(" · "),
                    tag = "workflow.step.${row.nodeId}",
                    chevron = row.step?.sessionId != null,
                    onClick = row.step?.sessionId?.let { id -> { onOpenChat(id) } },
                    trailing = { StatusDot(stepColor(t, row.status), stepLabel(row.status)) },
                )
            }
        }
        run.stoppedBy?.let {
            NoticeBox(
                stringResource(
                    when (it) {
                        WorkflowRun.StoppedBy.MAX_DURATION -> R.string.workflows_stopped_duration
                        WorkflowRun.StoppedBy.MAX_COST -> R.string.workflows_stopped_cost
                        WorkflowRun.StoppedBy.STEP_TIMEOUT -> R.string.workflows_stopped_step
                    },
                ),
                BadgeTone.Warning,
            )
        }
        if (!Workflows.finished(run)) {
            HubButton(stringResource(R.string.workflows_cancel_run), vm::cancel, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.CircleStop, enabled = !ui.acting, modifier = Modifier.testTag("workflow.run.cancel"))
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LucideIcon(Lucide.Info, null, size = 14.dp, tint = t.textMuted)
                Text(stringResource(R.string.workflows_finished), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
        }
    }
}

package us.i3u.hermesstudio.ui.workflows

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.ConfirmDialog
import us.i3u.hermesstudio.ErrorNote
import us.i3u.hermesstudio.LoadingRow
import us.i3u.hermesstudio.NoticeNote
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.StudioTopBar
import us.i3u.hermesstudio.StudioWorkflowRun
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.WorkflowSchedule
import us.i3u.hermesstudio.WorkflowTimelineEntry
import us.i3u.hermesstudio.orderWorkflowNodes
import us.i3u.hermesstudio.workflowTimeline
import us.i3u.hermesstudio.ui.sessions.formatStamp
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * One workflow: a read-only summary of its graph in execution order, its
 * schedules with enable/disable, and its runs. Tapping a run opens the
 * timeline; the graph itself is only edited on the desktop.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun WorkflowScreen(state: UiState, viewModel: AppViewModel) {
    val palette = CoreHub.palette
    val workflow = state.openWorkflow ?: return
    val runs = state.workflowRuns[workflow.id].orEmpty()
    val schedules = state.workflowSchedules[workflow.id].orEmpty()
    val live = state.workflowStatuses[workflow.id]
    var running by remember { mutableStateOf(false) }
    var addingSchedule by remember { mutableStateOf(false) }
    var deletingRun by remember { mutableStateOf<StudioWorkflowRun?>(null) }
    val ordered = remember(workflow.nodes, workflow.edges) { orderWorkflowNodes(workflow.nodes, workflow.edges) }

    if (running) RunInputDialog(workflow, onDismiss = { running = false }, onRun = { input -> viewModel.runWorkflow(workflow, input); running = false })
    if (addingSchedule) {
        ScheduleDialog(
            initial = null,
            onDismiss = { addingSchedule = false },
            onSave = { expression, timezone, _ -> viewModel.createWorkflowSchedule(workflow, expression, timezone); addingSchedule = false },
        )
    }
    deletingRun?.let { run ->
        ConfirmDialog(
            title = stringResource(R.string.workflow_run_delete),
            body = run.id,
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.deleteWorkflowRun(run); deletingRun = null },
            onDismiss = { deletingRun = null },
        )
    }

    Scaffold(
        topBar = {
            StudioTopBar(
                title = workflow.name,
                subtitle = stringResource(R.string.workflow_summary, workflow.profile, workflow.nodeCount, workflow.edgeCount),
                onBack = { viewModel.back() },
                actions = {
                    IconButton(onClick = { running = true }) { Icon(Icons.Filled.PlayArrow, contentDescription = stringResource(R.string.workflow_run), tint = palette.accent) }
                    IconButton(onClick = { viewModel.openWorkflow(workflow) }) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.textSecondary) }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            state.error?.let { message -> item { ErrorNote(message) { viewModel.dismissError() } } }
            state.notice?.let { message -> item { NoticeNote(message) { viewModel.dismissNotice() } } }
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusChip(live?.status ?: runs.firstOrNull()?.status ?: "idle")
                    workflow.workspace?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            live?.error?.let { message -> item { Text(message, style = CoreHubTextStyles.meta, color = palette.error) } }

            // ── graph summary ─────────────────────────────────────────────
            item { SectionHeader(R.string.workflow_nodes_title) }
            if (ordered.isEmpty()) item { Text(stringResource(R.string.workflow_no_nodes), style = CoreHubTextStyles.meta, color = palette.textMuted) }
            for (index in ordered.indices) {
                val node = ordered[index]
                item(key = "node-${node.id}") {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(
                                Modifier.size(20.dp).clip(CircleShape).background(palette.selected),
                                contentAlignment = Alignment.Center,
                            ) { Text("${index + 1}", style = CoreHubTextStyles.meta, color = palette.textSecondary) }
                            if (index != ordered.lastIndex) Box(Modifier.width(1.dp).height(18.dp).background(palette.borderLight))
                        }
                        Column(Modifier.weight(1f)) {
                            Text(node.title, style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content), color = palette.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOf(node.agent, node.model, node.provider).filter { it.isNotBlank() }.joinToString(" · "),
                                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr),
                                color = palette.textMuted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (node.approvalRequired) Text(stringResource(R.string.workflow_node_needs_approval), style = CoreHubTextStyles.meta, color = palette.warning)
                        }
                    }
                }
            }

            // ── schedules ─────────────────────────────────────────────────
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.workflow_schedules_title), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary, modifier = Modifier.weight(1f))
                    TextButton(onClick = { addingSchedule = true }) { Text(stringResource(R.string.workflow_schedule_add)) }
                }
            }
            if (schedules.isEmpty()) item { Text(stringResource(R.string.workflow_schedule_none), style = CoreHubTextStyles.meta, color = palette.textMuted) }
            for (schedule in schedules) {
                item(key = "schedule-${schedule.id}") {
                    ScheduleRow(
                        schedule = schedule,
                        onToggle = { viewModel.toggleWorkflowSchedule(schedule) },
                        onEdit = { expression, timezone, enabled -> viewModel.updateWorkflowSchedule(schedule, expression, timezone, enabled) },
                        onDelete = { viewModel.deleteWorkflowSchedule(schedule) },
                    )
                }
            }

            // ── runs ──────────────────────────────────────────────────────
            item { SectionHeader(R.string.workflow_runs_title) }
            if (runs.isEmpty()) item { Text(stringResource(R.string.workflow_no_runs), style = CoreHubTextStyles.meta, color = palette.textMuted) }
            for (run in runs) {
                item(key = "run-${run.id}") {
                    RunRow(
                        run = run,
                        onOpen = { viewModel.openWorkflowRun(run) },
                        onStop = { viewModel.stopWorkflowRun(run) },
                        onDelete = { deletingRun = run },
                    )
                }
            }
        }
    }
}

/**
 * One run: the node timeline with each node's status, timing, output and the
 * inline approval when a node waits for a person, plus stop and rerun.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkflowRunScreen(state: UiState, viewModel: AppViewModel) {
    val palette = CoreHub.palette
    val workflow = state.openWorkflow ?: return
    val detail = state.openWorkflowRun
    val live = state.workflowStatuses[workflow.id]
    val timeline = remember(workflow.nodes, workflow.edges, detail, live) {
        workflowTimeline(workflow.nodes, workflow.edges, detail, live)
    }
    LaunchedEffect(detail?.run?.id) {
        val run = detail?.run ?: return@LaunchedEffect
        if (run.active) viewModel.refreshWorkflowRun(run.workflowId, run.id)
    }

    Scaffold(
        topBar = {
            StudioTopBar(
                title = workflow.name,
                subtitle = detail?.run?.let { run ->
                    listOfNotNull(run.triggerSource, formatStamp(run.createdAt.toString()).takeIf { it.isNotBlank() }).joinToString(" · ")
                },
                onBack = { viewModel.back() },
                actions = {
                    detail?.run?.takeIf { it.active }?.let { run ->
                        IconButton(onClick = { viewModel.stopWorkflowRun(run) }) { Icon(Icons.Filled.Stop, contentDescription = stringResource(R.string.action_stop), tint = palette.error) }
                    }
                    detail?.run?.let { run ->
                        IconButton(onClick = { viewModel.refreshWorkflowRun(run.workflowId, run.id) }) {
                            Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.textSecondary)
                        }
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (state.loadingWorkflowRun) item { LoadingRow() }
            state.error?.let { message -> item { ErrorNote(message) { viewModel.dismissError() } } }
            state.notice?.let { message -> item { NoticeNote(message) { viewModel.dismissNotice() } } }
            detail?.run?.let { run ->
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusChip(run.status)
                        Text(run.id, style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = TextDirection.Ltr), color = palette.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                run.error?.let { message -> item { Text(message, style = CoreHubTextStyles.meta, color = palette.error) } }
            }
            if (!state.loadingWorkflowRun && timeline.isEmpty()) {
                item { Text(stringResource(R.string.workflow_no_nodes), style = CoreHubTextStyles.meta, color = palette.textMuted) }
            }
            for (index in timeline.indices) {
                val entry = timeline[index]
                item(key = "entry-${entry.node.id}") {
                    TimelineRow(
                        entry = entry,
                        last = index == timeline.lastIndex,
                        canAct = detail?.run != null,
                        onApprove = { approved -> detail?.run?.let { viewModel.approveWorkflowNode(it, entry.node.id, approved, entry.executionId) } },
                        onRerun = { detail?.run?.let { viewModel.rerunWorkflowFromNode(it, entry.node.id) } },
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(label: Int) {
    Text(stringResource(label), style = CoreHubTextStyles.groupHeader, color = CoreHub.palette.textSecondary)
}

/** A timeline row: the dot and rail, the node, its timing, error and actions. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TimelineRow(
    entry: WorkflowTimelineEntry,
    last: Boolean,
    canAct: Boolean,
    onApprove: (Boolean) -> Unit,
    onRerun: () -> Unit,
) {
    val palette = CoreHub.palette
    val color = workflowStatusColor(palette, entry.status)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(color))
            if (!last) Box(Modifier.width(1.dp).height(40.dp).background(palette.borderLight))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    entry.node.title,
                    style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content, fontWeight = FontWeight.Medium),
                    color = palette.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(6.dp))
                StatusChip(entry.status)
            }
            Text(
                listOf(entry.node.agent, entry.node.model).filter { it.isNotBlank() }.joinToString(" · "),
                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr),
                color = palette.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            entry.durationMillis?.let { Text(stringResource(R.string.workflow_node_duration, it / 1000.0), style = CoreHubTextStyles.meta, color = palette.textMuted) }
            entry.sessionId?.let {
                Text(stringResource(R.string.workflow_node_session, it), style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            entry.error?.let { Text(it, style = CoreHubTextStyles.meta, color = palette.error) }
            if (entry.node.input.isNotBlank()) {
                Surface(shape = RoundedCornerShape(CoreHubTokens.Radius.small), color = palette.codeBg, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        entry.node.input,
                        style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
                        color = palette.textSecondary,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }
            if (canAct) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (entry.awaitingApproval) {
                        TextButton(onClick = { onApprove(true) }) { Text(stringResource(R.string.action_approve)) }
                        TextButton(onClick = { onApprove(false) }) { Text(stringResource(R.string.action_reject), color = palette.error) }
                    }
                    TextButton(onClick = onRerun) { Text(stringResource(R.string.workflow_rerun_from_node)) }
                }
            }
        }
    }
}

@Composable
private fun RunRow(run: StudioWorkflowRun, onOpen: () -> Unit, onStop: () -> Unit, onDelete: () -> Unit) {
    val palette = CoreHub.palette
    Surface(
        shape = RoundedCornerShape(CoreHubTokens.Radius.medium),
        color = palette.bgCard,
        border = BorderStroke(1.dp, palette.borderLight),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen),
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusChip(run.status)
                    Text(formatStamp(run.createdAt.toString()), style = CoreHubTextStyles.meta, color = palette.textMuted)
                }
                Text(
                    stringResource(R.string.workflow_run_trigger, run.triggerSource),
                    style = CoreHubTextStyles.meta,
                    color = palette.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                run.error?.let { Text(it, style = CoreHubTextStyles.meta, color = palette.error, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            if (run.active) TextButton(onClick = onStop) { Text(stringResource(R.string.action_stop)) }
            TextButton(onClick = onDelete) { Text(stringResource(R.string.action_delete), color = palette.error) }
        }
    }
}

@Composable
private fun ScheduleRow(
    schedule: WorkflowSchedule,
    onToggle: () -> Unit,
    onEdit: (String, String, Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    val palette = CoreHub.palette
    var editing by remember { mutableStateOf(false) }
    if (editing) {
        ScheduleDialog(
            initial = schedule,
            onDismiss = { editing = false },
            onSave = { expression, timezone, enabled -> onEdit(expression, timezone, enabled); editing = false },
        )
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).clickable { editing = true }) {
            Text(
                "${schedule.schedule} · ${schedule.timezone}",
                style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = TextDirection.Ltr),
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            schedule.nextRunAt?.takeIf { it > 0 }?.let {
                Text(stringResource(R.string.workflow_schedule_next, formatStamp(it.toString())), style = CoreHubTextStyles.meta, color = palette.textMuted)
            }
        }
        Switch(checked = schedule.enabled, onCheckedChange = { onToggle() })
        TextButton(onClick = onDelete) { Text(stringResource(R.string.action_delete), color = palette.error) }
    }
}

@Composable
private fun ScheduleDialog(
    initial: WorkflowSchedule?,
    onDismiss: () -> Unit,
    onSave: (String, String, Boolean) -> Unit,
) {
    val palette = CoreHub.palette
    var expression by remember { mutableStateOf(initial?.schedule ?: "0 9 * * *") }
    var timezone by remember { mutableStateOf(initial?.timezone?.ifBlank { null } ?: java.util.TimeZone.getDefault().id) }
    val enabled = initial?.enabled ?: true
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (initial == null) R.string.workflow_schedule_add else R.string.workflow_schedule_edit)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = expression,
                    onValueChange = { expression = it },
                    label = { Text(stringResource(R.string.workflow_schedule_expression)) },
                    singleLine = true,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Ltr),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = timezone,
                    onValueChange = { timezone = it },
                    label = { Text(stringResource(R.string.workflow_timezone)) },
                    singleLine = true,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Ltr),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(enabled = expression.isNotBlank(), onClick = { onSave(expression.trim(), timezone.trim(), enabled) }) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

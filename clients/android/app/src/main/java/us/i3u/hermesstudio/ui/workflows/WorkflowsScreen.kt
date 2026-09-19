package us.i3u.hermesstudio.ui.workflows

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
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
import us.i3u.hermesstudio.StudioHorizontalPadding
import us.i3u.hermesstudio.StudioWorkflow
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.workflowChipStatus
import us.i3u.hermesstudio.ui.navigation.MenuButton
import us.i3u.hermesstudio.ui.sessions.formatStamp
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * The Workflow section (the web's WorkflowsView list): one row per workflow
 * with a live status chip, node/connection counts and its next schedule, plus
 * run, import and a long-press menu. The graph editor stays on the desktop.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkflowsScreen(state: UiState, viewModel: AppViewModel, onMenu: () -> Unit) {
    val palette = CoreHub.palette
    var runFor by remember { mutableStateOf<StudioWorkflow?>(null) }
    var deleting by remember { mutableStateOf<StudioWorkflow?>(null) }
    val context = LocalContext.current
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        val text = runCatching { context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } }.getOrNull()
        if (text.isNullOrBlank()) viewModel.reportAttachmentUnreadable(uri.lastPathSegment.orEmpty()) else viewModel.importWorkflow(text)
    }

    LaunchedEffect(Unit) { if (state.workflows.isEmpty() && !state.loadingWorkflows) viewModel.openWorkflows() }

    runFor?.let { workflow -> RunInputDialog(workflow, onDismiss = { runFor = null }, onRun = { input -> viewModel.runWorkflow(workflow, input); runFor = null }) }
    deleting?.let { workflow ->
        ConfirmDialog(
            title = stringResource(R.string.workflow_delete_title),
            body = workflow.name,
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.deleteWorkflow(workflow); deleting = null },
            onDismiss = { deleting = null },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.segment_workflow), style = MaterialTheme.typography.titleLarge) },
                navigationIcon = { MenuButton(onMenu) },
                actions = {
                    IconButton(onClick = { importer.launch("application/json") }) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.workflow_import), tint = palette.textSecondary)
                    }
                    IconButton(onClick = { viewModel.openWorkflows() }, enabled = !state.loadingWorkflows) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.textSecondary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.bgPrimary, scrolledContainerColor = palette.bgPrimary),
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = StudioHorizontalPadding, end = StudioHorizontalPadding, top = 8.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (state.loadingWorkflows && state.workflows.isEmpty()) item { LoadingRow() }
            state.error?.let { message -> item { ErrorNote(message) { viewModel.dismissError() } } }
            state.notice?.let { message -> item { NoticeNote(message) { viewModel.dismissNotice() } } }
            if (!state.loadingWorkflows && state.workflows.isEmpty()) {
                item {
                    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(CoreHubIcons.Workflow, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(32.dp))
                        Text(stringResource(R.string.workflows_empty), style = MaterialTheme.typography.bodyMedium, color = palette.textMuted)
                        Text(stringResource(R.string.workflows_mobile_note), style = CoreHubTextStyles.meta, color = palette.textMuted)
                    }
                }
            }
            items(state.workflows, key = { it.id }) { workflow ->
                WorkflowRow(
                    workflow = workflow,
                    status = workflowChipStatus(state.workflowStatuses[workflow.id], state.workflowRuns[workflow.id].orEmpty()),
                    runCount = state.workflowRuns[workflow.id].orEmpty().size,
                    scheduleCount = state.workflowSchedules[workflow.id].orEmpty().count { it.enabled },
                    onClick = { viewModel.openWorkflow(workflow) },
                    onRun = { runFor = workflow },
                    onExport = { viewModel.exportWorkflow(workflow) },
                    onDelete = { deleting = workflow },
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkflowRow(
    workflow: StudioWorkflow,
    status: String,
    runCount: Int,
    scheduleCount: Int,
    onClick: () -> Unit,
    onRun: () -> Unit,
    onExport: () -> Unit,
    onDelete: () -> Unit,
) {
    val palette = CoreHub.palette
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(CoreHubTokens.Radius.medium))
                .background(palette.bgCard)
                .combinedClickable(onClick = onClick, onLongClick = { menu = true })
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        workflow.name,
                        style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content, fontWeight = FontWeight.Medium),
                        color = palette.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    StatusChip(status)
                }
                Text(
                    stringResource(R.string.workflow_summary, workflow.profile, workflow.nodeCount, workflow.edgeCount),
                    style = CoreHubTextStyles.meta,
                    color = palette.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.workflow_run_count, runCount), style = CoreHubTextStyles.meta, color = palette.textMuted)
                    if (scheduleCount > 0) Text(stringResource(R.string.workflow_schedule_count, scheduleCount), style = CoreHubTextStyles.meta, color = palette.textMuted)
                    workflow.updatedAt.takeIf { it > 0 }?.let { Text(formatStamp(it.toString()), style = CoreHubTextStyles.meta, color = palette.textMuted) }
                }
            }
            IconButton(onClick = onRun, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.PlayArrow, contentDescription = stringResource(R.string.workflow_run), tint = palette.accent, modifier = Modifier.size(18.dp))
            }
            Icon(CoreHubIcons.ChevronRight, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(14.dp))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.action_open)) }, onClick = { menu = false; onClick() })
            DropdownMenuItem(text = { Text(stringResource(R.string.workflow_run)) }, onClick = { menu = false; onRun() })
            DropdownMenuItem(text = { Text(stringResource(R.string.workflow_export)) }, onClick = { menu = false; onExport() })
            DropdownMenuItem(text = { Text(stringResource(R.string.action_delete), color = palette.error) }, onClick = { menu = false; onDelete() })
        }
    }
}

/** A dot and the translated status word — the web's chip, sized for a phone row. */
@Composable
fun StatusChip(status: String) {
    val palette = CoreHub.palette
    val color = workflowStatusColor(palette, status)
    Row(
        modifier = Modifier.clip(RoundedCornerShape(CoreHubTokens.Radius.pill)).background(color.copy(alpha = CoreHubTokens.Alpha.SELECTED)).padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(workflowStatusText(status), style = CoreHubTextStyles.meta, color = palette.textSecondary, maxLines = 1)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RunInputDialog(workflow: StudioWorkflow, onDismiss: () -> Unit, onRun: (String?) -> Unit) {
    val palette = CoreHub.palette
    var input by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.workflow_run_title, workflow.name)) },
        text = {
            FlowRow {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    label = { Text(stringResource(R.string.workflow_input)) },
                    maxLines = 4,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = { TextButton(onClick = { onRun(input.trim().ifBlank { null }) }) { Text(stringResource(R.string.workflow_run)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

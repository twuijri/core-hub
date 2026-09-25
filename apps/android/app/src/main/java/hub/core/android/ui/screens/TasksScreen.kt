package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.AppGraph
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.realtime.TASKS_NAMESPACE
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.InContentDirection
import hub.core.android.ui.components.ListRow
import hub.core.android.ui.components.Loading
import hub.core.android.ui.components.ProfileBadge
import hub.core.android.ui.components.StatusBadge
import hub.core.android.ui.components.Tone
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.api.TasksApi
import hub.core.client.model.Agent
import hub.core.client.model.Task
import hub.core.client.model.TaskAssign
import hub.core.client.model.TaskColumns
import hub.core.client.model.TaskMove
import hub.core.client.model.TaskPriority
import hub.core.client.model.TaskStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The board's rules on the phone, apart from the screen so they are unit-tested. */
object Board {
    /** The columns the board shows, in the hub's order; archived tasks stay off the board. */
    fun columns(board: TaskColumns): List<Pair<TaskStatus, List<Task>>> =
        board.columns.filter { it.status != TaskStatus.ARCHIVED }.map { it.status to it.tasks }

    /** Where a card can be moved by hand: every other column (the hub refuses what it must). */
    fun moveTargets(task: Task): List<TaskStatus> = TaskStatus.entries.filter { it != task.status }

    /** A task with an assignee that is not running can be started. */
    fun canStart(task: Task): Boolean = task.assignee != null && task.status != TaskStatus.RUNNING && task.status != TaskStatus.DONE

    /** Several profiles on the board: every card carries its profile's badge (ADR 0016). */
    fun showsProfiles(board: TaskColumns): Boolean =
        board.columns.flatMap { it.tasks }.map { it.profile }.distinct().size > 1
}

data class TasksUi(
    val board: TaskColumns? = null,
    val loading: Boolean = true,
    val error: HubError? = null,
    val acting: Boolean = false,
)

/**
 * Tasks shows every profile the person may enter with no profile filter (ADR 0016 stage 2);
 * anything done to a card goes to the card's own profile.
 */
class TasksViewModel(private val graph: AppGraph) : ViewModel() {
    private val _ui = MutableStateFlow(TasksUi())
    val ui: StateFlow<TasksUi> = _ui.asStateFlow()
    private var pending: Job? = null

    init {
        graph.realtime.subscribeAll(TASKS_NAMESPACE)
        reload()
        viewModelScope.launch {
            graph.realtime.events.collect { e ->
                if (e.namespace == TASKS_NAMESPACE && (e.event.startsWith("task.") || e.event.startsWith("subtask."))) {
                    // A burst of moves reloads once.
                    pending?.cancel()
                    pending = launch { delay(300); reload() }
                }
            }
        }
    }

    fun reload() {
        val s = graph.store.current ?: return
        viewModelScope.launch {
            hubCall { graph.apis(s).tasks.tasksGetColumns(profiles = TasksApi.ProfilesTasksGetColumns.ALL) }
                .onSuccess { b -> _ui.update { it.copy(board = b, loading = false, error = null) } }
                .onFailure { e -> _ui.update { it.copy(loading = false, error = e as HubError) } }
        }
    }

    private fun act(block: suspend () -> Unit) {
        _ui.update { it.copy(acting = true, error = null) }
        viewModelScope.launch {
            hubCall { block() }
                .onSuccess { _ui.update { it.copy(acting = false) }; reload() }
                .onFailure { e -> _ui.update { it.copy(acting = false, error = e as HubError) } }
        }
    }

    fun move(task: Task, to: TaskStatus) {
        val s = graph.store.current ?: return
        act { graph.apis(s).tasks.tasksMoveTask(task.profile, task.id, TaskMove(status = to)) }
    }

    fun assign(task: Task, agentId: String, start: Boolean) {
        val s = graph.store.current ?: return
        act { graph.apis(s).tasks.tasksAssignTask(task.profile, task.id, TaskAssign(agentId = agentId, start = start)) }
    }

    /** The agents that can take a task in its own profile. */
    suspend fun agentsFor(task: Task): List<Agent> {
        val s = graph.store.current ?: return emptyList()
        return hubCall { graph.apis(s).agents.agentsList(task.profile).items }.getOrDefault(emptyList()).let(ChatAgents::startable)
    }
}

@Composable
fun statusLabel(status: TaskStatus): String = stringResource(
    when (status) {
        TaskStatus.TRIAGE -> R.string.task_triage
        TaskStatus.TODO -> R.string.task_todo
        TaskStatus.READY -> R.string.task_ready
        TaskStatus.SCHEDULED -> R.string.task_scheduled
        TaskStatus.RUNNING -> R.string.task_running
        TaskStatus.BLOCKED -> R.string.task_blocked
        TaskStatus.REVIEW -> R.string.task_review
        TaskStatus.DONE -> R.string.task_done
        TaskStatus.ARCHIVED -> R.string.task_archived
    },
)

@Composable
private fun priorityLabel(priority: TaskPriority): String = stringResource(
    when (priority) {
        TaskPriority.LOW -> R.string.priority_low
        TaskPriority.HIGH -> R.string.priority_high
        TaskPriority.URGENT -> R.string.priority_urgent
        else -> R.string.priority_normal
    },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(shell: ShellViewModel, onOpenChat: (sessionId: String, profile: String) -> Unit) {
    val context = LocalContext.current
    val vm: TasksViewModel = viewModel { TasksViewModel(context.graph) }
    val ui by vm.ui.collectAsState()
    val board = ui.board
    var selectedColumn by rememberSaveable { mutableStateOf(0) }
    var opened by remember { mutableStateOf<Task?>(null) }
    Column(Modifier.fillMaxSize()) {
        ui.error?.let { ErrorNotice(it, Modifier.padding(12.dp)) }
        if (board == null) {
            if (ui.loading) Loading()
            return@Column
        }
        val columns = Board.columns(board)
        val badges = Board.showsProfiles(board)
        selectedColumn = selectedColumn.coerceIn(0, (columns.size - 1).coerceAtLeast(0))
        PrimaryScrollableTabRow(selectedTabIndex = selectedColumn, edgePadding = 12.dp) {
            columns.forEachIndexed { i, (status, tasks) ->
                Tab(selected = i == selectedColumn, onClick = { selectedColumn = i }, text = { Text("${statusLabel(status)} · ${tasks.size}") })
            }
        }
        val tasks = columns.getOrNull(selectedColumn)?.second.orEmpty()
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxSize()) {
            if (tasks.isEmpty()) item { Text(stringResource(R.string.tasks_empty_column), color = LocalTokens.current.textMuted) }
            items(tasks, key = { it.id }) { task ->
                ListRow(
                    title = task.title,
                    subtitle = listOfNotNull(task.assignee?.name, priorityLabel(task.priority), task.latestSummary).joinToString(" · "),
                    trailing = { if (badges) ProfileBadge(shell.profileName(task.profile)) },
                    onClick = { opened = task },
                )
            }
        }
    }
    opened?.let { task ->
        ModalBottomSheet(onDismissRequest = { opened = null }) {
            TaskSheet(task, vm, ui.acting, onOpenChat = { id -> opened = null; onOpenChat(id, task.profile) }, onDone = { opened = null })
        }
    }
}

@Composable
private fun TaskSheet(task: Task, vm: TasksViewModel, acting: Boolean, onOpenChat: (String) -> Unit, onDone: () -> Unit) {
    val t = LocalTokens.current
    var moveOpen by remember { mutableStateOf(false) }
    var assigning by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        InContentDirection(task.title) { Text(task.title, style = MaterialTheme.typography.titleMedium) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusBadge(statusLabel(task.status), if (task.status == TaskStatus.BLOCKED) Tone.DANGER else if (task.status == TaskStatus.RUNNING) Tone.SUCCESS else null)
            StatusBadge(priorityLabel(task.priority))
            task.assignee?.let { StatusBadge(it.name, Tone.INFO) }
        }
        task.description?.takeIf { it.isNotBlank() }?.let { d -> InContentDirection(d) { Text(d, style = MaterialTheme.typography.bodyMedium) } }
        (task.blockedReason ?: task.statusReason)?.let { Text(it, color = t.dangerSoftText, style = MaterialTheme.typography.bodySmall) }
        task.latestSummary?.let { s -> InContentDirection(s) { Text(s, color = t.textMuted, style = MaterialTheme.typography.bodySmall) } }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row {
                OutlinedButton(onClick = { moveOpen = true }, enabled = !acting) { Text(stringResource(R.string.tasks_move)) }
                DropdownMenu(expanded = moveOpen, onDismissRequest = { moveOpen = false }) {
                    Board.moveTargets(task).forEach { status ->
                        DropdownMenuItem(text = { Text(statusLabel(status)) }, onClick = { moveOpen = false; vm.move(task, status); onDone() })
                    }
                }
            }
            OutlinedButton(onClick = { assigning = true }, enabled = !acting) { Text(stringResource(R.string.tasks_assign)) }
            if (Board.canStart(task)) {
                Button(onClick = { vm.assign(task, task.assignee!!.id, start = true); onDone() }, enabled = !acting) { Text(stringResource(R.string.tasks_start)) }
            }
            task.sessionId?.let { id -> TextButton(onClick = { onOpenChat(id) }) { Text(stringResource(R.string.tasks_open_chat)) } }
        }
    }
    if (assigning) AssignDialog(task, vm, onDismiss = { assigning = false }, onAssigned = { assigning = false; onDone() })
}

@Composable
private fun AssignDialog(task: Task, vm: TasksViewModel, onDismiss: () -> Unit, onAssigned: () -> Unit) {
    var agents by remember { mutableStateOf<List<Agent>?>(null) }
    var chosen by remember { mutableStateOf(task.assignee?.id) }
    var start by remember { mutableStateOf(true) }
    LaunchedEffect(task.id) { agents = vm.agentsFor(task) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.tasks_assign)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                when (val list = agents) {
                    null -> Loading(Modifier.padding(8.dp))
                    else -> list.forEach { a ->
                        ListRow(a.name, trailing = { if (a.id == chosen) StatusBadge("✓", Tone.SUCCESS) }, onClick = { chosen = a.id })
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = start, onCheckedChange = { start = it })
                    Text(stringResource(R.string.tasks_start_now))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { chosen?.let { vm.assign(task, it, start); onAssigned() } }, enabled = chosen != null) {
                Text(stringResource(R.string.tasks_assign))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

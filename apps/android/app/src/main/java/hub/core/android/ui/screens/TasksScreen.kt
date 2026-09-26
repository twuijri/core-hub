package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubRadio
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.kit.StatusDot
import hub.core.android.ui.kit.ToggleRow
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import hub.core.android.ui.components.Loading
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

/** A column's colour, the web board's (status-* tokens). */
@Composable
fun statusColor(status: TaskStatus): androidx.compose.ui.graphics.Color {
    val t = LocalTokens.current
    return when (status) {
        TaskStatus.RUNNING -> t.statusRunning
        TaskStatus.BLOCKED -> t.statusBlocked
        TaskStatus.SCHEDULED -> t.statusScheduled
        TaskStatus.REVIEW -> t.statusReview
        TaskStatus.READY -> t.statusReady
        TaskStatus.DONE -> t.successSoftText
        else -> t.textFaint
    }
}

private fun priorityTone(priority: TaskPriority): BadgeTone = when (priority) {
    TaskPriority.URGENT -> BadgeTone.Danger
    TaskPriority.HIGH -> BadgeTone.Warning
    else -> BadgeTone.Neutral
}

/**
 * Tasks on the phone, as on iOS: the board's columns one under another — each titled with its
 * colour and count — and a card per task (title, profile, priority, who has it, the latest line).
 * A tap opens the task's sheet.
 */
@Composable
fun TasksScreen(shell: ShellViewModel, onOpenChat: (sessionId: String, profile: String) -> Unit) {
    val context = LocalContext.current
    val vm: TasksViewModel = viewModel { TasksViewModel(context.graph) }
    val ui by vm.ui.collectAsState()
    val board = ui.board
    val t = LocalTokens.current
    var opened by remember { mutableStateOf<Task?>(null) }
    Column(Modifier.fillMaxSize()) {
        ui.error?.let { ErrorNotice(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        if (board == null) {
            if (ui.loading) Loading()
            return@Column
        }
        val columns = Board.columns(board).filter { it.second.isNotEmpty() }
        val badges = Board.showsProfiles(board)
        LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxSize().testTag("tasks.board"),
        ) {
            if (columns.isEmpty()) item { EmptyState(stringResource(R.string.tasks_empty_column), icon = Lucide.ListChecks) }
            columns.forEach { (status, tasks) ->
                item(key = "h-" + status.value) {
                    SectionTitle("${statusLabel(status)} · ${tasks.size}", leading = { StatusDot(statusColor(status), null) })
                }
                items(tasks, key = { it.id }) { task ->
                    HubCard(Modifier.testTag("task.card.${task.id}"), onClick = { opened = task }, padding = 14.dp) {
                        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            InContentDirection(task.title) {
                                Text(task.title, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            if (badges) Badge(shell.profileName(task.profile), tone = BadgeTone.Accent)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Badge(priorityLabel(task.priority), tone = priorityTone(task.priority))
                            task.assignee?.let { Text(it.name, fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
                        }
                        task.latestSummary?.takeIf { it.isNotBlank() }?.let { line ->
                            InContentDirection(line) { Text(line, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                }
            }
        }
    }
    opened?.let { task ->
        HubSheet(onDismiss = { opened = null }) {
            TaskSheet(task, vm, ui.acting, onOpenChat = { id -> opened = null; onOpenChat(id, task.profile) }, onDone = { opened = null })
        }
    }
}

/** A task's sheet: what it is and where it stands, then one primary action and the others beside it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TaskSheet(task: Task, vm: TasksViewModel, acting: Boolean, onOpenChat: (String) -> Unit, onDone: () -> Unit) {
    val t = LocalTokens.current
    var moveOpen by remember { mutableStateOf(false) }
    var assigning by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("task.sheet"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        InContentDirection(task.title) { Text(task.title, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Badge(
                statusLabel(task.status), dot = true,
                tone = when (task.status) { TaskStatus.BLOCKED -> BadgeTone.Danger; TaskStatus.RUNNING -> BadgeTone.Success; TaskStatus.REVIEW -> BadgeTone.Review; else -> BadgeTone.Neutral },
            )
            Badge(priorityLabel(task.priority), tone = priorityTone(task.priority))
            task.assignee?.let { Badge(it.name, tone = BadgeTone.Info) }
        }
        task.description?.takeIf { it.isNotBlank() }?.let { d -> InContentDirection(d) { Text(d, fontSize = FontTokens.sizeSm.sp) } }
        (task.blockedReason ?: task.statusReason)?.let { NoticeBox(it, BadgeTone.Danger) }
        task.latestSummary?.let { s -> InContentDirection(s) { Text(s, color = t.textMuted, fontSize = FontTokens.sizeSm.sp) } }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
            if (Board.canStart(task)) {
                HubButton(stringResource(R.string.tasks_start), { vm.assign(task, task.assignee!!.id, start = true); onDone() }, size = ControlSize.Md, icon = Lucide.Play, enabled = !acting)
            }
            Box {
                HubButton(stringResource(R.string.tasks_move), { moveOpen = true }, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.ChevronsUpDown, enabled = !acting)
                HubMenu(moveOpen, { moveOpen = false }) {
                    Board.moveTargets(task).forEach { status ->
                        MenuItem(statusLabel(status), { moveOpen = false; vm.move(task, status); onDone() })
                    }
                }
            }
            HubButton(stringResource(R.string.tasks_assign), { assigning = true }, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.UserPlus, enabled = !acting)
            task.sessionId?.let { id ->
                HubButton(stringResource(R.string.tasks_open_chat), { onOpenChat(id) }, kind = ButtonKind.Ghost, size = ControlSize.Md, icon = Lucide.MessagesSquare)
            }
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
    HubDialog(onDismiss, stringResource(R.string.tasks_assign)) {
        when (val list = agents) {
            null -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { Spinner(20.dp) }
            else -> GroupedList {
                list.forEach { a ->
                    Item(a.name, onClick = { chosen = a.id }, trailing = { HubRadio(a.id == chosen) })
                }
            }
        }
        ToggleRow(stringResource(R.string.tasks_start_now), start, { start = it })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HubButton(stringResource(R.string.cancel), onDismiss, kind = ButtonKind.Secondary, size = ControlSize.Md)
            HubButton(stringResource(R.string.tasks_assign), { chosen?.let { vm.assign(task, it, start); onAssigned() } }, size = ControlSize.Md, enabled = chosen != null)
        }
    }
}

package hub.core.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.generated.FontTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.ui.components.InContentDirection
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Chip
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.StatusDot
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Task
import hub.core.client.model.TaskColumns
import hub.core.client.model.TaskStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * The board's shape on the phone, the web's (`packages/web/src/tasks/board.ts`): the hub's nine
 * statuses regrouped as an intake strip plus four columns, where a drop into a column means a
 * move a person may make — asked when it can mean two things, a reason asked for a block, a
 * confirmation for the archive. Inside a column a drop is a reorder.
 */
object BoardRules {
    enum class ColumnId { INTAKE, QUEUE, WAITING, REVIEW, DONE }

    data class ColumnDef(val id: ColumnId, val statuses: List<TaskStatus>, val collapsible: Boolean)

    val INTAKE = ColumnDef(ColumnId.INTAKE, listOf(TaskStatus.TRIAGE), true)
    val COLUMNS = listOf(
        ColumnDef(ColumnId.QUEUE, listOf(TaskStatus.TODO, TaskStatus.READY, TaskStatus.RUNNING), false),
        ColumnDef(ColumnId.WAITING, listOf(TaskStatus.SCHEDULED, TaskStatus.BLOCKED), true),
        ColumnDef(ColumnId.REVIEW, listOf(TaskStatus.REVIEW), false),
        ColumnDef(ColumnId.DONE, listOf(TaskStatus.DONE), false),
    )

    enum class Action { QUEUE, PROMOTE, SCHEDULE, BLOCK, UNBLOCK, REQUEST_REVIEW, REOPEN_REVIEW, COMPLETE, ARCHIVE }

    data class Transition(val action: Action, val requiresReason: Boolean = false, val confirm: Boolean = false)

    data class Drop(val to: TaskStatus, val transition: Transition)

    /** Keyed by destination, then origin: what a move means, or nothing when a person may not make it. */
    private val RULES: Map<TaskStatus, Map<TaskStatus, Transition>> = mapOf(
        TaskStatus.TODO to mapOf(
            TaskStatus.TRIAGE to Transition(Action.QUEUE), TaskStatus.BLOCKED to Transition(Action.UNBLOCK),
            TaskStatus.SCHEDULED to Transition(Action.UNBLOCK), TaskStatus.REVIEW to Transition(Action.REOPEN_REVIEW),
        ),
        TaskStatus.READY to mapOf(
            TaskStatus.TODO to Transition(Action.PROMOTE), TaskStatus.BLOCKED to Transition(Action.UNBLOCK),
            TaskStatus.SCHEDULED to Transition(Action.UNBLOCK), TaskStatus.REVIEW to Transition(Action.REOPEN_REVIEW),
        ),
        TaskStatus.SCHEDULED to mapOf(
            TaskStatus.TODO to Transition(Action.SCHEDULE), TaskStatus.READY to Transition(Action.SCHEDULE),
            TaskStatus.RUNNING to Transition(Action.SCHEDULE), TaskStatus.BLOCKED to Transition(Action.SCHEDULE),
        ),
        TaskStatus.BLOCKED to mapOf(
            TaskStatus.TODO to Transition(Action.BLOCK, requiresReason = true),
            TaskStatus.READY to Transition(Action.BLOCK, requiresReason = true),
            TaskStatus.RUNNING to Transition(Action.BLOCK, requiresReason = true),
        ),
        TaskStatus.REVIEW to mapOf(TaskStatus.READY to Transition(Action.REQUEST_REVIEW), TaskStatus.RUNNING to Transition(Action.REQUEST_REVIEW)),
        TaskStatus.DONE to mapOf(
            TaskStatus.READY to Transition(Action.COMPLETE), TaskStatus.RUNNING to Transition(Action.COMPLETE),
            TaskStatus.REVIEW to Transition(Action.COMPLETE), TaskStatus.BLOCKED to Transition(Action.COMPLETE),
        ),
        TaskStatus.ARCHIVED to mapOf(TaskStatus.DONE to Transition(Action.ARCHIVE, confirm = true)),
    )

    fun transitionFor(from: TaskStatus, to: TaskStatus): Transition? = if (from == to) null else RULES[to]?.get(from)

    /** What a drop into [column] may mean for a card from [from]; empty for a reorder or a refusal. */
    fun dropOptions(from: TaskStatus, column: ColumnDef): List<Drop> {
        if (from in column.statuses) return emptyList()
        val seen = mutableSetOf<Action>()
        return column.statuses.mapNotNull { to ->
            transitionFor(from, to)?.takeIf { seen.add(it.action) }?.let { Drop(to, it) }
        }
    }

    fun isDropTarget(from: TaskStatus, column: ColumnDef): Boolean = from in column.statuses || dropOptions(from, column).isNotEmpty()

    /** The column a status shows in (the archive behind Done), the intake for `triage`. */
    fun columnOf(status: TaskStatus): ColumnDef = when (status) {
        TaskStatus.TRIAGE -> INTAKE
        TaskStatus.ARCHIVED -> COLUMNS.last()
        else -> COLUMNS.first { status in it.statuses }
    }

    /** Whether a column folds to a strip: only a foldable empty one nobody opened, unless the card dragged may land there. */
    fun collapsed(column: ColumnDef, count: Int, openedByHand: Boolean, dragging: TaskStatus?): Boolean {
        if (!column.collapsible || count > 0 || openedByHand) return false
        if (dragging != null && isDropTarget(dragging, column)) return false
        return true
    }

    /** The card prints its stage when its column does not already say it. */
    fun showsStatusWord(status: TaskStatus): Boolean = status != TaskStatus.TODO && status != TaskStatus.TRIAGE

    /** The board regrouped: the intake's tasks, then each column's, in the hub's order within each. */
    fun group(board: TaskColumns): Map<ColumnId, List<Task>> {
        val byStatus = board.columns.associate { it.status to it.tasks }
        return (listOf(INTAKE) + COLUMNS).associate { c -> c.id to c.statuses.flatMap { byStatus[it].orEmpty() } }
    }

    /** How many tasks sit in the archive behind Done (the hub counts it without sending it, §93). */
    fun archived(board: TaskColumns): Int =
        board.columns.firstOrNull { it.status == TaskStatus.ARCHIVED }?.count ?: board.counts.byStatus["archived"] ?: 0

    /**
     * Where a card dropped inside its own column lands: after the card above the drop point that
     * shares its profile (the hub keeps order per profile), or first (`null`). Unchanged is null too.
     */
    fun reorderAfter(column: List<Task>, dragged: Task, index: Int): Reorder? {
        val others = column.filter { it.id != dragged.id }
        val at = index.coerceIn(0, others.size)
        val above = others.take(at).lastOrNull { it.profile == dragged.profile }
        val before = column.takeWhile { it.id != dragged.id }.lastOrNull { it.profile == dragged.profile }
        if (above?.id == before?.id) return null
        return Reorder(above?.id)
    }

    data class Reorder(val afterTaskId: String?)

    /** What letting go of a card over a column does. */
    sealed interface Outcome {
        /** Elsewhere in its own column: the hub keeps the order. */
        data class Reordered(val afterTaskId: String?) : Outcome
        /** One move it can mean: made at once, or after a reason or a yes. */
        data class Move(val drop: Drop) : Outcome
        /** Two moves it can mean: the person says which. */
        data class Choose(val options: List<Drop>) : Outcome
        /** Not a move a person may make there. */
        data object Refused : Outcome
        /** Where it was: nothing to do. */
        data object Unchanged : Outcome
    }

    /** [index] is how many of the column's other cards lie above the drop point. */
    fun outcome(task: Task, column: ColumnDef, columnTasks: List<Task>, index: Int): Outcome {
        val options = dropOptions(task.status, column)
        return when {
            options.isEmpty() && task.status in column.statuses ->
                reorderAfter(columnTasks, task, index)?.let { Outcome.Reordered(it.afterTaskId) } ?: Outcome.Unchanged
            options.isEmpty() -> Outcome.Refused
            options.size == 1 -> Outcome.Move(options.first())
            else -> Outcome.Choose(options)
        }
    }

    /** A task that waits for others (§93): their titles, for its badge and sheet. */
    fun waitingOn(task: Task): List<String> = task.waitingOn.orEmpty().map { it.title }

    /** A running task whose run has gone quiet (§93). */
    fun stuck(task: Task): Boolean = task.stuckSince != null && task.status == TaskStatus.RUNNING
}

@androidx.compose.runtime.Composable
private fun columnTitle(id: BoardRules.ColumnId): String = stringResource(
    when (id) {
        BoardRules.ColumnId.INTAKE -> R.string.board_intake
        BoardRules.ColumnId.QUEUE -> R.string.board_queue
        BoardRules.ColumnId.WAITING -> R.string.board_waiting
        BoardRules.ColumnId.REVIEW -> R.string.board_review
        BoardRules.ColumnId.DONE -> R.string.board_done
    },
)

@Composable
private fun actionLabel(action: BoardRules.Action): String = stringResource(
    when (action) {
        BoardRules.Action.QUEUE -> R.string.board_action_queue
        BoardRules.Action.PROMOTE -> R.string.board_action_promote
        BoardRules.Action.SCHEDULE -> R.string.board_action_schedule
        BoardRules.Action.BLOCK -> R.string.board_action_block
        BoardRules.Action.UNBLOCK -> R.string.board_action_unblock
        BoardRules.Action.REQUEST_REVIEW -> R.string.board_action_review
        BoardRules.Action.REOPEN_REVIEW -> R.string.board_action_reopen
        BoardRules.Action.COMPLETE -> R.string.board_action_complete
        BoardRules.Action.ARCHIVE -> R.string.board_action_archive
    },
)

private data class DragState(val task: Task, val pointer: Offset, val grab: Offset, val width: Float)

/** A drop that needs the person: which move, a reason, or a yes. */
private sealed interface Pending {
    data class Choose(val task: Task, val options: List<BoardRules.Drop>) : Pending
    data class Reason(val task: Task, val drop: BoardRules.Drop) : Pending
    data class Confirm(val task: Task, val drop: BoardRules.Drop) : Pending
}

/**
 * The board: columns side by side, scrolled or swiped between (the chips above jump to one), a
 * card per task. A long press lifts a card; it drops into another column (a move) or elsewhere
 * in its own (a reorder); the page scrolls when the card nears an edge.
 */
@Composable
fun TaskBoard(board: TaskColumns, badges: Boolean, profileName: (String) -> String, vm: TasksViewModel, onOpen: (Task) -> Unit) {
    val t = LocalTokens.current
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val grouped = remember(board) { BoardRules.group(board) }
    val archived = remember(board) { BoardRules.archived(board) }
    val columnBounds = remember { mutableStateMapOf<BoardRules.ColumnId, Rect>() }
    val cardBounds = remember { mutableStateMapOf<String, Rect>() }
    val columnX = remember { mutableStateMapOf<BoardRules.ColumnId, Int>() }
    var drag by remember { mutableStateOf<DragState?>(null) }
    var openedByHand by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Pending?>(null) }
    var boardOrigin by remember { mutableStateOf(Offset.Zero) }
    val scroll = rememberScrollState()
    val columns = (if (grouped[BoardRules.ColumnId.INTAKE].orEmpty().isNotEmpty()) listOf(BoardRules.INTAKE) else emptyList()) + BoardRules.COLUMNS

    fun hoveredColumn(p: Offset): BoardRules.ColumnDef? =
        columns.firstOrNull { c -> columnBounds[c.id]?.let { it.left <= p.x && p.x <= it.right } == true }

    fun start(drop: BoardRules.Drop, task: Task) {
        pending = when {
            drop.transition.requiresReason -> Pending.Reason(task, drop)
            drop.transition.confirm -> Pending.Confirm(task, drop)
            else -> { vm.move(task, drop.to); null }
        }
    }

    fun drop(state: DragState) {
        val column = hoveredColumn(state.pointer) ?: return
        val task = state.task
        val list = grouped[column.id].orEmpty()
        val index = list.filter { it.id != task.id }.count { other -> (cardBounds[other.id]?.center?.y ?: Float.MAX_VALUE) < state.pointer.y }
        when (val outcome = BoardRules.outcome(task, column, list, index)) {
            is BoardRules.Outcome.Reordered -> vm.reorder(task, outcome.afterTaskId)
            is BoardRules.Outcome.Move -> start(outcome.drop, task)
            is BoardRules.Outcome.Choose -> pending = Pending.Choose(task, outcome.options)
            BoardRules.Outcome.Refused -> vm.say(R.string.board_cannot_drop)
            BoardRules.Outcome.Unchanged -> Unit
        }
    }
    val dropNow by androidx.compose.runtime.rememberUpdatedState<(DragState) -> Unit> { drop(it) }

    // Near an edge, the board scrolls under the lifted card.
    LaunchedEffect(drag != null) {
        while (drag != null) {
            val p = drag!!.pointer.x - boardOrigin.x
            val edge = with(density) { 56.dp.toPx() }
            val width = scroll.viewportSize.toFloat()
            val step = when {
                p < edge -> -with(density) { 14.dp.toPx() }
                p > width - edge -> with(density) { 14.dp.toPx() }
                else -> 0f
            }
            if (step != 0f) scroll.scrollBy(step)
            delay(16)
        }
    }

    Column(Modifier.fillMaxSize().testTag("tasks.board")) {
        // The columns by name and count: a tap brings one into view.
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            columns.forEach { c ->
                Chip(
                    "${columnTitle(c.id)} · ${grouped[c.id].orEmpty().size}", selected = false,
                    onClick = { columnX[c.id]?.let { x -> scope.launch { scroll.animateScrollTo(x) } } },
                    size = ControlSize.Sm, modifier = Modifier.testTag("board.jump.${c.id.name.lowercase()}"),
                )
            }
        }
        BoxWithConstraints(Modifier.fillMaxSize().onGloballyPositioned { boardOrigin = it.boundsInRoot().topLeft }) {
            val full = maxWidth * 0.86f
            Row(
                Modifier.fillMaxSize().horizontalScroll(scroll, enabled = drag == null).padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                columns.forEach { column ->
                    val tasks = grouped[column.id].orEmpty()
                    val folded = BoardRules.collapsed(column, tasks.size, openedByHand, drag?.task?.status)
                    val target = drag?.let { d -> hoveredColumn(d.pointer)?.id == column.id && BoardRules.isDropTarget(d.task.status, column) } == true
                    val refused = drag?.let { d -> !BoardRules.isDropTarget(d.task.status, column) } == true
                    Column(
                        Modifier.width(if (folded) 56.dp else full).fillMaxHeight()
                            .alpha(if (refused) 0.45f else 1f)
                            .background(if (target) t.accentSoft else t.surface2.copy(alpha = 0.5f), RoundedCornerShape(RadiusTokens.lg.dp))
                            .border(if (target) 1.5.dp else 0.dp, if (target) t.accent else t.border.copy(alpha = 0f), RoundedCornerShape(RadiusTokens.lg.dp))
                            .onGloballyPositioned { columnBounds[column.id] = it.boundsInRoot(); columnX[column.id] = (it.boundsInRoot().left - boardOrigin.x + scroll.value).roundToInt().coerceAtLeast(0) }
                            .testTag("board.column.${column.id.name.lowercase()}")
                            .padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (folded) {
                            // An empty Waiting column is a strip; a tap opens it.
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                                HubButton("0", { openedByHand = true }, kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.Clock, modifier = Modifier.testTag("board.unfold.${column.id.name.lowercase()}"))
                            }
                            return@Column
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(horizontal = 4.dp)) {
                            StatusDot(statusColor(column.statuses.first()), null)
                            Text("${columnTitle(column.id)} · ${tasks.size}", fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted)
                        }
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (tasks.isEmpty()) Text(stringResource(R.string.board_empty_column), fontSize = FontTokens.sizeXs.sp, color = t.textFaint, modifier = Modifier.padding(8.dp))
                            tasks.forEach { task ->
                                val lifted = drag?.task?.id == task.id
                                TaskCard(
                                    task, badges, profileName,
                                    Modifier
                                        .onGloballyPositioned { cardBounds[task.id] = it.boundsInRoot() }
                                        .alpha(if (lifted) 0.3f else 1f)
                                        .pointerInput(task.id, task.status) {
                                            detectDragGesturesAfterLongPress(
                                                onDragStart = { at ->
                                                    val bounds = cardBounds[task.id] ?: return@detectDragGesturesAfterLongPress
                                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                    drag = DragState(task, bounds.topLeft + at, at, bounds.width)
                                                },
                                                onDrag = { change, amount ->
                                                    change.consume()
                                                    drag = drag?.let { it.copy(pointer = it.pointer + amount) }
                                                },
                                                onDragEnd = { drag?.let { dropNow(it) }; drag = null },
                                                onDragCancel = { drag = null },
                                            )
                                        },
                                    onClick = { onOpen(task) },
                                )
                            }
                            if (column.id == BoardRules.ColumnId.DONE && archived > 0) {
                                Text(stringResource(R.string.board_archived, archived), fontSize = FontTokens.sizeXs.sp, color = t.textMuted, modifier = Modifier.padding(8.dp))
                            }
                        }
                    }
                }
            }
            // The lifted card follows the finger above everything.
            drag?.let { d ->
                val origin = d.pointer - d.grab - boardOrigin
                Box(
                    Modifier.offset { IntOffset(origin.x.roundToInt(), origin.y.roundToInt()) }
                        .width(with(density) { d.width.toDp() })
                        .shadow(12.dp, RoundedCornerShape(RadiusTokens.lg.dp))
                        .testTag("board.lifted"),
                ) {
                    TaskCard(d.task, badges, profileName, onClick = {})
                }
            }
        }
    }

    when (val p = pending) {
        is Pending.Choose -> HubSheet(onDismiss = { pending = null }, title = stringResource(R.string.board_which)) {
            p.options.forEach { option ->
                MenuItem(actionLabel(option.transition.action), { start(option, p.task) }, icon = Lucide.ChevronRight, modifier = Modifier.testTag("board.option.${option.to.value}"))
            }
        }
        is Pending.Reason -> {
            var reason by remember(p) { mutableStateOf("") }
            HubDialog({ pending = null }, stringResource(R.string.board_block_reason)) {
                HubTextField(reason, { reason = it }, placeholder = stringResource(R.string.board_block_reason_hint), singleLine = false, maxLines = 4, fieldTag = "board.reason")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    HubButton(stringResource(R.string.cancel), { pending = null }, kind = ButtonKind.Secondary, size = ControlSize.Md)
                    HubButton(actionLabel(p.drop.transition.action), { vm.move(p.task, p.drop.to, reason.trim()); pending = null }, size = ControlSize.Md, enabled = reason.isNotBlank(), modifier = Modifier.testTag("board.reason.ok"))
                }
            }
        }
        is Pending.Confirm -> ConfirmDialog(
            stringResource(R.string.board_archive_confirm, p.task.title), null, actionLabel(p.drop.transition.action),
            onConfirm = { vm.move(p.task, p.drop.to); pending = null }, onDismiss = { pending = null },
        )
        null -> Unit
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
/** A task's card: its title, profile, stage, what it waits on or that it seems stuck, who has it, its latest line. */
@Composable
fun TaskCard(task: Task, badges: Boolean, profileName: (String) -> String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val t = LocalTokens.current
    HubCard(modifier.testTag("task.card.${task.id}"), onClick = onClick, padding = 12.dp) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            InContentDirection(task.title) {
                Text(task.title, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            if (badges) Badge(profileName(task.profile), tone = BadgeTone.Accent)
        }
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (BoardRules.showsStatusWord(task.status)) {
                Badge(
                    statusLabel(task.status), dot = true,
                    tone = when (task.status) {
                        TaskStatus.BLOCKED -> BadgeTone.Danger; TaskStatus.RUNNING -> BadgeTone.Success
                        TaskStatus.REVIEW -> BadgeTone.Review; TaskStatus.SCHEDULED -> BadgeTone.Warning; else -> BadgeTone.Neutral
                    },
                )
            }
            if (BoardRules.stuck(task)) Badge(stringResource(R.string.board_stuck), tone = BadgeTone.Danger, modifier = Modifier.testTag("task.stuck.${task.id}"))
            val waiting = BoardRules.waitingOn(task)
            if (waiting.isNotEmpty()) Badge(stringResource(R.string.board_waiting_on, waiting.size), tone = BadgeTone.Warning, modifier = Modifier.testTag("task.waiting.${task.id}"))
            if (task.priority != hub.core.client.model.TaskPriority.NORMAL) Badge(priorityText(task.priority), tone = if (task.priority == hub.core.client.model.TaskPriority.LOW) BadgeTone.Neutral else BadgeTone.Warning)
            task.assignee?.let {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    LucideIcon(Lucide.Bot, null, size = 12.dp, tint = t.textMuted)
                    Text(it.name, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 1)
                }
            }
        }
        task.latestSummary?.takeIf { it.isNotBlank() }?.let { line ->
            InContentDirection(line) { Text(line, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@Composable
fun priorityText(priority: hub.core.client.model.TaskPriority): String = stringResource(
    when (priority) {
        hub.core.client.model.TaskPriority.LOW -> R.string.priority_low
        hub.core.client.model.TaskPriority.HIGH -> R.string.priority_high
        hub.core.client.model.TaskPriority.URGENT -> R.string.priority_urgent
        else -> R.string.priority_normal
    },
)

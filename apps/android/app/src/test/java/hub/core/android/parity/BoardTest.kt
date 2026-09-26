package hub.core.android.parity

import hub.core.android.ui.screens.BoardRules
import hub.core.android.ui.screens.BoardRules.ColumnId
import hub.core.android.ui.screens.BoardRules.Outcome
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Task
import hub.core.client.model.TaskColumns
import hub.core.client.model.TaskStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The board on the phone (B14): the web's columns and drop rules, reorder and the §93 badges. */
class BoardTest {
    private val json = Serializer.kotlinxSerializationJson

    private fun task(id: String, status: String, profile: String = "work", waiting: String = "[]", stuck: String? = null) = json.decodeFromString(
        Task.serializer(),
        """{"id":"$id","profile":"$profile","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-20T09:00:00Z",
         "updated_at":"2026-09-21T10:00:00Z","project_id":"01J8QK3ZR2W7M5N4P6T8V9X0PJ","title":"t$id","description":null,
         "status":"$status","priority":"normal","tags":[],"assignee":null,
         "auto_start":false,"position":"a0","blocked_reason":null,"status_reason":null,"subtask_counts":{"total":0,"done":0},
         "depends_on":[],"waiting_on":$waiting,"stuck_since":${stuck?.let { "\"$it\"" } ?: "null"},"worktree":null,"session_id":null,
         "last_run":{"id":null,"status":null,"finished_at":null},
         "attempt_count":0,"latest_summary":null,"due_at":null,"started_at":null,"completed_at":null,"archived_at":null,"attachment_ids":[]}""",
    )

    private fun column(id: ColumnId) = BoardRules.COLUMNS.first { it.id == id }

    @Test fun `nine statuses show as an intake and four columns, the archive behind done`() {
        assertEquals(ColumnId.INTAKE, BoardRules.columnOf(TaskStatus.TRIAGE).id)
        assertEquals(ColumnId.QUEUE, BoardRules.columnOf(TaskStatus.RUNNING).id)
        assertEquals(ColumnId.WAITING, BoardRules.columnOf(TaskStatus.BLOCKED).id)
        assertEquals(ColumnId.DONE, BoardRules.columnOf(TaskStatus.ARCHIVED).id)
        val board = json.decodeFromString(
            TaskColumns.serializer(),
            """{"columns":[{"status":"triage","count":1,"tasks":[${json.encodeToString(Task.serializer(), task("1", "triage"))}]},
                {"status":"todo","count":1,"tasks":[${json.encodeToString(Task.serializer(), task("2", "todo"))}]},
                {"status":"ready","count":1,"tasks":[${json.encodeToString(Task.serializer(), task("3", "ready"))}]},
                {"status":"archived","count":7,"tasks":[]}],
                "counts":{"total":3,"by_status":{"archived":7}}}""",
        )
        val grouped = BoardRules.group(board)
        assertEquals(listOf("1"), grouped[ColumnId.INTAKE]!!.map { it.id })
        assertEquals(listOf("2", "3"), grouped[ColumnId.QUEUE]!!.map { it.id })
        assertEquals(7, BoardRules.archived(board))
    }

    @Test fun `a drop means the move a person may make, and asks when it can mean two`() {
        val todo = task("1", "todo")
        // Into Waiting: scheduled or blocked — two meanings, so the person is asked.
        val waiting = BoardRules.outcome(todo, column(ColumnId.WAITING), emptyList(), 0)
        assertTrue(waiting is Outcome.Choose)
        val options = (waiting as Outcome.Choose).options
        assertEquals(listOf(TaskStatus.SCHEDULED, TaskStatus.BLOCKED), options.map { it.to })
        assertTrue(options.last().transition.requiresReason)
        // Into Done from todo: not a move a person makes.
        assertEquals(Outcome.Refused, BoardRules.outcome(todo, column(ColumnId.DONE), emptyList(), 0))
        // Review into Done: one move.
        val done = BoardRules.outcome(task("2", "review"), column(ColumnId.DONE), emptyList(), 0)
        assertEquals(TaskStatus.DONE, (done as Outcome.Move).drop.to)
        // Nothing is dropped into the intake.
        assertFalse(BoardRules.isDropTarget(TaskStatus.TODO, BoardRules.INTAKE))
        assertTrue(BoardRules.isDropTarget(TaskStatus.TRIAGE, column(ColumnId.QUEUE)))
    }

    @Test fun `inside its column a drop is a reorder after the card above in the same profile`() {
        val a = task("a", "todo")
        val b = task("b", "ready", profile = "home")
        val c = task("c", "todo")
        val d = task("d", "todo")
        val queue = listOf(a, b, c, d)
        // d dropped at the top: first.
        assertEquals(Outcome.Reordered(null), BoardRules.outcome(d, column(ColumnId.QUEUE), queue, 0))
        // a dropped under c: after c.
        assertEquals(Outcome.Reordered("c"), BoardRules.outcome(a, column(ColumnId.QUEUE), queue, 2))
        // d dropped just under b (another profile's card): after a, the last of its own above.
        assertEquals(Outcome.Reordered("a"), BoardRules.outcome(d, column(ColumnId.QUEUE), queue, 2))
        // c dropped where it was: nothing to do.
        assertEquals(Outcome.Unchanged, BoardRules.outcome(c, column(ColumnId.QUEUE), queue, 2))
    }

    @Test fun `waiting stays folded while empty, unless opened or the dragged card may land there`() {
        val waiting = column(ColumnId.WAITING)
        assertTrue(BoardRules.collapsed(waiting, 0, false, null))
        assertFalse(BoardRules.collapsed(waiting, 1, false, null))
        assertFalse(BoardRules.collapsed(waiting, 0, true, null))
        assertFalse(BoardRules.collapsed(waiting, 0, false, TaskStatus.TODO))
        assertTrue(BoardRules.collapsed(waiting, 0, false, TaskStatus.DONE))
        assertFalse(BoardRules.collapsed(column(ColumnId.REVIEW), 0, false, null))
    }

    @Test fun `a card says what it waits on and when its run went quiet`() {
        val waits = task("1", "ready", waiting = """[{"id":"01J8QK3ZR2W7M5N4P6T8V9X0T2","title":"اكتب الاختبارات","status":"running"}]""")
        assertEquals(listOf("اكتب الاختبارات"), BoardRules.waitingOn(waits))
        assertTrue(BoardRules.waitingOn(task("2", "ready")).isEmpty())
        assertTrue(BoardRules.stuck(task("3", "running", stuck = "2026-09-21T09:00:00Z")))
        assertFalse(BoardRules.stuck(task("4", "review", stuck = "2026-09-21T09:00:00Z")))
        assertFalse(BoardRules.showsStatusWord(TaskStatus.TODO))
        assertTrue(BoardRules.showsStatusWord(TaskStatus.RUNNING))
    }
}

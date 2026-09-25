package hub.core.android.ui

import hub.core.android.nav.Route
import hub.core.android.ui.screens.Board
import hub.core.android.ui.screens.NoticeLinks
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.ResourceRef
import hub.core.client.model.TaskColumns
import hub.core.client.model.TaskStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DestinationsTest {
    private fun task(id: String, status: String, profile: String = "work", assignee: Boolean = true) = """
        {"id":"$id","profile":"$profile","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-20T09:00:00Z",
         "updated_at":"2026-09-21T10:00:00Z","project_id":"01J8QK3ZR2W7M5N4P6T8V9X0PJ","title":"t","description":null,
         "status":"$status","priority":"high","tags":[],
         "assignee":${if (assignee) """{"kind":"agent","id":"01J8QK3ZR2W7M5N4P6T8V9X0AC","name":"Claude Code"}""" else "null"},
         "auto_start":false,"position":"a0","blocked_reason":null,"status_reason":null,"subtask_counts":{"total":0,"done":0},
         "depends_on":[],"worktree":null,"session_id":null,"last_run":{"id":null,"status":null,"finished_at":null},
         "attempt_count":0,"latest_summary":null,"due_at":null,"started_at":null,"completed_at":null,"archived_at":null,"attachment_ids":[]}
    """.trimIndent()

    private fun board(vararg columns: Pair<String, List<String>>) = Serializer.kotlinxSerializationJson.decodeFromString(
        TaskColumns.serializer(),
        """{"project_id":"01J8QK3ZR2W7M5N4P6T8V9X0PJ","columns":[${columns.joinToString(",") { (s, t) -> """{"status":"$s","count":${t.size},"tasks":[${t.joinToString(",")}]}""" }}],
            "counts":{"total":0,"by_status":{}}}""",
    )

    @Test fun `the board keeps the hub's column order and leaves archived tasks off`() {
        val b = board("todo" to listOf(task("01J8QK3ZR2W7M5N4P6T8V9X0T1", "todo")), "running" to emptyList(), "archived" to listOf(task("01J8QK3ZR2W7M5N4P6T8V9X0T2", "archived")))
        assertEquals(listOf(TaskStatus.TODO, TaskStatus.RUNNING), Board.columns(b).map { it.first })
    }

    @Test fun `moves, starts and profile badges`() {
        val todo = board("todo" to listOf(task("01J8QK3ZR2W7M5N4P6T8V9X0T1", "todo"))).columns.single().tasks.single()
        assertFalse(TaskStatus.TODO in Board.moveTargets(todo))
        assertEquals(TaskStatus.entries.size - 1, Board.moveTargets(todo).size)
        assertTrue(Board.canStart(todo))
        val running = board("running" to listOf(task("01J8QK3ZR2W7M5N4P6T8V9X0T1", "running"))).columns.single().tasks.single()
        assertFalse(Board.canStart(running))
        val unassigned = board("todo" to listOf(task("01J8QK3ZR2W7M5N4P6T8V9X0T1", "todo", assignee = false))).columns.single().tasks.single()
        assertFalse(Board.canStart(unassigned))
        assertTrue(Board.showsProfiles(board("todo" to listOf(task("01J8QK3ZR2W7M5N4P6T8V9X0T1", "todo", "a"), task("01J8QK3ZR2W7M5N4P6T8V9X0T2", "todo", "b")))))
        assertFalse(Board.showsProfiles(board("todo" to listOf(task("01J8QK3ZR2W7M5N4P6T8V9X0T1", "todo", "a")))))
    }

    @Test fun `a notice opens what it is about`() {
        assertEquals(Route.Chat("S", "work"), NoticeLinks.route(ResourceRef(ResourceRef.Kind.SESSION, "S"), "work"))
        assertEquals(Route.Tasks, NoticeLinks.route(ResourceRef(ResourceRef.Kind.TASK, "T"), "work"))
        assertEquals(Route.Schedules, NoticeLinks.route(ResourceRef(ResourceRef.Kind.SCHEDULE_RUN, "R"), null))
        assertNull(NoticeLinks.route(null, "work"))
        assertNull(NoticeLinks.route(ResourceRef(ResourceRef.Kind.SESSION, "S"), null))
    }
}

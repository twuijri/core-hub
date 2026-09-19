package us.i3u.hermesstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import us.i3u.hermesstudio.ui.workflows.WorkflowStatusTone
import us.i3u.hermesstudio.ui.workflows.workflowStatusLabel
import us.i3u.hermesstudio.ui.workflows.workflowStatusTone

/**
 * The phone lists a workflow graph the desktop draws, so the order of the
 * nodes and the status of each one are computed here rather than read off a
 * canvas. This checks that ordering, the live-over-persisted precedence, and
 * the status vocabulary the chips share.
 */
class WorkflowTimelineTest {

    private fun node(id: String, approval: Boolean = false) = WorkflowNodeSummary(
        id = id, title = id.uppercase(), agent = "hermes", agentMode = "scoped",
        provider = "", model = "sonnet", approvalRequired = approval, input = "",
    )

    private fun edge(from: String, to: String) = WorkflowEdgeSummary("$from-$to", from, to, "always")

    private fun session(nodeId: String, status: String, sequence: Int = 0, started: Long? = null, finished: Long? = null) =
        WorkflowNodeSession(
            id = "s-$nodeId-$sequence", nodeId = nodeId, executionId = "x-$nodeId", status = status,
            sessionId = "sess-$nodeId", profile = "manager", agent = "hermes", sequence = sequence,
            startedAt = started, finishedAt = finished, error = null,
        )

    private fun run(status: String, sessions: List<WorkflowNodeSession>) = WorkflowRunDetail(
        StudioWorkflowRun(id = "run-1", workflowId = "wf-1", status = status, createdAt = 1, error = null, pendingNodeId = null),
        sessions,
    )

    @Test
    fun `nodes come out in execution order, sources first`() {
        val nodes = listOf(node("c"), node("a"), node("b"))
        val edges = listOf(edge("a", "b"), edge("b", "c"))
        assertEquals(listOf("a", "b", "c"), orderWorkflowNodes(nodes, edges).map { it.id })
    }

    @Test
    fun `a cycle still lists every node exactly once`() {
        val nodes = listOf(node("a"), node("b"))
        val edges = listOf(edge("a", "b"), edge("b", "a"))
        assertEquals(listOf("a", "b"), orderWorkflowNodes(nodes, edges).map { it.id })
    }

    @Test
    fun `the timeline takes the latest session per node and its timing`() {
        val nodes = listOf(node("a"), node("b"))
        val edges = listOf(edge("a", "b"))
        val detail = run(
            "completed",
            listOf(
                session("a", "failed", sequence = 0, started = 1_000, finished = 2_000),
                session("a", "completed", sequence = 1, started = 3_000, finished = 4_500),
                session("b", "completed", sequence = 0, started = 4_500, finished = 5_000),
            ),
        )
        val timeline = workflowTimeline(nodes, edges, detail, live = null)

        assertEquals(listOf("a", "b"), timeline.map { it.node.id })
        assertEquals("completed", timeline[0].status)
        assertEquals(1_500L, timeline[0].durationMillis)
        assertEquals("sess-a", timeline[0].sessionId)
        assertEquals(500L, timeline[1].durationMillis)
    }

    @Test
    fun `a live status wins over the persisted one and marks the waiting node`() {
        val nodes = listOf(node("a", approval = true), node("b"))
        val edges = listOf(edge("a", "b"))
        val detail = run("running", listOf(session("a", "completed", started = 1, finished = 2)))
        val live = WorkflowLiveStatus(
            workflowId = "wf-1", status = "running", runId = "run-1",
            nodeStatuses = mapOf("b" to "running"), pendingApprovals = listOf("a" to "exec-9"),
            error = null, updatedAt = 0,
        )
        val timeline = workflowTimeline(nodes, edges, detail, live)

        assertTrue(timeline[0].awaitingApproval)
        assertEquals("pending_approval", timeline[0].status)
        assertEquals("exec-9", timeline[0].executionId)
        assertEquals("running", timeline[1].status)
        assertFalse(timeline[1].awaitingApproval)
    }

    @Test
    fun `a live status for another run is ignored`() {
        val nodes = listOf(node("a"))
        val detail = run("completed", listOf(session("a", "completed")))
        val live = WorkflowLiveStatus("wf-1", "running", "run-2", mapOf("a" to "running"), emptyList(), null, 0)
        assertEquals("completed", workflowTimeline(nodes, emptyList(), detail, live).single().status)
    }

    @Test
    fun `nodes of a queued run that has not reached them read as queued`() {
        val nodes = listOf(node("a"), node("b"))
        val detail = run("running", listOf(session("a", "running", started = 1)))
        val timeline = workflowTimeline(nodes, listOf(edge("a", "b")), detail, live = null)
        assertEquals("running", timeline[0].status)
        assertEquals("queued", timeline[1].status)
    }

    @Test
    fun `with no run at all every node is idle`() {
        assertEquals(listOf("idle"), workflowTimeline(listOf(node("a")), emptyList(), null, null).map { it.status })
    }

    @Test
    fun `the list chip prefers a live status and falls back to the newest run`() {
        val runs = listOf(StudioWorkflowRun("run-1", "wf-1", "failed", 1, null, null))
        assertEquals("failed", workflowChipStatus(null, runs))
        assertEquals("failed", workflowChipStatus(WorkflowLiveStatus("wf-1", "idle", null, emptyMap(), emptyList(), null, 0), runs))
        assertEquals("running", workflowChipStatus(WorkflowLiveStatus("wf-1", "running", "run-2", emptyMap(), emptyList(), null, 0), runs))
        assertEquals("idle", workflowChipStatus(null, emptyList()))
    }

    @Test
    fun `the socket snapshot reads node statuses and pending approvals`() {
        val payload = JSONObject(
            """
            {
              "workflowId": "wf-1",
              "status": "running",
              "runId": "run-1",
              "nodeStatuses": {"a": "completed", "b": "pending_approval"},
              "pendingApprovals": [{"nodeId": "b", "executionId": "exec-2"}],
              "updatedAt": 99
            }
            """.trimIndent(),
        )
        val status = requireNotNull(WorkflowJson.status(payload))
        assertEquals("run-1", status.runId)
        assertEquals(mapOf("a" to "completed", "b" to "pending_approval"), status.nodeStatuses)
        assertEquals(listOf("b" to "exec-2"), status.pendingApprovals)
        assertNull(status.error)
    }

    @Test
    fun `a run payload finds the node that blocks it`() {
        val payload = JSONObject(
            """{"id":"run-1","workflow_id":"wf-1","status":"running","node_sessions":[{"node_id":"a","status":"completed","sequence":0},{"node_id":"b","status":"blocked","sequence":1}]}""",
        )
        val detail = WorkflowJson.runDetail(payload)
        assertEquals("b", detail.run.pendingNodeId)
        assertEquals(listOf("a", "b"), detail.nodeSessions.map { it.nodeId })
        assertTrue(detail.run.active)
    }

    @Test
    fun `every status the server sends has a tone and a translated word`() {
        assertEquals(WorkflowStatusTone.Busy, workflowStatusTone("running"))
        assertEquals(WorkflowStatusTone.Good, workflowStatusTone("completed"))
        assertEquals(WorkflowStatusTone.Bad, workflowStatusTone("failed"))
        assertEquals(WorkflowStatusTone.Bad, workflowStatusTone("canceled"))
        assertEquals(WorkflowStatusTone.Waiting, workflowStatusTone("pending_approval"))
        assertEquals(WorkflowStatusTone.Idle, workflowStatusTone("something-new"))

        listOf("idle", "queued", "running", "completed", "failed", "canceled", "blocked", "skipped")
            .forEach { status -> assertTrue("$status has no label", workflowStatusLabel(status) != null) }
        assertNull("an unknown status keeps the server's own word", workflowStatusLabel("something-new"))
    }
}

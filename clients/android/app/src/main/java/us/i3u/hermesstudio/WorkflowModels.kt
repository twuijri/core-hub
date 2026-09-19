package us.i3u.hermesstudio

import org.json.JSONArray
import org.json.JSONObject

/**
 * Workflow records as the web's `api/studio/workflows.ts` types them, plus
 * the pure functions the run screen's node timeline is built from.
 */

/** One agent node of the graph (read-only on the phone). */
data class WorkflowNodeSummary(
    val id: String,
    val title: String,
    val agent: String,
    val agentMode: String,
    val provider: String,
    val model: String,
    val approvalRequired: Boolean,
    val input: String,
)

data class WorkflowEdgeSummary(val id: String, val source: String, val target: String, val route: String)

/** `WorkflowRunNodeSessionRecord`. */
data class WorkflowNodeSession(
    val id: String,
    val nodeId: String,
    val executionId: String,
    val status: String,
    val sessionId: String,
    val profile: String,
    val agent: String,
    val sequence: Int,
    val startedAt: Long?,
    val finishedAt: Long?,
    val error: String?,
)

/** A full run with its evidence (`GET /workflows/{id}/runs/{runId}`). */
data class WorkflowRunDetail(val run: StudioWorkflowRun, val nodeSessions: List<WorkflowNodeSession>)

/** `WorkflowRuntimeStatus` from the `/workflow` socket. */
data class WorkflowLiveStatus(
    val workflowId: String,
    val status: String,
    val runId: String?,
    val nodeStatuses: Map<String, String>,
    /** nodeId → executionId of the approvals waiting on a person. */
    val pendingApprovals: List<Pair<String, String>>,
    val error: String?,
    val updatedAt: Long,
    val run: WorkflowRunDetail? = null,
)

/** One row of the run screen's node timeline. */
data class WorkflowTimelineEntry(
    val node: WorkflowNodeSummary,
    val status: String,
    val executionId: String?,
    val sessionId: String?,
    val startedAt: Long?,
    val finishedAt: Long?,
    val error: String?,
    val awaitingApproval: Boolean,
) {
    val durationMillis: Long? get() = if (startedAt != null && finishedAt != null && finishedAt >= startedAt) finishedAt - startedAt else null
}

object WorkflowJson {
    fun node(item: JSONObject): WorkflowNodeSummary? {
        val id = item.optString("id").takeIf { it.isNotBlank() } ?: return null
        val data = item.optJSONObject("data") ?: JSONObject()
        return WorkflowNodeSummary(
            id = id,
            title = data.optString("title").ifBlank { data.optString("label") }.ifBlank { id },
            agent = data.optString("agent").ifBlank { "hermes" },
            agentMode = data.optString("agentMode").ifBlank { "scoped" },
            provider = data.optString("provider"),
            model = data.optString("model"),
            approvalRequired = data.optBoolean("approvalRequired", false),
            input = data.optString("input"),
        )
    }

    fun nodes(array: JSONArray?): List<WorkflowNodeSummary> = objects(array).mapNotNull(::node)

    fun edge(item: JSONObject): WorkflowEdgeSummary? {
        val source = item.optString("source").takeIf { it.isNotBlank() } ?: return null
        val target = item.optString("target").takeIf { it.isNotBlank() } ?: return null
        val data = item.optJSONObject("data")
        val route = data?.optString("route")?.takeIf { it.isNotBlank() }
            ?: item.optString("sourceHandle").takeIf { it == "success" || it == "failure" }
            ?: "always"
        return WorkflowEdgeSummary(item.optString("id").ifBlank { "$source-$target" }, source, target, route)
    }

    fun edges(array: JSONArray?): List<WorkflowEdgeSummary> = objects(array).mapNotNull(::edge)

    fun nodeSession(item: JSONObject): WorkflowNodeSession? {
        val nodeId = item.optString("node_id").takeIf { it.isNotBlank() } ?: return null
        return WorkflowNodeSession(
            id = item.optString("id"),
            nodeId = nodeId,
            executionId = item.optString("execution_id"),
            status = item.optString("status").ifBlank { "queued" },
            sessionId = item.optString("session_id"),
            profile = item.optString("profile"),
            agent = item.optString("agent"),
            sequence = item.optInt("sequence", 0),
            startedAt = item.optLong("started_at", 0L).takeIf { it > 0 },
            finishedAt = item.optLong("finished_at", 0L).takeIf { it > 0 },
            error = item.optString("error").takeIf { it.isNotBlank() && it != "null" },
        )
    }

    fun run(item: JSONObject): StudioWorkflowRun {
        val sessions = objects(item.optJSONArray("node_sessions")).mapNotNull(::nodeSession)
        val pending = sessions.firstOrNull { it.status == "blocked" }?.nodeId
        return StudioWorkflowRun(
            id = item.optString("id"),
            workflowId = item.optString("workflow_id"),
            status = item.optString("status").ifBlank { "queued" },
            createdAt = item.optLong("created_at", 0L),
            error = item.optString("error").takeIf { it.isNotBlank() && it != "null" },
            pendingNodeId = pending,
            startedAt = item.optLong("started_at", 0L).takeIf { it > 0 },
            finishedAt = item.optLong("finished_at", 0L).takeIf { it > 0 },
            triggerSource = item.optString("trigger_source").ifBlank { "manual" },
            profile = item.optString("profile"),
        )
    }

    fun runDetail(item: JSONObject): WorkflowRunDetail =
        WorkflowRunDetail(run(item), objects(item.optJSONArray("node_sessions")).mapNotNull(::nodeSession).sortedBy { it.sequence })

    fun status(item: JSONObject): WorkflowLiveStatus? {
        val workflowId = item.optString("workflowId").takeIf { it.isNotBlank() } ?: return null
        val nodeStatuses = item.optJSONObject("nodeStatuses")?.let { map -> map.keys().asSequence().associateWith { key -> map.optString(key) } }.orEmpty()
        val approvals = objects(item.optJSONArray("pendingApprovals")).mapNotNull { entry ->
            val nodeId = entry.optString("nodeId").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            nodeId to entry.optString("executionId")
        }
        return WorkflowLiveStatus(
            workflowId = workflowId,
            status = item.optString("status").ifBlank { "idle" },
            runId = item.optString("runId").takeIf { it.isNotBlank() && it != "null" },
            nodeStatuses = nodeStatuses,
            pendingApprovals = approvals,
            error = item.optString("error").takeIf { it.isNotBlank() && it != "null" },
            updatedAt = item.optLong("updatedAt", 0L),
            run = item.optJSONObject("run")?.let(::runDetail),
        )
    }

    private fun objects(array: JSONArray?): List<JSONObject> = array?.let { (0 until it.length()).mapNotNull { i -> it.optJSONObject(i) } }.orEmpty()
}

/**
 * Nodes in execution order: sources first, then whatever their edges reach,
 * cycles broken by the original order (the web draws the graph; the phone
 * lists it).
 */
fun orderWorkflowNodes(nodes: List<WorkflowNodeSummary>, edges: List<WorkflowEdgeSummary>): List<WorkflowNodeSummary> {
    val byId = nodes.associateBy { it.id }
    val incoming = nodes.associate { it.id to edges.count { e -> e.target == it.id && e.source in byId } }.toMutableMap()
    val ordered = mutableListOf<WorkflowNodeSummary>()
    val ready = ArrayDeque(nodes.filter { incoming[it.id] == 0 })
    val seen = HashSet<String>()
    while (ready.isNotEmpty() || seen.size < nodes.size) {
        if (ready.isEmpty()) {
            // Cycle: pick the first unseen node in declaration order.
            nodes.firstOrNull { it.id !in seen }?.let(ready::addLast) ?: break
        }
        val node = ready.removeFirst()
        if (!seen.add(node.id)) continue
        ordered += node
        edges.filter { it.source == node.id }.forEach { edge ->
            val target = byId[edge.target] ?: return@forEach
            incoming[target.id] = (incoming[target.id] ?: 1) - 1
            if (incoming[target.id] == 0 && target.id !in seen) ready.addLast(target)
        }
    }
    return ordered
}

/**
 * The timeline for one run: the persisted node session (latest per node)
 * gives status and timing; the live socket status overrides the state and
 * marks nodes that wait for an approval.
 */
fun workflowTimeline(
    nodes: List<WorkflowNodeSummary>,
    edges: List<WorkflowEdgeSummary>,
    run: WorkflowRunDetail?,
    live: WorkflowLiveStatus?,
): List<WorkflowTimelineEntry> {
    val liveForRun = live?.takeIf { run == null || it.runId == null || it.runId == run.run.id }
    val latest = run?.nodeSessions.orEmpty().groupBy { it.nodeId }.mapValues { (_, sessions) -> sessions.maxByOrNull { it.sequence } }
    val pending = liveForRun?.pendingApprovals.orEmpty().toMap()
    return orderWorkflowNodes(nodes, edges).map { node ->
        val session = latest[node.id]
        val persisted = session?.status
        val liveStatus = liveForRun?.nodeStatuses?.get(node.id)
        val awaiting = node.id in pending || persisted == "blocked" || liveStatus == "pending_approval"
        val status = when {
            awaiting -> "pending_approval"
            liveStatus != null && liveStatus != "idle" -> liveStatus
            persisted != null -> persisted
            run == null -> "idle"
            run.run.status == "running" || run.run.status == "queued" -> "queued"
            else -> "skipped"
        }
        WorkflowTimelineEntry(
            node = node,
            status = status,
            executionId = pending[node.id] ?: session?.executionId,
            sessionId = session?.sessionId?.takeIf { it.isNotBlank() },
            startedAt = session?.startedAt,
            finishedAt = session?.finishedAt,
            error = session?.error,
            awaitingApproval = awaiting,
        )
    }
}

/** The status chip of the list: the live status wins over the last run. */
fun workflowChipStatus(live: WorkflowLiveStatus?, runs: List<StudioWorkflowRun>): String =
    live?.status?.takeIf { it != "idle" } ?: runs.firstOrNull()?.status ?: "idle"

package hub.core.android.parity

import hub.core.android.data.HubApis
import hub.core.android.realtime.Envelope
import hub.core.android.ui.screens.Workflows
import hub.core.android.ui.screens.WorkflowsModel
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Workflow
import hub.core.client.model.WorkflowRun
import hub.core.client.model.WorkflowStepStatus
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Workflows on the phone (B12): the run view's rules and the model against a scripted hub. */
class WorkflowsTest {
    private val json = Serializer.kotlinxSerializationJson
    private val wf = "01J8QK3ZR2W7M5N4P6T8V9X0WF"
    private val run = "01J8QK3ZR2W7M5N4P6T8V9X0WR"
    private val approval = "01J8QK3ZR2W7M5N4P6T8V9X0AP"

    private fun node(id: String, title: String, kind: String = "agent", gate: Boolean = false) = """
        {"id":"$id","kind":"$kind","title":"$title","agent_id":null,"model":null,"provider":null,"reasoning_effort":null,
         "skills":[],"input":null,"approval_required":$gate,"position":{"x":0,"y":0}}
    """.trimIndent()

    private fun workflowJson(profile: String = "work", status: String = "idle") = """
        {"id":"$wf","profile":"$profile","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-18T00:00:00Z",
         "updated_at":"2026-09-21T09:00:00Z","name":"مراجعة ثم نشر","description":null,"working_dir":null,
         "nodes":[${node("review", "مراجعة")},${node("publish", "نشر", gate = true)},${node("tell", "إشعار", "notify")}],
         "edges":[],"status":"$status","active_run_id":null,"run_count":4,"schedule_count":1,
         "limits":{"max_duration_seconds":1800,"max_cost":{"amount":"2.00","currency":"USD"},"step_timeout_seconds":null}}
    """.trimIndent()

    private fun step(node: String, status: String, approvalId: String? = null) = """
        {"node_id":"$node","attempt":1,"status":"$status","session_id":null,"run_id":null,
         "approval_id":${approvalId?.let { "\"$it\"" } ?: "null"},"output":null,"route":null,"error":null,
         "started_at":"2026-09-21T10:00:00Z","finished_at":null}
    """.trimIndent()

    private fun runJson(status: String, vararg steps: String) = """
        {"id":"$run","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-21T10:00:00Z",
         "updated_at":"2026-09-21T10:00:00Z","workflow_id":"$wf","job_id":"01J8QK3ZR2W7M5N4P6T8V9X0JY","status":"$status",
         "trigger":{"kind":"user","id":null},"input":null,"steps":[${steps.joinToString(",")}],"error":null,
         "started_at":"2026-09-21T10:00:00Z","finished_at":null,
         "limits":{"max_duration_seconds":null,"max_cost":null,"step_timeout_seconds":null},"cost":null,"stopped_by":null}
    """.trimIndent()

    private fun approvalJson() = """
        {"id":"$approval","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-21T10:00:00Z",
         "updated_at":"2026-09-21T10:00:00Z","kind":"workflow_step","status":"denied","session_id":null,"run_id":null,
         "message_id":null,"room_id":null,"workflow_run_id":"$run","node_id":"publish",
         "agent":{"id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","name":"Hermes"},"title":"نشر","description":null,"command":null,
         "choices":[],"allow_always":false,"answer_mode":"choice","response":null,"expires_at":null}
    """.trimIndent()

    private fun workflow() = json.decodeFromString(Workflow.serializer(), workflowJson())
    private fun workflowRun(status: String, vararg steps: String) = json.decodeFromString(WorkflowRun.serializer(), runJson(status, *steps))

    @Test fun `a live run lists what ran, then the nodes not reached yet as pending`() {
        val live = workflowRun("waiting", step("review", "succeeded"), step("publish", "waiting_approval", approval))
        val rows = Workflows.rows(workflow(), live)
        assertEquals(listOf("review", "publish", "tell"), rows.map { it.nodeId })
        assertEquals(listOf("مراجعة", "نشر", "إشعار"), rows.map { it.title })
        assertEquals(WorkflowStepStatus.PENDING, rows.last().status)
        assertNull(rows.last().step)
    }

    @Test fun `a finished run shows only what ran`() {
        val done = workflowRun("failed", step("review", "failed"))
        assertEquals(listOf("review"), Workflows.rows(workflow(), done).map { it.nodeId })
        assertTrue(Workflows.finished(done))
        assertFalse(Workflows.finished(workflowRun("running")))
    }

    @Test fun `the waiting step is the one with an approval to answer`() {
        assertEquals("publish", Workflows.waiting(workflowRun("waiting", step("review", "succeeded"), step("publish", "waiting_approval", approval)))?.nodeId)
        assertNull(Workflows.waiting(workflowRun("waiting", step("publish", "waiting_approval"))))
    }

    @Test fun `typed limits become the run's own, within the hub's bounds`() {
        assertEquals(null to null, Workflows.limits(Workflows.LimitsInput()))
        val (ok, none) = Workflows.limits(Workflows.LimitsInput(minutes = "30", cost = "1,5", stepMinutes = "10"))
        assertNull(none)
        assertEquals(1800, ok!!.maxDurationSeconds)
        assertEquals("1.50", ok.maxCost!!.amount)
        assertEquals("USD", ok.maxCost!!.currency)
        assertEquals(600, ok.stepTimeoutSeconds)
        assertEquals(Workflows.LimitProblem.DURATION, Workflows.limits(Workflows.LimitsInput(minutes = "20000")).second)
        assertEquals(Workflows.LimitProblem.STEP, Workflows.limits(Workflows.LimitsInput(stepMinutes = "0")).second)
        assertEquals(Workflows.LimitProblem.COST, Workflows.limits(Workflows.LimitsInput(cost = "-1")).second)
        assertEquals(Workflows.LimitProblem.COST, Workflows.limits(Workflows.LimitsInput(cost = "0.001")).second)
        assertEquals(30, Workflows.minutes(1800))
        assertEquals(1, Workflows.minutes(1))
    }

    @Test fun `workflow and step events refresh the page, others do not`() {
        fun env(ns: String, event: String) = Envelope(event, ns, "work", 1, "2026-09-21T10:00:00Z", JsonObject(emptyMap()))
        assertTrue(Workflows.touches(env("/rt/schedules", "step.completed")))
        assertTrue(Workflows.touches(env("/rt/schedules", "workflow_run.completed")))
        assertTrue(Workflows.touches(env("/rt/sessions", "approval.resolved")))
        assertFalse(Workflows.touches(env("/rt/schedules", "schedule.updated")))
    }

    // ------------------------------------------------------------------ the model, against a scripted hub

    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()
    private var runState = "running"

    private fun ok(body: String, status: Int = 200) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.requestUrl!!.encodedPath
                return when {
                    path.endsWith("/workflows") -> ok("""{"items":[${workflowJson()}],"next_cursor":null}""")
                    path.endsWith("/workflows/$wf/runs") -> ok("""{"items":[${runJson("succeeded", step("review", "succeeded"))}],"next_cursor":null}""")
                    path.endsWith("/workflows/$wf/run") -> ok("""{"job_id":"01J8QK3ZR2W7M5N4P6T8V9X0JY","workflow_run_id":"$run"}""", 202)
                    path.endsWith("/workflow-runs/$run/cancel") -> ok(runJson("cancelled"))
                    path.endsWith("/workflow-runs/$run") -> ok(
                        if (runState == "waiting") runJson("waiting", step("review", "succeeded"), step("publish", "waiting_approval", approval))
                        else runJson(runState, step("review", "succeeded"), step("publish", "running")),
                    )
                    path.endsWith("/approvals/$approval/respond") -> { runState = "running"; ok(approvalJson()) }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun model() = WorkflowsModel({ HubApis(server.url("/").toString().trimEnd('/'), OkHttpClient()) }, { "home" })

    @Test fun `the list asks for every profile, and a run starts in the workflow's own profile with its limits`() = runTest {
        val m = model()
        m.load()
        assertEquals(1, m.ui.value.items.size)
        val list = requests.first()
        assertEquals("all", list.requestUrl!!.queryParameter("profiles"))
        assertEquals("home", list.getHeader("X-Hub-Profile"))

        m.open(m.ui.value.items.first())
        assertEquals(1, m.ui.value.runs?.size)

        val limits = Workflows.limits(Workflows.LimitsInput(minutes = "5")).first
        assertTrue(m.run(m.ui.value.opened!!, "  الفرع  ", limits))
        val start = requests.first { it.requestUrl!!.encodedPath.endsWith("/run") }
        assertEquals("work", start.getHeader("X-Hub-Profile"))
        assertNotNull(start.getHeader("Idempotency-Key"))
        val body = start.body.readUtf8()
        assertTrue(body, body.contains("\"input\":\"الفرع\"") && body.contains("\"max_duration_seconds\":300"))
        assertFalse(body, body.contains("max_cost"))
        assertEquals(run, m.ui.value.run?.id)
    }

    @Test fun `a waiting step is approved or denied through the approval, then the run is read again`() = runTest {
        val m = model()
        runState = "waiting"
        m.openRun("work", run)
        assertNotNull(Workflows.waiting(m.ui.value.run!!))
        m.respond(approve = false, reason = " not now ")
        val answer = requests.first { it.requestUrl!!.encodedPath.endsWith("/respond") }
        assertEquals("work", answer.getHeader("X-Hub-Profile"))
        val body = answer.body.readUtf8()
        assertTrue(body, body.contains("\"decision\":\"deny\"") && body.contains("\"answer\":\"not now\""))
        assertEquals(WorkflowRun.Status.RUNNING, m.ui.value.run?.status)
        assertNull(Workflows.waiting(m.ui.value.run!!))

        m.cancel()
        assertEquals(WorkflowRun.Status.CANCELLED, m.ui.value.run?.status)
        assertTrue(Workflows.finished(m.ui.value.run!!))
    }
}

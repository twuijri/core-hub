package hub.core.android.parity

import hub.core.android.data.HubApis
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.screens.WorkflowDraft
import hub.core.android.ui.screens.WorkflowDraftRules
import hub.core.android.ui.screens.WorkflowFlowOps
import hub.core.android.ui.screens.WorkflowFlowRules
import hub.core.android.ui.screens.WorkflowTriggersModel
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Session
import hub.core.client.model.Workflow
import hub.core.client.model.WorkflowNode
import hub.core.client.model.WorkflowRules
import hub.core.client.model.WorkflowRun
import hub.core.client.model.WorkflowSend
import hub.core.client.model.WorkflowSendTarget
import hub.core.client.model.WorkflowTriggerDelivery
import hub.core.client.model.WorkflowTriggerDeliveryStatus
import hub.core.client.model.WorkflowTriggerPreset
import hub.core.client.model.WorkflowWrite
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Workflow editing on the phone as the web does it (DECISIONS §128): several rules, "Send
 * message", the failure alert, "Test this step", the triggers and "Find a run" — the rules pure,
 * the calls against a scripted hub (and an older one that answers 404).
 */
class WorkflowFlowTest {
    private val json = Serializer.kotlinxSerializationJson
    private val wf = "01J8QK3ZR2W7M5N4P6T8V9X0WF"
    private val trig = "01J8QK3ZR2W7M5N4P6T8V9X0TG"
    private val at = "2026-09-28T10:00:00Z"

    /** The request body as the generated client sends it (explicit nulls included). */
    private fun encodedWrite(write: WorkflowWrite) = json.parseToJsonElement(
        hub.core.client.infrastructure.ExplicitNulls.encodeToString(json, write),
    ).jsonObject

    // ------------------------------------------------------------------ several rules

    @Test fun `several rules start from the single line and switching them off sends an explicit null`() {
        var d = WorkflowDraftRules.add(WorkflowDraft(name = "F"), WorkflowNode.Kind.CONDITION, "Only new")
        d = WorkflowDraftRules.update(d, "condition_1") { it.copy(input = "trigger.event == \"taskCreated\"") }
        d = WorkflowDraftRules.update(d, "condition_1") { WorkflowFlowRules.withRules(it, true) }
        val on = d.nodes.single().rules!!
        assertEquals(WorkflowRules.Match.ALL, on.match)
        assertEquals("trigger.event", on.items.single().path)
        assertEquals("==", on.items.single().operator)
        assertEquals("taskCreated", on.items.single().value)
        val sentOn = encodedWrite(WorkflowDraftRules.toWrite(d, editing = true))["nodes"]!!.jsonArray[0].jsonObject
        assertEquals("all", sentOn["rules"]!!.jsonObject["match"]!!.jsonPrimitive.content)

        d = WorkflowDraftRules.update(d, "condition_1") { WorkflowFlowRules.withRules(it, false) }
        assertNull(d.nodes.single().rules)
        val sentOff = encodedWrite(WorkflowDraftRules.toWrite(d, editing = true))["nodes"]!!.jsonArray[0].jsonObject
        assertEquals("the hub drops them only on an explicit null", JsonNull, sentOff["rules"])

        // A condition never touched leaves the field out, so the hub keeps what it has.
        val untouched = WorkflowDraftRules.add(WorkflowDraft(name = "G"), WorkflowNode.Kind.CONDITION, "c")
        assertFalse("rules" in encodedWrite(WorkflowDraftRules.toWrite(untouched))["nodes"]!!.jsonArray[0].jsonObject)
        // With no single comparison to start from, the first rule reads the trigger's event.
        assertEquals("trigger.event", WorkflowFlowRules.firstRule("").path)
        assertEquals(null, WorkflowFlowRules.firstRule("input exists").value)
    }

    @Test fun `a rule's value goes with exists and empty, comes back as empty text, and the last rule stays`() {
        var rules = WorkflowRules(WorkflowRules.Match.ANY, listOf(WorkflowFlowRules.firstRule("")))
        rules = WorkflowFlowRules.setRule(rules, 0) { it.copy(operator = "exists") }
        assertNull(rules.items[0].value)
        rules = WorkflowFlowRules.setRule(rules, 0) { it.copy(operator = "contains") }
        assertEquals("", rules.items[0].value)
        assertEquals(rules, WorkflowFlowRules.removeRule(rules, 0))
        rules = WorkflowFlowRules.addRule(rules)
        assertEquals(listOf("trigger.event", "trigger.event"), rules.items.map { it.path })
        assertEquals(1, WorkflowFlowRules.removeRule(rules, 1).items.size)
        assertEquals(WorkflowRules.Match.ANY, rules.match)
    }

    @Test fun `rules round-trip exactly, an operator this app does not know included`() {
        val raw = """{"match":"any","items":[{"path":"trigger.body.x","operator":"starts_with","value":"A"},{"path":"input","operator":"empty","value":null}]}"""
        val rules = json.decodeFromString(WorkflowRules.serializer(), raw)
        var d = WorkflowDraftRules.add(WorkflowDraft(name = "R"), WorkflowNode.Kind.CONDITION, "c")
        d = WorkflowDraftRules.update(d, "condition_1") { it.copy(rules = rules) }
        val sent = encodedWrite(WorkflowDraftRules.toWrite(d))["nodes"]!!.jsonArray[0].jsonObject["rules"]!!
        assertEquals(json.parseToJsonElement(raw), sent)
    }

    @Test fun `a rule's path suggestions are the trigger's, the input and the steps before it`() {
        var d = WorkflowDraftRules.add(WorkflowDraft(name = "S"), WorkflowNode.Kind.AGENT, "Read", agentId = "A")
        d = WorkflowDraftRules.add(d, WorkflowNode.Kind.CONDITION, "Check")
        d = WorkflowDraftRules.connect(d, "agent_1", "condition_1", hub.core.client.model.WorkflowEdge.Route.SUCCESS)
        assertEquals(WorkflowFlowRules.TRIGGER_PATHS + "input" + "steps.agent_1.output", WorkflowFlowRules.suggestions(d, "condition_1"))
    }

    // ------------------------------------------------------------------ Send message and the failure alert

    @Test fun `the palette's Send message is a notify step with no targets, and a target of another platform is kept`() {
        val d = WorkflowFlowRules.addSendStep(WorkflowDraft(name = "M"), "Send message")
        val node = d.nodes.single()
        assertEquals(WorkflowNode.Kind.NOTIFY, node.kind)
        assertEquals("Send message", node.title)
        assertEquals(WorkflowSend(emptyList()), node.send)
        val sent = encodedWrite(WorkflowDraftRules.toWrite(d))["nodes"]!!.jsonArray[0].jsonObject["send"]!!.jsonObject
        assertEquals(JsonArray(emptyList()), sent["targets"])

        val slack = WorkflowSendTarget(platform = "slack", chatId = "C1")
        var send = WorkflowSend(listOf(slack))
        send = WorkflowFlowRules.setTarget(send, "telegram", WorkflowFlowRules.telegram(" -1001 "))
        send = WorkflowFlowRules.setTarget(send, "core_hub", WorkflowFlowRules.conversation(session()))
        assertEquals(listOf("slack", "telegram", "core_hub"), send.targets.map { it.platform })
        assertEquals("-1001", WorkflowFlowRules.target(send, "telegram")!!.chatId)
        val conversation = WorkflowFlowRules.target(send, "core_hub")!!
        assertEquals(listOf("01J8QK3ZR2W7M5N4P6T8V9X0SS", "Reports", "01J8QK3ZR2W7M5N4P6T8V9X0AG"), listOf(conversation.sessionId, conversation.title, conversation.agentId))
        send = WorkflowFlowRules.setTarget(send, "telegram", null)
        assertEquals(listOf(slack, conversation), send.targets)

        assertFalse(WorkflowFlowRules.canTestSend(WorkflowSend(emptyList()), "hello"))
        assertFalse(WorkflowFlowRules.canTestSend(send, "  "))
        assertTrue(WorkflowFlowRules.canTestSend(send, "hello"))

        // Words with variables: named once each as the hub names them, no test until each has a
        // value, and the test carries the words filled in — never `{{steps.analysis.output}}`.
        val words = "Result: {{steps.analysis.output}} for {{ input }} ({{steps.analysis.output}})"
        assertEquals(listOf("steps.analysis.output", "input"), WorkflowFlowRules.variablesIn(words))
        assertFalse(WorkflowFlowRules.canTestSend(send, words))
        val some = mapOf("steps.analysis.output" to "done", "input" to "")
        assertEquals(listOf("input"), WorkflowFlowRules.missingIn(words, some))
        assertEquals("Result: done for {{ input }} (done)", WorkflowFlowRules.fill(words, some))
        assertFalse(WorkflowFlowRules.canTestSend(send, words, some))
        val all = some + ("input" to "release 2")
        assertTrue(WorkflowFlowRules.canTestSend(send, words, all))
        assertEquals("Result: done for release 2 (done)", WorkflowFlowRules.sendTest(send, words, all).text)
    }

    @Test fun `Telegram formatting is read, chosen, kept when the chat id changes, and survives a load and save`() {
        // A step saved before §137: no field, read as plain, and saved without one.
        val old = WorkflowSend(listOf(WorkflowFlowRules.telegram("-1001")))
        assertEquals("plain", WorkflowFlowRules.formattingOf(WorkflowFlowRules.target(old, "telegram")))
        assertEquals(null, WorkflowFlowRules.target(old, "telegram")!!.formatting)

        var send = WorkflowFlowRules.withFormatting(old, "html")
        assertEquals("html", WorkflowFlowRules.target(send, "telegram")!!.formatting)
        // Editing the chat id keeps the formatting.
        val html = WorkflowFlowRules.target(send, "telegram")!!
        send = WorkflowFlowRules.setTarget(send, "telegram", WorkflowFlowRules.telegram(" -1002 ", html.formatting))
        assertEquals(listOf("-1002", "html"), WorkflowFlowRules.target(send, "telegram")!!.let { listOf(it.chatId, it.formatting) })
        // Only the three values; anything else is plain here and refused by the hub.
        assertEquals("plain", WorkflowFlowRules.formattingOf(WorkflowSendTarget(platform = "telegram", formatting = "Markdown")))
        assertEquals("markdown_v2", WorkflowFlowRules.target(WorkflowFlowRules.withFormatting(send, "markdown_v2"), "telegram")!!.formatting)
        assertEquals("plain", WorkflowFlowRules.target(WorkflowFlowRules.withFormatting(send, "bogus"), "telegram")!!.formatting)
        // No Telegram target: nothing to change.
        val none = WorkflowSend(listOf(WorkflowFlowRules.conversation(null)))
        assertEquals(none, WorkflowFlowRules.withFormatting(none, "html"))

        // A workflow from the hub keeps the field through this app's load and save.
        val loaded = Serializer.kotlinxSerializationJson.decodeFromString(
            WorkflowSendTarget.serializer(),
            """{"platform":"telegram","chat_id":"-1001","formatting":"html"}""",
        )
        assertEquals("html", loaded.formatting)
        val written = Serializer.kotlinxSerializationJson.encodeToString(WorkflowSendTarget.serializer(), loaded)
        assertTrue(written.contains("\"formatting\":\"html\""))
        // Absent stays absent (the hub keeps what was saved).
        val bare = Serializer.kotlinxSerializationJson.encodeToString(WorkflowSendTarget.serializer(), WorkflowFlowRules.telegram("-1"))
        assertFalse(bare.contains("formatting"))
    }

    @Test fun `the failure alert is written only once changed, null when emptied, and left out otherwise`() {
        val saved = workflow(onFailure = """{"inbox":true,"send":null}""")
        val loaded = WorkflowDraftRules.from(saved)
        assertFalse("untouched: left out", "on_failure" in encodedWrite(WorkflowDraftRules.toWrite(loaded, editing = true)))

        val emptied = WorkflowDraftRules.withAlert(loaded, WorkflowFlowRules.alert(inbox = false, send = null))
        assertEquals(JsonNull, encodedWrite(WorkflowDraftRules.toWrite(emptied, editing = true))["on_failure"])

        val telegram = WorkflowSend(listOf(WorkflowFlowRules.telegram("-1001")))
        val withTargets = WorkflowDraftRules.withAlert(loaded, WorkflowFlowRules.alert(inbox = false, send = telegram))
        val sent = encodedWrite(WorkflowDraftRules.toWrite(withTargets, editing = true))["on_failure"]!!.jsonObject
        assertEquals("false", sent["inbox"]!!.jsonPrimitive.content)
        assertEquals("-1001", sent["send"]!!.jsonObject["targets"]!!.jsonArray[0].jsonObject["chat_id"]!!.jsonPrimitive.content)

        val inboxOnly = encodedWrite(WorkflowDraftRules.toWrite(WorkflowDraftRules.withAlert(loaded, WorkflowFlowRules.alert(true, WorkflowSend(emptyList()))), editing = true))
        assertEquals("true", inboxOnly["on_failure"]!!.jsonObject["inbox"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, inboxOnly["on_failure"]!!.jsonObject["send"])
        // A duplicate carries the alert to the new workflow.
        assertEquals(saved.onFailure, WorkflowDraftRules.toWrite(WorkflowDraftRules.copyOf(saved, "copy")).onFailure)
    }

    // ------------------------------------------------------------------ test this step

    @Test fun `Try it sends the node as written with the sample, and refuses a sample that is not JSON`() {
        var d = WorkflowDraftRules.add(WorkflowDraft(name = "T"), WorkflowNode.Kind.AGENT, "Research", agentId = "A")
        d = WorkflowDraftRules.update(d, "agent_1") { it.copy(input = "Look at {{trigger.task_id}}") }
        val node = d.nodes.single()
        assertNull(WorkflowFlowRules.stepTest(node, "", "{ not json", execute = false))
        val body = WorkflowFlowRules.stepTest(node, "  hello ", WorkflowFlowRules.SAMPLE_TRIGGER, execute = true)!!
        assertEquals("hello", body.input)
        assertEquals(true, body.execute)
        assertEquals("taskStatusUpdated", body.trigger!!.jsonObject["event"]!!.jsonPrimitive.content)
        assertEquals("sample-task", body.trigger!!.jsonObject["task_id"]!!.jsonPrimitive.content)
        assertEquals(node.id, body.node.id)
        val notify = WorkflowFlowRules.addSendStep(WorkflowDraft(), "Send").nodes.single()
        val plain = WorkflowFlowRules.stepTest(notify, "", "", execute = true)!!
        assertNull("an empty sample is no event", plain.trigger)
        assertNull(plain.input)
        assertEquals("only an agent step runs for real", false, plain.execute)
    }

    // ------------------------------------------------------------------ runs and deliveries

    @Test fun `Find a run matches task and event ids, any case`() {
        val runs = listOf(run("R1", task = "86abc", event = null), run("R2", task = null, event = "EVT-9"), run("R3", task = null, event = null))
        assertEquals(listOf("R1", "R2", "R3"), WorkflowFlowRules.findRuns(runs, "  ").map { it.id })
        assertEquals(listOf("R1"), WorkflowFlowRules.findRuns(runs, "86AB").map { it.id })
        assertEquals(listOf("R2"), WorkflowFlowRules.findRuns(runs, "evt").map { it.id })
        assertTrue(WorkflowFlowRules.findRuns(runs, "zzz").isEmpty())
        assertEquals(true, runs[0].filtered)
        assertEquals("86abc", runs[0].taskId)
    }

    @Test fun `a delivery reads as event, task and event id, toned as on the web`() {
        val d = delivery("run_failed", event = "taskStatusUpdated", task = "86abc", eventId = "E1")
        assertEquals("taskStatusUpdated · task 86abc · #E1", WorkflowFlowRules.deliveryLine(d))
        assertNull(WorkflowFlowRules.deliveryLine(delivery("received")))
        assertEquals(BadgeTone.Danger, WorkflowFlowRules.deliveryTone(WorkflowTriggerDeliveryStatus.RUN_FAILED))
        assertEquals(BadgeTone.Success, WorkflowFlowRules.deliveryTone(WorkflowTriggerDeliveryStatus.RUN_SUCCEEDED))
        assertEquals(BadgeTone.Neutral, WorkflowFlowRules.deliveryTone(WorkflowTriggerDeliveryStatus.FILTERED_OUT))
        assertEquals(BadgeTone.Info, WorkflowFlowRules.deliveryTone(WorkflowTriggerDeliveryStatus.RUN_STARTED))
        assertEquals(listOf("taskCreated", "x"), WorkflowFlowRules.toggleEvent(listOf("taskCreated"), "x", true))
        assertEquals(listOf("x"), WorkflowFlowRules.toggleEvent(listOf("taskCreated", "x"), "taskCreated", false))
        assertEquals(listOf("issues", "pull_request"), WorkflowFlowRules.eventsFromText(" issues, ,pull_request "))
    }

    // ------------------------------------------------------------------ against a scripted hub

    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()
    private val bodies = mutableListOf<String>()
    private var old = false
    private var secretStored = false

    private fun ok(body: String, status: Int = 200) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                bodies += request.body.readUtf8()
                val path = request.requestUrl!!.encodedPath
                if (old) return MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                    .setBody("""{"error":{"code":"not_found","message":"Not found"}}""")
                return when {
                    path.endsWith("/workflows/$wf/triggers") && request.method == "POST" -> ok(trigger(), 201)
                    path.endsWith("/workflows/$wf/triggers") -> ok("""{"items":[${trigger()}]}""")
                    path.endsWith("/workflow-triggers/$trig/test") -> ok(deliveryJson("run_started", test = true))
                    path.endsWith("/workflow-triggers/$trig/deliveries") -> ok("""{"items":[${deliveryJson("run_started", test = true)}],"next_cursor":null}""")
                    path.endsWith("/workflow-triggers/$trig") && request.method == "PATCH" -> { secretStored = true; ok(trigger()) }
                    path.endsWith("/workflow-triggers/$trig") && request.method == "DELETE" -> MockResponse().setResponseCode(204)
                    path.endsWith("/workflows/send-test") -> ok("""{"status":"partial","message_ids":[],"delivered_to":["telegram"],"failures":[{"target":"core_hub","reason":"gone"}]}""")
                    path.endsWith("/workflows/test-step") -> ok("""{"executed":false,"rendered":"Look at sample-task","answer":null,"output":null,"error":null}""")
                    path.endsWith("/sessions") -> ok("""{"items":[${json.encodeToString(Session.serializer(), session())}],"next_cursor":null}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun ops() = WorkflowFlowOps { HubApis(server.url("/").toString().trimEnd('/'), OkHttpClient()) }
    private fun sent(i: Int) = json.parseToJsonElement(bodies[i]).jsonObject

    @Test fun `triggers - listed, added with the preset's name and ClickUp's events, secret saved, tested, deleted`() = runTest {
        val m = WorkflowTriggersModel(ops(), "work", wf)
        m.load()
        assertTrue(m.ui.value.supported)
        assertEquals(listOf(trig), m.ui.value.items.map { it.id })
        assertEquals("work", requests[0].getHeader("X-Hub-Profile"))

        m.create(WorkflowTriggerPreset.CLICKUP, "ClickUp")
        val add = sent(1)
        assertEquals("clickup", add["preset"]!!.jsonPrimitive.content)
        assertEquals("ClickUp", add["name"]!!.jsonPrimitive.content)
        assertEquals(listOf("taskCreated", "taskStatusUpdated"), add["events"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(2, m.ui.value.items.size)

        val t = m.ui.value.items.first()
        m.saveSecret(t, "  s3cret ")
        assertEquals("PATCH", requests[2].method)
        assertEquals("s3cret", sent(2)["secret"]!!.jsonPrimitive.content)
        assertTrue(m.ui.value.items.first().secretStored)

        m.patch(t, WorkflowFlowRules.header("  "))
        assertEquals("an empty header is an explicit null", JsonNull, sent(3)["signature_header"])
        m.patch(t, WorkflowFlowRules.prefix("sha256="))
        assertEquals("sha256=", sent(4)["signature_prefix"]!!.jsonPrimitive.content)

        m.test(m.ui.value.items.first(), "")
        assertEquals(JsonNull, sent(5)["event"])
        assertEquals(WorkflowTriggerDeliveryStatus.RUN_STARTED, m.ui.value.tested[trig])
        assertEquals("20", requests[6].requestUrl!!.queryParameter("limit"))
        assertEquals(1, m.ui.value.deliveries[trig]!!.size)

        m.delete(m.ui.value.items.first())
        assertEquals("DELETE", requests[7].method)
        assertTrue(m.ui.value.items.none { it.id == trig })
        assertTrue(m.ui.value.errors.isEmpty())
    }

    @Test fun `triggers - an older hub's 404 hides the section instead of showing an error`() = runTest {
        old = true
        val m = WorkflowTriggersModel(ops(), "work", wf)
        m.load()
        assertFalse(m.ui.value.supported)
        assertTrue(m.ui.value.errors.isEmpty())
    }

    @Test fun `send test, step test and the profile's conversations go to the workflow's profile`() = runTest {
        val o = ops()
        val send = WorkflowSend(listOf(WorkflowFlowRules.telegram("-1001"), WorkflowFlowRules.conversation(null)))
        val result = o.testSend("home", WorkflowFlowRules.sendTest(send, "  Hi  ")).getOrThrow()
        assertEquals("home", requests[0].getHeader("X-Hub-Profile"))
        assertEquals("Hi", sent(0)["text"]!!.jsonPrimitive.content)
        assertEquals(2, sent(0)["send"]!!.jsonObject["targets"]!!.jsonArray.size)
        assertEquals("core_hub", result.failures.single().target)

        val node = WorkflowDraftRules.add(WorkflowDraft(), WorkflowNode.Kind.CONDITION, "c").nodes.single()
        val r = o.testStep("home", WorkflowFlowRules.stepTest(node, "", WorkflowFlowRules.SAMPLE_TRIGGER, false)!!).getOrThrow()
        assertEquals("Look at sample-task", r.rendered)
        assertEquals("condition_1", sent(1)["node"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("taskStatusUpdated", sent(1)["trigger"]!!.jsonObject["event"]!!.jsonPrimitive.content)

        val sessions = o.conversations("home").getOrThrow()
        assertEquals("Reports", sessions.single().title)
        assertEquals("200", requests[2].requestUrl!!.queryParameter("limit"))
        assertEquals("home", requests[2].getHeader("X-Hub-Profile"))

        old = true
        assertEquals("an older hub's 404 is a plain error", 404, (o.testStep("home", WorkflowFlowRules.stepTest(node, "", "", false)!!).exceptionOrNull() as hub.core.android.data.HubError).status)
    }

    // ------------------------------------------------------------------ fixtures

    private fun session() = json.decodeFromString(
        Session.serializer(),
        """{"id":"01J8QK3ZR2W7M5N4P6T8V9X0SS","profile":"home","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"$at",
           "updated_at":"$at","agent_id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","source":"chat","pinned":false,"title":"Reports",
           "archived":false,"message_count":0,"status":"idle","notify":false}""",
    )

    private fun trigger() = """
        {"id":"$trig","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"$at","updated_at":"$at",
         "workflow_id":"$wf","name":"ClickUp","preset":"clickup","enabled":true,"events":["taskCreated"],
         "secret_stored":$secretStored,"path":"/api/v1/workflow-hooks/$trig","signature_header":null,"signature_encoding":null,
         "signature_prefix":null,"last_delivery_at":null}
    """.trimIndent()

    private fun deliveryJson(status: String, test: Boolean = false, event: String? = null, task: String? = null, eventId: String? = null) = """
        {"id":"01J8QK3ZR2W7M5N4P6T8V9X0DL","trigger_id":"$trig","workflow_id":"$wf","received_at":"$at","status":"$status",
         "filtered":false,"test":$test,"event":${event?.let { "\"$it\"" } ?: "null"},"event_id":${eventId?.let { "\"$it\"" } ?: "null"},
         "task_id":${task?.let { "\"$it\"" } ?: "null"},"workflow_run_id":null,"error":null,"body_preview":null}
    """.trimIndent()

    private fun delivery(status: String, event: String? = null, task: String? = null, eventId: String? = null): WorkflowTriggerDelivery =
        json.decodeFromString(WorkflowTriggerDelivery.serializer(), deliveryJson(status, event = event, task = task, eventId = eventId))

    private fun run(id: String, task: String?, event: String?): WorkflowRun = json.decodeFromString(
        WorkflowRun.serializer(),
        """{"id":"$id","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"$at","updated_at":"$at",
           "workflow_id":"$wf","job_id":"J","status":"succeeded","trigger":{"kind":"user","id":null},"steps":[],
           "limits":{"max_duration_seconds":null,"max_cost":null,"step_timeout_seconds":null},
           "task_id":${task?.let { "\"$it\"" } ?: "null"},"event_id":${event?.let { "\"$it\"" } ?: "null"},"filtered":${task != null},"phase":"completed"}""",
    )

    private fun workflow(onFailure: String) = json.decodeFromString(
        Workflow.serializer(),
        """{"id":"$wf","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"$at","updated_at":"$at",
           "name":"Flow","description":null,"working_dir":null,"nodes":[],"edges":[],"status":"idle","active_run_id":null,
           "run_count":0,"schedule_count":0,"limits":{"max_duration_seconds":null,"max_cost":null,"step_timeout_seconds":null},
           "on_failure":$onFailure}""",
    )
}

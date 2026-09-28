package hub.core.android.ui.screens

import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.ui.kit.BadgeTone
import hub.core.client.model.Session
import hub.core.client.model.WorkflowFailureAlert
import hub.core.client.model.WorkflowNode
import hub.core.client.model.WorkflowRule
import hub.core.client.model.WorkflowRules
import hub.core.client.model.WorkflowRun
import hub.core.client.model.WorkflowSend
import hub.core.client.model.WorkflowSendTarget
import hub.core.client.model.WorkflowSendTest
import hub.core.client.model.WorkflowStepTest
import hub.core.client.model.WorkflowTrigger
import hub.core.client.model.WorkflowTriggerDelivery
import hub.core.client.model.WorkflowTriggerDeliveryStatus
import hub.core.client.model.WorkflowTriggerPatch
import hub.core.client.model.WorkflowTriggerPreset
import hub.core.client.model.WorkflowTriggerTest
import hub.core.client.model.WorkflowTriggerWrite
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement

/*
 * Workflow editing on the phone as the web does it (DECISIONS §128, re-expressed from the web's
 * workflows/{model.ts, WorkflowTriggers.tsx, SendForm.tsx, StepTest.tsx, StepPanel.tsx}): a
 * condition's several rules (§123), a "Send message" step's targets (§124), the workflow's failure
 * alert, a step tried with a sample (§127), and the inbound triggers with their delivery log
 * (§123). The rules here are pure so they are tested without a hub; the calls go through the
 * generated client, each in the workflow's own profile. An older hub answers 404 to the new
 * endpoints: the Triggers section is hidden and a test shows a plain error.
 */
object WorkflowFlowRules {
    /** What a run a trigger started can read about its event (§123), offered while a rule's path is focused. */
    val TRIGGER_PATHS = listOf(
        "trigger.event",
        "trigger.task_id",
        "trigger.event_id",
        "trigger.body.history_items.0.field",
        "trigger.body.history_items.0.after.status",
    )

    /** The task events ClickUp sends, offered as a trigger's filter (anything else is typed). */
    val CLICKUP_EVENTS = listOf(
        "taskCreated", "taskUpdated", "taskDeleted", "taskStatusUpdated", "taskAssigneeUpdated", "taskPriorityUpdated",
        "taskDueDateUpdated", "taskTagUpdated", "taskMoved", "taskCommentPosted", "taskCommentUpdated",
    )

    /** The events a new ClickUp trigger takes. */
    val CLICKUP_DEFAULT_EVENTS = listOf("taskCreated", "taskStatusUpdated")

    val PRESETS = listOf(WorkflowTriggerPreset.CLICKUP, WorkflowTriggerPreset.GITHUB, WorkflowTriggerPreset.GENERIC_HMAC, WorkflowTriggerPreset.TOKEN)

    /** A ClickUp-shaped sample event to start "Test this step" from (the web's SAMPLE_TRIGGER). */
    val SAMPLE_TRIGGER = """
        {
          "event": "taskStatusUpdated",
          "task_id": "sample-task",
          "body": {
            "history_items": [
              {
                "field": "status",
                "after": {
                  "status": "review"
                }
              }
            ]
          }
        }
    """.trimIndent()

    // ------------------------------------------------------------------ several rules (§123)

    /** A rule to start from: the single comparison when there is one, else the trigger's event. */
    fun firstRule(input: String?): WorkflowRule {
        val parts = WorkflowDraftRules.splitCondition(input.orEmpty())
        if (parts != null && parts.first.isNotBlank()) {
            return WorkflowRule(parts.first, parts.second, if (parts.second in WorkflowDraftRules.UNARY) null else parts.third)
        }
        return WorkflowRule("trigger.event", "==", "")
    }

    /**
     * "Several rules" on: the rules start from the single line; off: they go, sent as an explicit
     * `null` so the hub drops them (left out, it would keep the saved ones).
     */
    fun withRules(node: WorkflowNode, on: Boolean): WorkflowNode =
        if (on) node.copy(rules = WorkflowRules(WorkflowRules.Match.ALL, listOf(firstRule(node.input))), sendNull = node.sendNull - WorkflowNode.Clearable.RULES)
        else node.copy(rules = null, sendNull = node.sendNull + WorkflowNode.Clearable.RULES)

    /** One rule changed; `exists` and `empty` have no value (null), and the others at least "". */
    fun setRule(rules: WorkflowRules, index: Int, change: (WorkflowRule) -> WorkflowRule): WorkflowRules =
        rules.copy(
            items = rules.items.mapIndexed { at, rule ->
                if (at != index) rule
                else change(rule).let { next ->
                    when {
                        next.operator in WorkflowDraftRules.UNARY -> next.copy(value = null)
                        next.value == null -> next.copy(value = "")
                        else -> next
                    }
                }
            },
        )

    fun addRule(rules: WorkflowRules): WorkflowRules = rules.copy(items = rules.items + WorkflowRule("trigger.event", "==", ""))

    /** The last rule stays: a condition with rules has at least one. */
    fun removeRule(rules: WorkflowRules, index: Int): WorkflowRules =
        if (rules.items.size <= 1) rules else rules.copy(items = rules.items.filterIndexed { at, _ -> at != index })

    /** The paths offered for a rule: the trigger's, the run's input, and the output of every step before it. */
    fun suggestions(draft: WorkflowDraft, nodeId: String): List<String> =
        TRIGGER_PATHS + "input" + WorkflowDraftRules.upstreamOf(draft, nodeId).map { "steps.${it.id}.output" }

    // ------------------------------------------------------------------ Send message (§124)

    /** The palette's "Send message": a notify step with targets (so an older app still loads it as a notice). */
    fun addSendStep(draft: WorkflowDraft, title: String): WorkflowDraft {
        val added = WorkflowDraftRules.add(draft, WorkflowNode.Kind.NOTIFY, title)
        val id = added.nodes.last().id
        return WorkflowDraftRules.update(added, id) { it.copy(send = WorkflowSend(emptyList())) }
    }

    fun target(send: WorkflowSend?, platform: String): WorkflowSendTarget? = send?.targets?.firstOrNull { it.platform == platform }

    /** Replaces (or removes, with null) the target of one platform; the others — unknown ones too — stay as they are. */
    fun setTarget(send: WorkflowSend, platform: String, next: WorkflowSendTarget?): WorkflowSend {
        val others = send.targets.filter { it.platform != platform }
        return WorkflowSend(if (next != null) others + next else others)
    }

    fun telegram(chatId: String) = WorkflowSendTarget(platform = "telegram", chatId = chatId.trim())

    fun conversation(session: Session?) =
        if (session == null) WorkflowSendTarget(platform = "core_hub")
        else WorkflowSendTarget(platform = "core_hub", sessionId = session.id, title = session.title, agentId = session.agentId)

    /** A variable of the step's words, read with the hub's own pattern (`expr.ts` `pathsIn`). */
    private val VARIABLE = Regex("""\{\{\s*([A-Za-z0-9_.]+)\s*\}\}""")

    /** Every variable of the words, once each, in order (`steps.analysis.output`, `input`). */
    fun variablesIn(text: String?): List<String> = VARIABLE.findAll(text.orEmpty()).map { it.groupValues[1] }.distinct().toList()

    /** The variables that have no value yet (an empty one counts as none). */
    fun missingIn(text: String?, values: Map<String, String>): List<String> = variablesIn(text).filter { values[it].isNullOrEmpty() }

    /** The words with each value put in; a variable without one stays as written (the preview). */
    fun fill(text: String?, values: Map<String, String>): String =
        VARIABLE.replace(text.orEmpty()) { match -> values[match.groupValues[1]]?.takeIf { it.isNotEmpty() } ?: match.value }

    /**
     * "Send test message" needs a target, words, and a value for each variable (2026-09-29): a test
     * never sends `{{steps.analysis.output}}` as it is.
     */
    fun canTestSend(send: WorkflowSend, text: String?, values: Map<String, String> = emptyMap()): Boolean =
        send.targets.isNotEmpty() && !text.isNullOrBlank() && missingIn(text, values).isEmpty()

    /** The test carries the words with the values put in, so it says what the run will say. */
    fun sendTest(send: WorkflowSend, text: String?, values: Map<String, String> = emptyMap()) =
        WorkflowSendTest(send, fill(text, values).trim())

    // ------------------------------------------------------------------ the failure alert (§127)

    /** The alert as the form leaves it: the inbox or at least one target keeps it; nothing is no alert (null). */
    fun alert(inbox: Boolean, send: WorkflowSend?): WorkflowFailureAlert? {
        val targets = send?.targets.orEmpty()
        if (!inbox && targets.isEmpty()) return null
        return if (targets.isEmpty()) WorkflowFailureAlert(inbox, null, sendNull = setOf(WorkflowFailureAlert.Clearable.SEND))
        else WorkflowFailureAlert(inbox, WorkflowSend(targets))
    }

    // ------------------------------------------------------------------ test this step (§127)

    /**
     * What "Try it" sends: the node as saving writes it, the sample input (null when empty), the
     * sample event parsed (null when empty), and a real agent turn only for an agent step when
     * asked. Null when the sample event is not JSON (nothing is sent; `test.bad_json` is shown).
     */
    fun stepTest(node: WorkflowNode, input: String, trigger: String, execute: Boolean): WorkflowStepTest? {
        val parsed: JsonElement? = if (trigger.isBlank()) null else
            runCatching { kotlinx.serialization.json.Json.parseToJsonElement(trigger) }.getOrNull() ?: return null
        val written = WorkflowDraftRules.toWrite(WorkflowDraft(name = "test", nodes = listOf(node))).nodes!!.single()
        return WorkflowStepTest(
            node = written,
            input = input.trim().ifEmpty { null },
            trigger = parsed,
            execute = node.kind == WorkflowNode.Kind.AGENT && execute,
        )
    }

    // ------------------------------------------------------------------ triggers (§123)

    /** What "Add trigger" sends: the preset, its label as the name, and ClickUp's two usual events. */
    fun newTrigger(preset: WorkflowTriggerPreset, name: String) = WorkflowTriggerWrite(
        preset = preset, name = name, events = if (preset == WorkflowTriggerPreset.CLICKUP) CLICKUP_DEFAULT_EVENTS else null,
    )

    /** A ClickUp event ticked or not, the others kept in their order. */
    fun toggleEvent(events: List<String>, event: String, on: Boolean): List<String> =
        if (on) (if (event in events) events else events + event) else events.filter { it != event }

    /** The events typed as `issues, pull_request`. */
    fun eventsFromText(text: String): List<String> = text.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    /** A header or prefix as typed: empty is an explicit null (the hub's default). */
    fun header(text: String) = text.trim().takeIf { it.isNotEmpty() }?.let { WorkflowTriggerPatch(signatureHeader = it) }
        ?: WorkflowTriggerPatch(sendNull = setOf(WorkflowTriggerPatch.Clearable.SIGNATURE_HEADER))

    fun prefix(text: String) = text.trim().takeIf { it.isNotEmpty() }?.let { WorkflowTriggerPatch(signaturePrefix = it) }
        ?: WorkflowTriggerPatch(sendNull = setOf(WorkflowTriggerPatch.Clearable.SIGNATURE_PREFIX))

    /** "Send test event" needs a stored secret and the trigger on. */
    fun canTest(trigger: WorkflowTrigger): Boolean = trigger.secretStored && trigger.enabled

    fun testBody(event: String) = event.trim().takeIf { it.isNotEmpty() }?.let { WorkflowTriggerTest(event = it) }
        ?: WorkflowTriggerTest(sendNull = setOf(WorkflowTriggerTest.Clearable.EVENT))

    /** A delivery's badge tone (the web's DELIVERY_TONE). */
    fun deliveryTone(status: WorkflowTriggerDeliveryStatus): BadgeTone = when (status) {
        WorkflowTriggerDeliveryStatus.RECEIVED, WorkflowTriggerDeliveryStatus.RUN_STARTED -> BadgeTone.Info
        WorkflowTriggerDeliveryStatus.SIGNATURE_REJECTED, WorkflowTriggerDeliveryStatus.RUN_FAILED -> BadgeTone.Danger
        WorkflowTriggerDeliveryStatus.RUN_SUCCEEDED -> BadgeTone.Success
        WorkflowTriggerDeliveryStatus.DUPLICATE, WorkflowTriggerDeliveryStatus.FILTERED_OUT -> BadgeTone.Neutral
    }

    /** `event · task <id> · #<event id>`, or null when the delivery names neither an event nor a task. */
    fun deliveryLine(d: WorkflowTriggerDelivery): String? {
        if (d.event.isNullOrBlank() && d.taskId.isNullOrBlank()) return null
        return listOfNotNull(
            d.event?.takeIf { it.isNotBlank() },
            d.taskId?.takeIf { it.isNotBlank() }?.let { "task $it" },
            d.eventId?.takeIf { it.isNotBlank() }?.let { "#$it" },
        ).joinToString(" · ")
    }

    // ------------------------------------------------------------------ runs

    /** "Find a run": the loaded runs whose task or event id holds the text, any case; everything when empty. */
    fun findRuns(runs: List<WorkflowRun>, text: String): List<WorkflowRun> {
        val needle = text.trim().lowercase()
        if (needle.isEmpty()) return runs
        return runs.filter { run -> listOfNotNull(run.taskId, run.eventId).any { it.lowercase().contains(needle) } }
    }
}

/** The calls the new sections make, each in the workflow's own profile. */
class WorkflowFlowOps(private val apis: () -> HubApis?) {
    private suspend fun <T> call(block: suspend (HubApis) -> T): Result<T> {
        val api = apis() ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { block(api) }
    }

    suspend fun triggers(profile: String, workflowId: String) =
        call { it.schedules.schedulesListWorkflowTriggers(xHubProfile = profile, workflowId = workflowId).items }
    suspend fun createTrigger(profile: String, workflowId: String, write: WorkflowTriggerWrite) =
        call { it.schedules.schedulesCreateWorkflowTrigger(profile, workflowId, write) }
    suspend fun updateTrigger(profile: String, id: String, patch: WorkflowTriggerPatch) =
        call { it.schedules.schedulesUpdateWorkflowTrigger(profile, id, patch) }
    suspend fun deleteTrigger(profile: String, id: String) = call { it.schedules.schedulesDeleteWorkflowTrigger(profile, id) }
    suspend fun testTrigger(profile: String, id: String, body: WorkflowTriggerTest) =
        call { it.schedules.schedulesTestWorkflowTrigger(profile, id, body) }
    suspend fun deliveries(profile: String, id: String) =
        call { it.schedules.schedulesListWorkflowTriggerDeliveries(profile, id, limit = 20).items }
    suspend fun testSend(profile: String, body: WorkflowSendTest) = call { it.schedules.schedulesTestWorkflowSend(profile, body) }
    suspend fun testStep(profile: String, body: WorkflowStepTest) = call { it.schedules.schedulesTestWorkflowStep(profile, body) }

    /** The profile's conversations, for a "Send message" target. */
    suspend fun conversations(profile: String) = call { it.sessions.sessionsList(profile, limit = 200).items }
}

/** The Triggers section's state: `supported` false once an older hub answered 404 (the section is hidden). */
data class TriggersUi(
    val supported: Boolean = true,
    val loaded: Boolean = false,
    val items: List<WorkflowTrigger> = emptyList(),
    val deliveries: Map<String, List<WorkflowTriggerDelivery>> = emptyMap(),
    /** The status the last "Send test event" of each trigger came back with. */
    val tested: Map<String, WorkflowTriggerDeliveryStatus> = emptyMap(),
    /** What is in flight: `create`, `<id>:secret`, `<id>:test`. */
    val busy: Set<String> = emptySet(),
    /** A refusal: the list's and Add's under "", a trigger's under its id. */
    val errors: Map<String, HubError> = emptyMap(),
)

/** A saved workflow's triggers, apart from Android's lifecycle so it is tested against a scripted hub. */
class WorkflowTriggersModel(private val ops: WorkflowFlowOps, private val profile: String, private val workflowId: String) {
    private val _ui = MutableStateFlow(TriggersUi())
    val ui: StateFlow<TriggersUi> = _ui.asStateFlow()

    private fun fail(key: String, e: Throwable) {
        val error = e as? HubError ?: HubError(0, null, e.message)
        _ui.update { it.copy(errors = it.errors + (key to error)) }
    }

    private fun replace(trigger: WorkflowTrigger) =
        _ui.update { ui -> ui.copy(items = ui.items.map { if (it.id == trigger.id) trigger else it }, errors = ui.errors - trigger.id) }

    suspend fun load() {
        ops.triggers(profile, workflowId)
            .onSuccess { items -> _ui.update { it.copy(items = items, loaded = true, supported = true, errors = it.errors - "") } }
            .onFailure { e ->
                if ((e as? HubError)?.status == 404) _ui.update { it.copy(supported = false, loaded = true) } else fail("", e)
            }
    }

    suspend fun create(preset: WorkflowTriggerPreset, name: String) {
        _ui.update { it.copy(busy = it.busy + "create", errors = it.errors - "") }
        ops.createTrigger(profile, workflowId, WorkflowFlowRules.newTrigger(preset, name))
            .onSuccess { made -> _ui.update { it.copy(items = it.items + made) } }
            .onFailure { fail("", it) }
        _ui.update { it.copy(busy = it.busy - "create") }
    }

    suspend fun patch(trigger: WorkflowTrigger, patch: WorkflowTriggerPatch, busy: String? = null) {
        busy?.let { key -> _ui.update { it.copy(busy = it.busy + key) } }
        ops.updateTrigger(profile, trigger.id, patch).onSuccess(::replace).onFailure { fail(trigger.id, it) }
        busy?.let { key -> _ui.update { it.copy(busy = it.busy - key) } }
    }

    /** The secret replaces the stored one; it is never read back. */
    suspend fun saveSecret(trigger: WorkflowTrigger, secret: String) {
        if (secret.isBlank()) return
        patch(trigger, WorkflowTriggerPatch(secret = secret.trim()), busy = "${trigger.id}:secret")
    }

    suspend fun test(trigger: WorkflowTrigger, event: String) {
        _ui.update { it.copy(busy = it.busy + "${trigger.id}:test", errors = it.errors - trigger.id) }
        ops.testTrigger(profile, trigger.id, WorkflowFlowRules.testBody(event))
            .onSuccess { d -> _ui.update { it.copy(tested = it.tested + (trigger.id to d.status)) }; deliveries(trigger.id) }
            .onFailure { fail(trigger.id, it) }
        _ui.update { it.copy(busy = it.busy - "${trigger.id}:test") }
    }

    suspend fun deliveries(triggerId: String) {
        ops.deliveries(profile, triggerId).onSuccess { rows -> _ui.update { it.copy(deliveries = it.deliveries + (triggerId to rows)) } }
    }

    suspend fun delete(trigger: WorkflowTrigger) {
        ops.deleteTrigger(profile, trigger.id)
            .onSuccess { _ui.update { ui -> ui.copy(items = ui.items.filter { it.id != trigger.id }, deliveries = ui.deliveries - trigger.id) } }
            .onFailure { fail(trigger.id, it) }
    }
}

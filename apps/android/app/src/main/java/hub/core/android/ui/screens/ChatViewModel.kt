package hub.core.android.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import hub.core.android.AppGraph
import hub.core.android.chat.AttachmentTray
import hub.core.android.chat.ChatActions
import hub.core.android.chat.ChatControls
import hub.core.client.model.Session
import hub.core.client.model.SessionPatch
import hub.core.client.model.WorkingDirs
import hub.core.android.chat.AttachmentUploader
import hub.core.android.chat.HubAttachmentBackend
import hub.core.android.chat.mimeOf
import hub.core.android.chat.ChatAttachment
import hub.core.android.chat.ChatMessage
import hub.core.android.chat.ChatReducer
import hub.core.android.chat.ChatState
import hub.core.android.chat.Outgoing
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.client.model.Agent
import hub.core.client.model.AgentStatus
import hub.core.client.model.Approval
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalResponse
import hub.core.client.model.MessageRole
import hub.core.client.model.RunCreate
import hub.core.client.model.SessionCreate
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** The agents a person can start a chat with: enabled and installed on the hub (as the web decides). */
object ChatAgents {
    private val INSTALLED = setOf(AgentStatus.AVAILABLE, AgentStatus.UPDATING, AgentStatus.LIMITED)

    fun startable(agents: List<Agent>): List<Agent> =
        agents.filter { it.enabled && it.status != AgentStatus.DISABLED && it.status in INSTALLED }
}

data class ChatUi(
    val chat: ChatState = ChatState(),
    val loading: Boolean = false,
    val hasOlder: Boolean = false,
    val loadingOlder: Boolean = false,
    val sending: Boolean = false,
    val error: HubError? = null,
    /** The draft's agent row (an empty chat only). */
    val agents: List<Agent> = emptyList(),
    val agentId: String? = null,
    /** The draft's agents have been read: «no agent» is said only then, never while they load. */
    val agentsLoaded: Boolean = false,
    /** The composer's chips (apps batch 1): the profile's chat models and the agent's approval mode. */
    val models: List<ChatControls.ModelOption> = emptyList(),
    val modelsLoaded: Boolean = false,
    /** The catalogue's rows and the chat's agent, from which [models] and [defaultModelName] are made. */
    val catalogue: List<hub.core.client.model.Model>? = null,
    val controlsAgent: hub.core.client.model.Agent? = null,
    /** Which model «Default» is, when the hub says (ADR 0029: a coding agent on the hub's models too). */
    val defaultModelName: String? = null,
    val approval: ChatControls.ApprovalField? = null,
    /** A new chat's model and working folder, chosen before it exists; `null` is the default / automatic. */
    val draftModel: String? = null,
    val draftFolder: String? = null,
    val dirs: WorkingDirs? = null,
    val dirsError: HubError? = null,
    /** What the last compress or steer did (not an error). */
    val notice: ChatNotice? = null,
    val compressing: Boolean = false,
    /** Messages held on the phone while a turn runs, in order (MessageQueue.kt). */
    val queue: List<QueuedMessage> = emptyList(),
    /** `/clear-screen`: the messages up to this `seq` are hidden until asked back (nothing is deleted). */
    val hiddenThrough: Int? = null,
    /** The agent's enabled skills, for the menu after `/skill ` (null until read). */
    val skills: List<hub.core.android.chat.SlashCommands.SkillChoice>? = null,
)

/** The outcome lines of the chat's own actions, turned into words by the screen. */
sealed interface ChatNotice {
    data object Compressing : ChatNotice
    data class Compressed(val outcome: ChatControls.Compression) : ChatNotice
    data object Steered : ChatNotice
    data object SteerQueued : ChatNotice
    /** A `/command` that needs words after it was sent without them. */
    data class NeedsWords(val command: String) : ChatNotice
    /** `/model <name>` named no model of this profile. */
    data class UnknownModel(val model: String) : ChatNotice
}

/**
 * One conversation, or the new-chat draft when [sessionId] is null. The draft creates the
 * session on the first message (NAVIGATION.md §1: «الجلسة تُنشأ عند أول رسالة») and hands the
 * message to the conversation screen through the outbox.
 */
class ChatViewModel(
    private val graph: AppGraph,
    private val sessionId: String?,
    private val profile: String,
) : ViewModel() {
    private val _ui = MutableStateFlow(ChatUi(loading = sessionId != null))
    val ui: StateFlow<ChatUi> = _ui.asStateFlow()
    private val apis get() = graph.store.current?.let(graph::apis)

    /** Files waiting in the composer, uploaded into this chat's profile as soon as they are picked. */
    val tray = AttachmentTray(
        viewModelScope,
        upload = { file ->
            val api = apis ?: throw HubError(401, "unauthorized", null)
            AttachmentUploader(HubAttachmentBackend(api, profile)).upload(file, mimeOf(file))
        },
        discard = { attachment -> hubCall { apis?.sessions?.sessionsDeleteAttachment(attachment.profile, attachment.id) } },
    )
    private val firstSubscribe = CompletableDeferred<Unit>()

    init {
        if (sessionId == null) {
            loadAgents()
        } else {
            viewModelScope.launch {
                graph.realtime.events.collect { envelope ->
                    val before = _ui.value.chat
                    _ui.update { it.copy(chat = ChatReducer.apply(it.chat, envelope, System.currentTimeMillis())) }
                    if (_ui.value.chat.running) holding = false
                    drain()
                    // This device → spoken replies: read the finished reply aloud while it is on screen.
                    if (envelope.event == "run.completed" && before.running && !_ui.value.chat.running &&
                        graph.device.choices.value.spokenReplies && graph.inForeground()
                    ) {
                        val hub = graph.store.current?.let {
                            hub.core.android.phone.HubVoice(graph.apis(it), it.hub, profile, graph.device.choices.value.voiceSource)
                        }
                        _ui.value.chat.messages.lastOrNull { it.role == MessageRole.ASSISTANT }?.text?.let { graph.speaker.speak(it, hub) }
                    }
                }
            }
            viewModelScope.launch {
                // Every time the socket is (re)connected: subscribe, resuming after the last `seq` seen.
                graph.realtime.connected.filter { it }.collect { resubscribe(sessionId) }
            }
            load(sessionId, sendOutbox = true)
        }
    }

    private suspend fun resubscribe(id: String) {
        val ack = graph.realtime.subscribe(id, _ui.value.chat.lastSeq)
        firstSubscribe.complete(Unit)
        if (ack?.truncated == true) load(id, sendOutbox = false)
    }

    private fun loadAgents() {
        val api = apis ?: return
        viewModelScope.launch {
            hubCall { api.agents.agentsList(profile) }.onSuccess { page ->
                val agents = ChatAgents.startable(page.items)
                _ui.update { it.copy(agents = agents, agentId = it.agentId ?: agents.firstOrNull()?.id, agentsLoaded = true) }
            }.onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
        }
    }

    fun selectAgent(id: String) = _ui.update { it.copy(agentId = id) }

    private fun load(id: String, sendOutbox: Boolean) {
        val api = apis ?: return
        viewModelScope.launch {
            val detail = hubCall { api.sessions.sessionsGet(profile, id) }
            val page = hubCall { api.sessions.sessionsListMessages(profile, id, limit = 50) }
            val d = detail.getOrNull()
            val p = page.getOrNull()
            if (d == null || p == null) {
                _ui.update { it.copy(loading = false, error = (detail.exceptionOrNull() ?: page.exceptionOrNull()) as? HubError) }
                return@launch
            }
            _ui.update {
                it.copy(
                    loading = false,
                    hasOlder = p.hasMore,
                    chat = ChatReducer.loaded(it.chat, d, p.items, System.currentTimeMillis()),
                )
            }
            if (sendOutbox && graph.outbox.containsKey(id)) {
                withTimeoutOrNull(5_000) { firstSubscribe.await() }
                graph.outbox.remove(id)?.let { send(it) }
            }
        }
    }

    fun loadOlder() {
        val id = sessionId ?: return
        val api = apis ?: return
        val first = _ui.value.chat.messages.firstOrNull()?.id ?: return
        if (_ui.value.loadingOlder || !_ui.value.hasOlder) return
        _ui.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            hubCall { api.sessions.sessionsListMessages(profile, id, before = first, limit = 50) }
                .onSuccess { page ->
                    _ui.update { it.copy(loadingOlder = false, hasOlder = page.hasMore, chat = ChatReducer.olderLoaded(it.chat, page.items)) }
                }
                .onFailure { e -> _ui.update { it.copy(loadingOlder = false, error = e as HubError) } }
        }
    }

    /**
     * Sends a message. In the draft this creates the session and calls [onCreated] with it; the
     * conversation screen then subscribes and sends the message itself.
     */
    fun send(text: String, onCreated: (sessionId: String, profile: String) -> Unit = { _, _ -> }, replyTo: String? = null) {
        if (tray.uploading) return
        val outgoing = tray.message(text)
        if (outgoing.isEmpty) return
        tray.clear()
        send(outgoing, onCreated, replyTo)
    }

    /** The person's words and the files they attached, as one run (web: `blocksFor`); [replyTo] names the message answered. */
    fun send(outgoing: Outgoing, onCreated: (sessionId: String, profile: String) -> Unit = { _, _ -> }, replyTo: String? = null) {
        if (outgoing.isEmpty) return
        val api = apis ?: return
        _ui.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            if (sessionId == null) {
                val agentId = _ui.value.agentId ?: run { _ui.update { it.copy(sending = false) }; return@launch }
                val create = SessionCreate(agentId = agentId, model = _ui.value.draftModel, workingDir = _ui.value.draftFolder)
                hubCall { api.sessions.sessionsCreate(profile, create, UUID.randomUUID().toString()) }
                    .onSuccess { session ->
                        graph.outbox[session.id] = outgoing
                        _ui.update { it.copy(sending = false) }
                        onCreated(session.id, session.profile)
                    }
                    .onFailure { e -> _ui.update { it.copy(sending = false, error = e as HubError) } }
                return@launch
            }
            // «Wait in line» while a turn runs: the message waits here, not in the hub's queue (MessageQueue.kt).
            // A message behind others that wait goes behind them too, so the order stays the order typed.
            if (MessageQueueRules.holdsBack(HubDisplay.prefs.value, _ui.value.chat.running || holding || _ui.value.queue.isNotEmpty())) {
                _ui.update { it.copy(sending = false, queue = it.queue + MessageQueueRules.queued(outgoing, replyTo)) }
                return@launch
            }
            // Send while the agent works follows the person's choice (Display → busy_input_mode).
            post(outgoing, HubDisplay.busyWhen(HubDisplay.prefs.value), replyTo)
        }
    }

    /** One message to the hub now, with [whenBusy] (`RunCreate.when`), echoed in the transcript at once. */
    private suspend fun post(outgoing: Outgoing, whenBusy: RunCreate.When, replyTo: String?): Boolean {
        val id = sessionId ?: return false
        val api = apis ?: return false
        val body = outgoing.text.trim()
        _ui.update { it.copy(sending = true, error = null) }
        var posted = false
        run {
            hubCall {
                api.sessions.sessionsCreateRun(
                    profile, id,
                    RunCreate(content = outgoing.blocks(), `when` = whenBusy, replyToMessageId = replyTo),
                    UUID.randomUUID().toString(),
                )
            }.onSuccess { accepted ->
                posted = true
                _ui.update { ui ->
                    val chat = ui.chat
                    val echo = if (chat.messages.any { it.id == accepted.messageId }) chat.messages else chat.messages + ChatMessage(
                        id = accepted.messageId, seq = (chat.messages.maxOfOrNull { it.seq } ?: 0) + 1, role = MessageRole.USER,
                        authorName = graph.store.current?.user?.displayName.orEmpty(), text = body, reasoning = "", reasoningMs = null,
                        toolCalls = emptyList(),
                        attachments = outgoing.blocks().filter { it.attachmentId != null }.map { ChatAttachment(it.type, it.name, it.url, it.attachmentId, it.mime, it.sizeBytes) },
                        runId = accepted.runId, streaming = false, createdAt = java.time.OffsetDateTime.now(),
                    )
                    ui.copy(sending = false, chat = chat.copy(messages = echo, failure = null))
                }
            }.onFailure { e -> _ui.update { it.copy(sending = false, error = e as HubError) } }
        }
        return posted
    }

    /** A released message's run has been accepted but not yet heard: nothing more goes until it is. */
    private var holding = false
    private var holdJob: kotlinx.coroutines.Job? = null

    /** Sends one waiting message: in turn (`queue`), now after this turn (`next`), or instead of it (`interrupt`). */
    private fun release(item: QueuedMessage, whenBusy: RunCreate.When) {
        _ui.update { it.copy(queue = it.queue.filter { q -> q.key != item.key }) }
        holding = true
        viewModelScope.launch {
            val ok = post(item.outgoing, whenBusy, item.replyTo)
            holdJob?.cancel()
            holdJob = viewModelScope.launch {
                // The run's first event normally ends the hold; this is the fallback for a missed one.
                kotlinx.coroutines.delay(if (ok) MessageQueueRules.HOLD_MS else 0)
                holding = false
                drain()
            }
        }
    }

    /** The queue empties itself in order, one message per turn, as each turn ends. */
    private fun drain() {
        val ui = _ui.value
        if (!MessageQueueRules.shouldDrain(ui.chat.running, ui.sending, holding, ui.queue)) return
        release(ui.queue.first(), RunCreate.When.QUEUE)
    }

    /** «Send now»: jumps the hub's queue and runs right after the live turn. */
    fun sendNow(item: QueuedMessage) = release(item, RunCreate.When.NEXT)

    /** «Steer»: stops the live turn and takes this instead, in the same context. */
    fun steerWith(item: QueuedMessage) = release(item, RunCreate.When.INTERRUPT)

    /** «Remove»: it was never sent, so there is nothing to cancel. */
    fun unqueue(item: QueuedMessage) = _ui.update { it.copy(queue = it.queue.filter { q -> q.key != item.key }) }

    /** Leaving the conversation drops what was never sent, as closing the web's tab does. */
    fun dropQueue() = _ui.update { it.copy(queue = emptyList()) }

    /** `/clear-screen`: hides what is on the screen now; «Show them» brings it back. */
    fun clearScreen() = _ui.update { ui -> ui.copy(hiddenThrough = ui.chat.messages.maxOfOrNull { it.seq } ?: ui.hiddenThrough) }
    fun showCleared() = _ui.update { it.copy(hiddenThrough = null) }

    fun say(notice: ChatNotice) = _ui.update { it.copy(notice = notice) }

    /** The agent's enabled skills, read once, for the menu after `/skill `. */
    fun loadSkills(agentId: String?) {
        val id = agentId ?: return
        if (_ui.value.skills != null) return
        val api = apis ?: return
        _ui.update { it.copy(skills = null) }
        viewModelScope.launch {
            val list = hubCall { api.agents.agentsListSkills(profile, id).categories }.getOrNull()
            _ui.update { it.copy(skills = list?.let(hub.core.android.chat.SlashCommands::skills) ?: emptyList()) }
        }
    }

    fun stop() {
        val id = sessionId ?: return
        val run = _ui.value.chat.activeRun ?: return
        val api = apis ?: return
        viewModelScope.launch {
            hubCall { api.sessions.sessionsCancelRun(profile, id, run.id) }.onFailure { e ->
                if ((e as HubError).status != 409) _ui.update { it.copy(error = e) }
            }
        }
    }

    /** Answers an approval or a question; a 409 means it was answered elsewhere or expired. */
    fun respond(approval: Approval, decision: ApprovalDecision?, answer: String?) {
        val api = apis ?: return
        viewModelScope.launch {
            hubCall { api.sessions.sessionsRespondApproval(approval.profile, approval.id, ApprovalResponse(decision, answer)) }
                .onSuccess { _ui.update { it.copy(chat = it.chat.copy(approvals = it.chat.approvals - approval.id)) } }
                .onFailure { e ->
                    if ((e as HubError).status == 409) _ui.update { it.copy(chat = it.chat.copy(approvals = it.chat.approvals - approval.id)) }
                    else _ui.update { it.copy(error = e) }
                }
        }
    }

    fun dismissError() = _ui.update { it.copy(error = null) }

    // ---------------------------------------------------------------- chat controls (apps batch 1)

    private val actions get() = apis?.let(::ChatActions)
    private var controlsKey: String? = null

    /** Fills the chips once per agent: the catalogue, the agent's approval mode, and a new chat's folders. */
    fun loadControls(agentId: String?) {
        val act = actions ?: return
        val key = agentId.orEmpty()
        if (key == controlsKey) return
        controlsKey = key
        _ui.update { it.copy(controlsAgent = null) }
        viewModelScope.launch {
            val rows = runCatching { act.catalogueModels(profile) }.getOrNull()
            _ui.update { withModels(it.copy(catalogue = rows ?: it.catalogue, modelsLoaded = true)) }
        }
        if (agentId != null) {
            viewModelScope.launch {
                // Without it the picker offers the whole catalogue, as before (an older hub, an error).
                val agent = runCatching { act.agent(profile, agentId) }.getOrNull() ?: return@launch
                _ui.update { withModels(it.copy(controlsAgent = agent)) }
            }
        }
        viewModelScope.launch {
            val field = agentId?.let { id -> runCatching { act.approval(profile, id) }.getOrNull() }
            _ui.update { it.copy(approval = field) }
        }
        if (sessionId == null && _ui.value.dirs == null) {
            viewModelScope.launch {
                hubCall { act.workingDirs(profile) }
                    .onSuccess { dirs -> _ui.update { it.copy(dirs = dirs, dirsError = null) } }
                    .onFailure { e -> _ui.update { it.copy(dirsError = e as HubError) } }
            }
        }
    }

    /** The picker's options for the chat's agent (the gateway's models on the hub's models) and its «Default». */
    private fun withModels(state: ChatUi): ChatUi {
        val rows = state.catalogue ?: return state
        val options = ChatControls.models(rows, ChatControls.gatewayOnly(state.controlsAgent), state.controlsAgent?.gatewayMinContext)
        return state.copy(models = options, defaultModelName = ChatControls.defaultModelName(state.controlsAgent, options))
    }

    /** The chat's model; in the draft it is kept for `sessions.create` (null = the agent's default). */
    fun setModel(value: String?) {
        if (sessionId == null) {
            _ui.update { it.copy(draftModel = value) }
            return
        }
        if (value == _ui.value.chat.session?.model) return
        change(ChatControls.modelPatch(value))
    }

    fun setFolder(value: String?) = _ui.update { it.copy(draftFolder = value) }

    /** The agent's approval mode (admin); it applies to every chat with the agent in this profile. */
    fun setApproval(agentId: String, value: String) {
        val act = actions ?: return
        val field = _ui.value.approval ?: return
        if (value == field.value) return
        viewModelScope.launch {
            hubCall { act.setApproval(profile, agentId, field, value) }
                .onSuccess { _ui.update { it.copy(approval = field.copy(value = value)) } }
                .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
        }
    }

    /** Rename, pin, archive and their undo; the hub's answer replaces what the screen shows. */
    fun change(patch: SessionPatch, onDone: () -> Unit = {}) {
        val id = sessionId ?: return
        val act = actions ?: return
        viewModelScope.launch {
            hubCall { act.update(id, profile, patch) }
                .onSuccess { session -> _ui.update { it.copy(chat = ChatReducer.absorb(it.chat, session)) }; onDone() }
                .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
        }
    }

    fun rename(typed: String) {
        val title = ChatControls.renameTitle(typed) ?: return
        change(SessionPatch(title = title))
    }

    suspend fun delete(): Result<Unit> {
        val id = sessionId ?: return Result.success(Unit)
        val act = actions ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { act.delete(id, profile) }
    }

    /** A new chat with this one's transcript up to [messageId] (all of it when null). */
    fun fork(messageId: String? = null, onForked: (Session) -> Unit) {
        val id = sessionId ?: return
        val act = actions ?: return
        viewModelScope.launch {
            hubCall { act.fork(id, profile, messageId) }
                .onSuccess(onForked)
                .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
        }
    }

    /** [focus]: what the summary should keep in view (the context sheet, apps batch 6); empty is the whole chat. */
    fun compress(focus: String = "") {
        val id = sessionId ?: return
        val act = actions ?: return
        if (_ui.value.compressing) return
        _ui.update { it.copy(compressing = true, notice = ChatNotice.Compressing) }
        viewModelScope.launch {
            hubCall { act.compress(id, profile, focus) }
                .onSuccess { result -> _ui.update { it.copy(compressing = false, notice = ChatNotice.Compressed(ChatControls.compression(result))) } }
                .onFailure { e -> _ui.update { it.copy(compressing = false, notice = null, error = e as HubError) } }
        }
    }

    /**
     * Guides the running reply with [text]; when it cannot take it, the words go as the next
     * message instead (what Hermes itself does with a steer that has no turn to join).
     */
    fun steer(text: String) {
        val id = sessionId ?: return
        val act = actions ?: return
        val run = _ui.value.chat.activeRun ?: return send(Outgoing(text))
        viewModelScope.launch {
            hubCall { act.steer(id, profile, run.id, text) }
                .onSuccess { result ->
                    if (result.status == hub.core.client.model.RunSteerResult.Status.QUEUED) {
                        _ui.update { it.copy(notice = ChatNotice.Steered) }
                    } else {
                        _ui.update { it.copy(notice = ChatNotice.SteerQueued) }
                        send(Outgoing(text))
                    }
                }
                .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
        }
    }

    fun dismissNotice() = _ui.update { it.copy(notice = null) }

    /** Reads a reply aloud, through the hub's voice when this phone chose it (as spoken replies do). */
    fun speak(text: String) {
        val hub = graph.store.current?.let {
            hub.core.android.phone.HubVoice(graph.apis(it), it.hub, profile, graph.device.choices.value.voiceSource)
        }
        graph.speaker.speak(text, hub)
    }

    override fun onCleared() {
        sessionId?.let(graph.realtime::unsubscribe)
    }
}

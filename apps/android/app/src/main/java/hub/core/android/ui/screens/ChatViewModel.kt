package hub.core.android.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import hub.core.android.AppGraph
import hub.core.android.chat.AttachmentTray
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
)

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
                _ui.update { it.copy(agents = agents, agentId = it.agentId ?: agents.firstOrNull()?.id) }
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
    fun send(text: String, onCreated: (sessionId: String, profile: String) -> Unit = { _, _ -> }) {
        if (tray.uploading) return
        val outgoing = tray.message(text)
        if (outgoing.isEmpty) return
        tray.clear()
        send(outgoing, onCreated)
    }

    /** The person's words and the files they attached, as one run (web: `blocksFor`). */
    fun send(outgoing: Outgoing, onCreated: (sessionId: String, profile: String) -> Unit = { _, _ -> }) {
        if (outgoing.isEmpty) return
        val body = outgoing.text.trim()
        val api = apis ?: return
        _ui.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            if (sessionId == null) {
                val agentId = _ui.value.agentId ?: run { _ui.update { it.copy(sending = false) }; return@launch }
                hubCall { api.sessions.sessionsCreate(profile, SessionCreate(agentId = agentId), UUID.randomUUID().toString()) }
                    .onSuccess { session ->
                        graph.outbox[session.id] = outgoing
                        _ui.update { it.copy(sending = false) }
                        onCreated(session.id, session.profile)
                    }
                    .onFailure { e -> _ui.update { it.copy(sending = false, error = e as HubError) } }
                return@launch
            }
            hubCall {
                api.sessions.sessionsCreateRun(
                    profile, sessionId,
                    RunCreate(content = outgoing.blocks()),
                    UUID.randomUUID().toString(),
                )
            }.onSuccess { accepted ->
                _ui.update { ui ->
                    val chat = ui.chat
                    val echo = if (chat.messages.any { it.id == accepted.messageId }) chat.messages else chat.messages + ChatMessage(
                        id = accepted.messageId, seq = (chat.messages.maxOfOrNull { it.seq } ?: 0) + 1, role = MessageRole.USER,
                        authorName = graph.store.current?.user?.displayName.orEmpty(), text = body, reasoning = "", reasoningMs = null,
                        toolCalls = emptyList(),
                        attachments = outgoing.blocks().filter { it.attachmentId != null }.map { ChatAttachment(it.type, it.name, it.url, it.attachmentId, it.mime) },
                        runId = accepted.runId, streaming = false,
                    )
                    ui.copy(sending = false, chat = chat.copy(messages = echo, failure = null))
                }
            }.onFailure { e -> _ui.update { it.copy(sending = false, error = e as HubError) } }
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

    override fun onCleared() {
        sessionId?.let(graph.realtime::unsubscribe)
    }
}

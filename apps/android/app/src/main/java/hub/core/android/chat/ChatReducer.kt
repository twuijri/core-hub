package hub.core.android.chat

import hub.core.android.realtime.Envelope
import hub.core.android.realtime.SESSIONS_NAMESPACE
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Approval
import hub.core.client.model.ApprovalStatus
import hub.core.client.model.ContentBlock
import hub.core.client.model.Message
import hub.core.client.model.MessageRole
import hub.core.client.model.Run
import hub.core.client.model.RunStatus
import hub.core.client.model.Session
import hub.core.client.model.SessionDetail
import hub.core.client.model.ToolCall
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** An attachment shown under a message: a picture or a file the hub keeps. */
data class ChatAttachment(val kind: ContentBlock.Type, val name: String?, val url: String?)

/** One message as the transcript draws it. The text is the concatenation of its text blocks. */
data class ChatMessage(
    val id: String,
    val seq: Int,
    val role: MessageRole,
    val authorName: String,
    val text: String,
    val reasoning: String,
    val reasoningMs: Int?,
    val toolCalls: List<ToolCall>,
    val attachments: List<ChatAttachment>,
    val runId: String?,
    val streaming: Boolean,
) {
    /** The hub opens a run with an empty assistant shell; until something lands in it, it is not a turn. */
    val isEmpty: Boolean get() = text.isBlank() && toolCalls.isEmpty() && attachments.isEmpty() && reasoning.isBlank()

    companion object {
        fun from(message: Message) = ChatMessage(
            id = message.id,
            seq = message.seq,
            role = message.role,
            authorName = message.author.name,
            text = message.content.filter { it.type == ContentBlock.Type.TEXT }.mapNotNull { it.text }.joinToString("\n\n"),
            reasoning = message.reasoning?.text.orEmpty(),
            reasoningMs = message.reasoning?.durationMs,
            toolCalls = message.toolCalls,
            attachments = message.content.filter { it.type != ContentBlock.Type.TEXT && it.type != ContentBlock.Type.LOCATION }
                .map { ChatAttachment(it.type, it.name, it.url) },
            runId = message.runId,
            streaming = message.status == hub.core.client.model.MessageStatus.STREAMING,
        )
    }
}

/** The session's header facts the chat screen needs. */
data class ChatSessionInfo(val id: String, val profile: String, val title: String?, val agentId: String)

/**
 * The whole state of one open conversation. [lastSeq] is the highest `seq` seen on
 * `/rt/sessions` for the session's profile — what a resume sends as `after_seq`.
 */
data class ChatState(
    val session: ChatSessionInfo? = null,
    val messages: List<ChatMessage> = emptyList(),
    val approvals: Map<String, Approval> = emptyMap(),
    val activeRun: Run? = null,
    /** Epoch ms the live run started on this screen, for the thinking indicator's count. */
    val runStartedAt: Long? = null,
    /** The tool the agent is in right now, shown beside the count. */
    val currentStep: String? = null,
    val lastSeq: Long = 0,
    /** The hub's words for the last run that failed. */
    val failure: String? = null,
) {
    val running: Boolean get() = activeRun != null
    val question: Approval? get() = approvals.values.firstOrNull { it.kind == hub.core.client.model.ApprovalKind.QUESTION }
    val decisions: List<Approval> get() = approvals.values.filter { it.kind != hub.core.client.model.ApprovalKind.QUESTION }
}

/** Pure transitions of [ChatState]; the view model feeds it HTTP documents and envelopes. */
object ChatReducer {
    private val json = Serializer.kotlinxSerializationJson

    private fun <T> JsonObject.decode(key: String, serializer: KSerializer<T>): T? =
        this[key]?.let { runCatching { json.decodeFromJsonElement(serializer, it) }.getOrNull() }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    /** The session document and a page of messages, as read over HTTP on open or resync. */
    fun loaded(state: ChatState, detail: SessionDetail, messages: List<Message>, now: Long): ChatState {
        val active = detail.runs.firstOrNull { it.status == RunStatus.RUNNING || it.status == RunStatus.WAITING }
            ?: detail.runs.firstOrNull { it.status == RunStatus.QUEUED }
        val merged = (messages.map(ChatMessage::from).associateBy { it.id } +
            state.messages.filter { m -> messages.none { it.id == m.id } && m.seq > (messages.maxOfOrNull { it.seq } ?: 0) }
                .associateBy { it.id }).values.sortedBy { it.seq }
        return state.copy(
            session = ChatSessionInfo(detail.id, detail.profile, detail.title, detail.agentId),
            messages = merged,
            approvals = detail.pendingApprovals.filter { it.status == ApprovalStatus.PENDING }.associateBy { it.id },
            activeRun = active,
            runStartedAt = if (active == null) null else state.runStartedAt ?: active.startedAt?.toInstant()?.toEpochMilli() ?: now,
        )
    }

    /** Older messages read while scrolling back; they go before what is shown. */
    fun olderLoaded(state: ChatState, older: List<Message>): ChatState {
        val known = state.messages.map { it.id }.toSet()
        return state.copy(messages = (older.filter { it.id !in known }.map(ChatMessage::from) + state.messages).sortedBy { it.seq })
    }

    fun apply(state: ChatState, envelope: Envelope, now: Long): ChatState {
        val session = state.session ?: return state
        if (envelope.namespace != SESSIONS_NAMESPACE) return state
        val p = envelope.payload
        val sessionOfEvent = p.string("session_id")
            ?: p.decode("message", Message.serializer())?.sessionId
            ?: p.decode("run", Run.serializer())?.sessionId
            ?: p.decode("approval", Approval.serializer())?.sessionId
            ?: p.decode("session", Session.serializer())?.id
        if (sessionOfEvent != session.id) return state
        val seen = if (envelope.profile == session.profile) state.copy(lastSeq = maxOf(state.lastSeq, envelope.seq)) else state
        return when (envelope.event) {
            "message.created" -> p.decode("message", Message.serializer())?.let { seen.upsert(ChatMessage.from(it)) } ?: seen
            "message.delta" -> seen.edit(p.string("message_id"), p.string("run_id")) { it.copy(text = it.text + p.string("delta").orEmpty(), streaming = true) }
            "reasoning.delta" -> seen.edit(p.string("message_id"), p.string("run_id")) { it.copy(reasoning = it.reasoning + p.string("delta").orEmpty(), streaming = true) }
            "tool.started", "tool.completed", "tool.failed" -> {
                val call = p.decode("tool_call", ToolCall.serializer()) ?: return seen
                val step = if (envelope.event == "tool.started") call.name else seen.currentStep
                seen.edit(p.string("message_id"), p.string("run_id")) { m ->
                    val calls = if (m.toolCalls.any { it.id == call.id }) m.toolCalls.map { if (it.id == call.id) call else it } else m.toolCalls + call
                    m.copy(toolCalls = calls)
                }.copy(currentStep = step)
            }
            "run.queued" -> p.decode("run", Run.serializer())?.let { run -> if (seen.activeRun == null) seen.copy(activeRun = run) else seen } ?: seen
            "run.started" -> p.decode("run", Run.serializer())?.let { run ->
                seen.copy(activeRun = run, runStartedAt = run.startedAt?.toInstant()?.toEpochMilli() ?: now, currentStep = null, failure = null)
            } ?: seen
            "run.completed" -> {
                val final = p.decode("message", Message.serializer())
                val ended = seen.endRun(p.decode("run", Run.serializer()))
                if (final != null) ended.upsert(ChatMessage.from(final).copy(streaming = false)) else ended
            }
            "run.failed" -> {
                val run = p.decode("run", Run.serializer())
                seen.endRun(run).copy(failure = run?.error?.error ?: "")
            }
            "run.cancelled" -> seen.endRun(p.decode("run", Run.serializer()))
            "approval.requested" -> p.decode("approval", Approval.serializer())?.let {
                if (it.status == ApprovalStatus.PENDING) seen.copy(approvals = seen.approvals + (it.id to it)) else seen
            } ?: seen
            "approval.resolved" -> p.decode("approval", Approval.serializer())?.let { seen.copy(approvals = seen.approvals - it.id) } ?: seen
            "session.updated" -> p.decode("session", Session.serializer())?.let {
                seen.copy(session = session.copy(title = it.title, agentId = it.agentId))
            } ?: seen
            else -> seen
        }
    }

    private fun ChatState.upsert(message: ChatMessage): ChatState {
        val existing = messages.indexOfFirst { it.id == message.id }
        val list = if (existing >= 0) messages.toMutableList().also { it[existing] = mergeStream(it[existing], message) } else messages + message
        return copy(messages = list.sortedBy { it.seq })
    }

    /** A `message.created` shell must not wipe text that already streamed into it. */
    private fun mergeStream(old: ChatMessage, new: ChatMessage): ChatMessage =
        if (new.streaming && new.text.isEmpty() && old.text.isNotEmpty()) new.copy(text = old.text, reasoning = old.reasoning, toolCalls = old.toolCalls) else new

    private fun ChatState.edit(messageId: String?, runId: String?, change: (ChatMessage) -> ChatMessage): ChatState {
        messageId ?: return this
        val index = messages.indexOfFirst { it.id == messageId }
        if (index >= 0) return copy(messages = messages.toMutableList().also { it[index] = change(it[index]) })
        // A delta ahead of its `message.created` (a resumed stream): start the shell here.
        val seq = (messages.maxOfOrNull { it.seq } ?: 0) + 1
        val shell = ChatMessage(messageId, seq, MessageRole.ASSISTANT, "", "", "", null, emptyList(), emptyList(), runId, true)
        return copy(messages = messages + change(shell))
    }

    private fun ChatState.endRun(run: Run?): ChatState {
        if (run != null && activeRun != null && activeRun.id != run.id) return this
        val outputId = run?.outputMessageId
        return copy(
            activeRun = null,
            runStartedAt = null,
            currentStep = null,
            messages = messages.map { if (it.streaming && (outputId == null || it.id == outputId)) it.copy(streaming = false) else it },
        )
    }
}

/** A turn: consecutive non-empty messages from the same speaker (docs/clients/DESIGN.md). */
data class Turn(val role: MessageRole, val authorName: String, val messages: List<ChatMessage>) {
    val fromPerson: Boolean get() = role == MessageRole.USER
}

object Turns {
    fun group(messages: List<ChatMessage>): List<Turn> {
        val turns = mutableListOf<Turn>()
        for (message in messages) {
            if (message.isEmpty) continue
            val last = turns.lastOrNull()
            if (last != null && last.role == message.role && last.authorName == message.authorName) {
                turns[turns.lastIndex] = last.copy(messages = last.messages + message)
            } else {
                turns += Turn(message.role, message.authorName, listOf(message))
            }
        }
        return turns
    }
}

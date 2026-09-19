package us.i3u.hermesstudio

/**
 * What the room socket reports while it is open. The reducer below is the only
 * place that turns these into screen state, so it can be unit-tested without a
 * socket (the web keeps the same logic in `stores/hermes/group-chat.ts`).
 */
sealed interface RoomEvent {
    /** The `join` ack: the room, its recent history and the live snapshot. */
    data class Joined(val snapshot: RoomSnapshot) : RoomEvent
    data object Dropped : RoomEvent
    data class Failed(val error: String, val code: String? = null) : RoomEvent
    /** A persisted `message` (user, agent, or tool row). */
    data class Posted(val message: GroupMessage) : RoomEvent
    data class StreamStarted(val message: GroupMessage) : RoomEvent
    data class StreamDelta(val id: String, val delta: String) : RoomEvent
    data class ReasoningDelta(val id: String, val delta: String) : RoomEvent
    data class StreamEnded(val id: String) : RoomEvent
    data class MessageRetracted(val messageId: String, val totalTokens: Long?) : RoomEvent
    data class MembersChanged(val members: List<RoomMember>) : RoomEvent
    data object Kicked : RoomEvent
    data class AgentsUpdated(val agents: List<RoomAgent>) : RoomEvent
    data class Typing(val userId: String, val userName: String, val typing: Boolean) : RoomEvent
    data class Activity(val activity: AgentActivity) : RoomEvent
    /** `context_status`: compressing / ready per agent name. */
    data class ContextStatus(val agentName: String, val status: String) : RoomEvent
    data class QueueUpdated(val items: List<QueueItem>) : RoomEvent
    data class InteractionRequested(val interaction: RoomInteraction) : RoomEvent
    data class InteractionResolved(val kind: RequiredAction, val id: String) : RoomEvent
    data class RoomUpdated(val name: String?, val totalTokens: Long?, val workspace: String?) : RoomEvent
    data class RoomCleared(val totalTokens: Long) : RoomEvent
    data class SummaryUpdated(val summary: RoomSummary) : RoomEvent
    data class HandoffUpdated(val chain: HandoffChain) : RoomEvent
    /** Older history loaded with `load_messages` (prepended). */
    data class HistoryLoaded(val messages: List<GroupMessage>, val hasMore: Boolean) : RoomEvent
}

/** The open room, as the screen sees it. */
data class RoomState(
    val room: RoomInfo,
    val messages: List<GroupMessage> = emptyList(),
    val agents: List<RoomAgent> = emptyList(),
    val members: List<RoomMember> = emptyList(),
    val handoffs: List<HandoffChain> = emptyList(),
    val hasMore: Boolean = false,
    val live: Boolean = false,
    val kicked: Boolean = false,
    /** agentId → activity, only while not `ready`. */
    val activities: Map<String, AgentActivity> = emptyMap(),
    /** agentName → status while the agent compresses its context. */
    val contextStatuses: Map<String, String> = emptyMap(),
    /** userId → name of humans typing right now. */
    val typing: Map<String, String> = emptyMap(),
    val queue: List<QueueItem> = emptyList(),
    val interactions: List<RoomInteraction> = emptyList(),
    val summary: RoomSummary? = null,
) {
    val busyAgents: List<AgentActivity> get() = activities.values.filter { it.status != "ready" }
}

object GroupRoomReducer {
    fun reduce(state: RoomState, event: RoomEvent): RoomState = when (event) {
        is RoomEvent.Joined -> state.copy(
            room = event.snapshot.room.copy(agents = event.snapshot.agents.ifEmpty { event.snapshot.room.agents }),
            messages = mergeHistory(state.messages, event.snapshot.messages),
            agents = event.snapshot.agents.ifEmpty { state.agents },
            members = event.snapshot.members,
            handoffs = event.snapshot.handoffs.ifEmpty { state.handoffs },
            hasMore = event.snapshot.hasMore,
            live = true,
            kicked = false,
            queue = event.snapshot.executionQueue,
            interactions = (event.snapshot.pendingApprovals + event.snapshot.pendingClarifies).distinctBy { it.kind to it.id },
            activities = event.snapshot.activities.filter { it.status != "ready" }.associateBy { it.agentId },
            summary = event.snapshot.summary ?: state.summary,
        )
        RoomEvent.Dropped -> state.copy(live = false, typing = emptyMap())
        is RoomEvent.Failed -> state.copy(live = false)
        is RoomEvent.Posted -> state.copy(messages = upsert(state.messages, event.message.copy(streaming = false)))
        is RoomEvent.StreamStarted -> {
            // A fresh stream from the same agent replaces its empty placeholder rows.
            val cleaned = state.messages.filterNot {
                it.senderId == event.message.senderId && it.id != event.message.id && it.streaming && it.content.isBlank() && it.reasoning.isBlank()
            }
            val existing = cleaned.firstOrNull { it.id == event.message.id }
            val next = if (existing != null) {
                existing.copy(
                    content = event.message.content.ifBlank { existing.content },
                    reasoning = event.message.reasoning.ifBlank { existing.reasoning },
                    streaming = true,
                    runId = event.message.runId ?: existing.runId,
                )
            } else event.message.copy(streaming = true)
            state.copy(messages = upsert(cleaned, next))
        }
        is RoomEvent.StreamDelta -> state.copy(messages = state.messages.map { if (it.id == event.id) it.copy(content = it.content + event.delta, streaming = true) else it })
        is RoomEvent.ReasoningDelta -> state.copy(messages = state.messages.map { if (it.id == event.id) it.copy(reasoning = it.reasoning + event.delta, streaming = true) else it })
        is RoomEvent.StreamEnded -> state.copy(
            messages = state.messages.mapNotNull {
                when {
                    it.id != event.id -> it
                    it.content.isBlank() && it.reasoning.isBlank() -> null
                    else -> it.copy(streaming = false)
                }
            },
        )
        is RoomEvent.MessageRetracted -> state.copy(
            messages = state.messages.filterNot { it.id == event.messageId },
            room = event.totalTokens?.let { state.room.copy(totalTokens = it) } ?: state.room,
        )
        is RoomEvent.MembersChanged -> state.copy(members = event.members)
        RoomEvent.Kicked -> state.copy(kicked = true, live = false)
        is RoomEvent.AgentsUpdated -> state.copy(agents = event.agents, room = state.room.copy(agents = event.agents))
        is RoomEvent.Typing -> state.copy(typing = if (event.typing) state.typing + (event.userId to event.userName) else state.typing - event.userId)
        is RoomEvent.Activity -> state.copy(
            activities = if (event.activity.status == "ready") state.activities - event.activity.agentId else state.activities + (event.activity.agentId to event.activity),
            contextStatuses = if (event.activity.status == "ready") state.contextStatuses - event.activity.agentName else state.contextStatuses,
        )
        is RoomEvent.ContextStatus -> state.copy(
            contextStatuses = if (event.status == "ready") state.contextStatuses - event.agentName else state.contextStatuses + (event.agentName to event.status),
        )
        is RoomEvent.QueueUpdated -> state.copy(queue = event.items)
        is RoomEvent.InteractionRequested -> state.copy(
            interactions = state.interactions.filterNot { it.kind == event.interaction.kind && it.id == event.interaction.id } + event.interaction,
        )
        is RoomEvent.InteractionResolved -> state.copy(interactions = state.interactions.filterNot { it.kind == event.kind && it.id == event.id })
        is RoomEvent.RoomUpdated -> state.copy(
            room = state.room.copy(
                name = event.name ?: state.room.name,
                totalTokens = event.totalTokens ?: state.room.totalTokens,
                workspace = event.workspace ?: state.room.workspace,
            ),
        )
        is RoomEvent.RoomCleared -> state.copy(messages = emptyList(), hasMore = false, room = state.room.copy(totalTokens = event.totalTokens), activities = emptyMap(), queue = emptyList())
        is RoomEvent.SummaryUpdated -> state.copy(summary = event.summary)
        is RoomEvent.HandoffUpdated -> state.copy(handoffs = state.handoffs.filterNot { it.chainId == event.chain.chainId } + event.chain)
        is RoomEvent.HistoryLoaded -> state.copy(messages = mergeHistory(event.messages, state.messages), hasMore = event.hasMore)
    }

    /** Older rows first, then what we already had, without duplicating ids. */
    private fun mergeHistory(older: List<GroupMessage>, newer: List<GroupMessage>): List<GroupMessage> {
        val seen = HashSet<String>()
        return (older + newer).filter { seen.add(it.id) }
    }

    private fun upsert(messages: List<GroupMessage>, message: GroupMessage): List<GroupMessage> {
        val index = messages.indexOfFirst { it.id == message.id }
        if (index < 0) return messages + message
        val existing = messages[index]
        // A persisted final row must not lose streamed text the server elided.
        val merged = message.copy(
            content = message.content.ifBlank { existing.content },
            reasoning = message.reasoning.ifBlank { existing.reasoning },
            runId = message.runId ?: existing.runId,
        )
        return messages.toMutableList().apply { set(index, merged) }
    }
}

/**
 * The transcript rows: tool messages fold under the agent reply of the same
 * run (the web's GroupAgentRunCard), everything else becomes one [ChatLine].
 */
fun roomTranscript(state: RoomState, myUserId: String?, myName: String?): List<ChatLine> {
    val toolsByRun = LinkedHashMap<String, MutableList<ChatToolStep>>()
    val orphanTools = mutableListOf<GroupMessage>()
    state.messages.filter { it.isTool }.forEach { tool ->
        val key = tool.runId?.let { "${tool.senderId}:$it" }
        if (key == null) orphanTools += tool else toolsByRun.getOrPut(key) { mutableListOf() } += toolStep(tool)
    }
    val lines = mutableListOf<ChatLine>()
    val consumedRuns = HashSet<String>()
    state.messages.filterNot { it.isTool }.forEach { message ->
        val key = message.runId?.let { "${message.senderId}:$it" }
        val tools = if (key != null && consumedRuns.add(key)) toolsByRun[key].orEmpty() else emptyList()
        val fromMe = !message.isAgent && (message.senderId == myUserId || (myName != null && message.senderName == myName))
        lines += ChatLine(
            text = message.content,
            fromUser = fromMe,
            timestamp = message.timestamp.takeIf { it > 0 }?.toString(),
            sender = message.senderName,
            reasoning = message.reasoning.takeIf { it.isNotBlank() },
            streaming = message.streaming,
            tools = tools,
            startedAtMillis = message.timestamp.takeIf { it > 0 },
            finishedAtMillis = if (message.streaming) null else message.timestamp.takeIf { it > 0 },
            messageId = message.id,
        )
    }
    orphanTools.forEach { tool ->
        lines += ChatLine(text = "", fromUser = false, timestamp = tool.timestamp.takeIf { it > 0 }?.toString(), sender = tool.senderName, tools = listOf(toolStep(tool)), messageId = tool.id)
    }
    // Runs whose agent row never arrived still show their tools.
    toolsByRun.forEach { (key, tools) ->
        if (key !in consumedRuns) {
            val first = state.messages.firstOrNull { it.isTool && "${it.senderId}:${it.runId}" == key }
            lines += ChatLine(text = "", fromUser = false, sender = first?.senderName, tools = tools, messageId = "tools:$key", timestamp = first?.timestamp?.takeIf { it > 0 }?.toString())
        }
    }
    return lines.sortedBy { it.timestamp?.toLongOrNull() ?: Long.MAX_VALUE }
}

private fun toolStep(tool: GroupMessage): ChatToolStep = ChatToolStep(
    id = tool.toolCallId ?: tool.id,
    name = tool.toolName ?: "tool",
    detail = tool.toolPreview,
    status = when (tool.toolStatus) {
        "error", "interrupted" -> ToolRunStatus.Error
        "running" -> ToolRunStatus.Running
        else -> ToolRunStatus.Done
    },
    startedAtMillis = tool.timestamp,
    arguments = tool.toolArgs,
    output = tool.toolResult ?: tool.content.takeIf { it.isNotBlank() },
)

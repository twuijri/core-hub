package hub.core.android.rooms

import hub.core.android.chat.ChatMessage
import hub.core.android.realtime.Envelope
import hub.core.android.realtime.ROOMS_NAMESPACE
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Approval
import hub.core.client.model.ApprovalStatus
import hub.core.client.model.Member
import hub.core.client.model.Message
import hub.core.client.model.MessageRole
import hub.core.client.model.Room
import hub.core.client.model.RoomDetail
import hub.core.client.model.Run
import hub.core.client.model.Seat
import hub.core.client.model.SeatStatus
import hub.core.client.model.ToolCall
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** The room's own facts the screen needs: its name, who manages it, what may be said. */
data class RoomInfo(
    val id: String,
    val profile: String,
    val name: String,
    val canManage: Boolean,
    val canMentionAll: Boolean,
    val inviteCode: String?,
    val leadSeatId: String?,
    val archived: Boolean,
) {
    companion object {
        fun of(room: Room) = RoomInfo(
            room.id, room.profile, room.name, room.canManage, room.canMentionAll, room.inviteCode, room.leadSeatId, room.archivedAt != null,
        )

        fun of(room: RoomDetail) = RoomInfo(
            room.id, room.profile, room.name, room.canManage, room.canMentionAll, room.inviteCode, room.leadSeatId, room.archivedAt != null,
        )
    }
}

/**
 * One open room: its transcript (the contract's one `Message`, DECISIONS §1), its seats with
 * what each is doing, its people with who is here now, who is typing, and what the seats wait
 * for a person to answer.
 */
data class RoomState(
    val room: RoomInfo? = null,
    val seats: List<Seat> = emptyList(),
    val members: List<Member> = emptyList(),
    val messages: List<ChatMessage> = emptyList(),
    val approvals: Map<String, Approval> = emptyMap(),
    /** People typing now, by member id. */
    val typing: Map<String, String> = emptyMap(),
    /** The tool a seat's run is in right now, by run id. */
    val tools: Map<String, String> = emptyMap(),
    val deleted: Boolean = false,
) {
    /** Seats doing something now: queued, thinking, replying or waiting for a person. */
    val busySeats: List<Seat> get() = seats.filter { it.status != SeatStatus.IDLE && it.status != SeatStatus.OFFLINE }

    val mentionSeats: List<RoomMentions.Seat> get() = seats.map { RoomMentions.Seat(it.id, it.name) }

    /** The step a seat is on: the tool of its live reply, when it reported one. */
    fun stepOf(seat: Seat): String? =
        messages.lastOrNull { it.streaming && it.authorName == seat.name }?.runId?.let { tools[it] }
}

/** Pure transitions of [RoomState]; the view model feeds it HTTP documents and `/rt/rooms` envelopes. */
object RoomReducer {
    private val json = Serializer.kotlinxSerializationJson

    private fun <T> JsonObject.decode(key: String, serializer: KSerializer<T>): T? =
        this[key]?.let { runCatching { json.decodeFromJsonElement(serializer, it) }.getOrNull() }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    /** The room and a page of its messages, as read over HTTP on open and after a reconnect. */
    fun loaded(state: RoomState, detail: RoomDetail, messages: List<Message>): RoomState {
        val fresh = messages.map(ChatMessage::from).associateBy { it.id }
        // Anything that arrived live while the page was on its way stays.
        val newer = state.messages.filter { it.id !in fresh && it.seq > (messages.maxOfOrNull { m -> m.seq } ?: 0) }
        return state.copy(
            room = RoomInfo.of(detail),
            seats = detail.seats,
            members = detail.members,
            messages = (fresh.values + newer).sortedBy { it.seq },
            approvals = detail.pendingApprovals.filter { it.status == ApprovalStatus.PENDING }.associateBy { it.id },
            typing = detail.typing.associate { it.memberId to it.name },
        )
    }

    fun olderLoaded(state: RoomState, older: List<Message>): RoomState {
        val known = state.messages.map { it.id }.toSet()
        return state.copy(messages = (older.filter { it.id !in known }.map(ChatMessage::from) + state.messages).sortedBy { it.seq })
    }

    fun apply(state: RoomState, envelope: Envelope): RoomState {
        val room = state.room ?: return state
        if (envelope.namespace != ROOMS_NAMESPACE) return state
        val p = envelope.payload
        val ours = { id: String? -> id == room.id }
        return when (envelope.event) {
            "message.created" -> p.decode("message", Message.serializer())?.takeIf { ours(it.roomId) }
                ?.let { state.upsert(ChatMessage.from(it)) } ?: state
            "message.delta" -> state.edit(p.string("message_id")) { it.copy(text = it.text + p.string("delta").orEmpty(), streaming = true) }
            "reasoning.delta" -> state.edit(p.string("message_id")) { it.copy(reasoning = it.reasoning + p.string("delta").orEmpty(), streaming = true) }
            "tool.started", "tool.completed", "tool.failed" -> {
                val call = p.decode("tool_call", ToolCall.serializer()) ?: return state
                val messageId = p.string("message_id")
                if (state.messages.none { it.id == messageId }) return state
                val runId = p.string("run_id")
                val edited = state.edit(messageId) { m ->
                    val calls = if (m.toolCalls.any { it.id == call.id }) m.toolCalls.map { if (it.id == call.id) call else it } else m.toolCalls + call
                    m.copy(toolCalls = calls)
                }
                if (runId == null) edited
                else if (envelope.event == "tool.started") edited.copy(tools = edited.tools + (runId to call.name))
                else edited.copy(tools = edited.tools - runId)
            }
            "run.completed" -> {
                val run = p.decode("run", Run.serializer())
                val message = p.decode("message", Message.serializer())?.takeIf { ours(it.roomId) }
                if (run != null && !ours(run.roomId) && message == null) return state
                val ended = state.endRun(run)
                if (message != null) ended.upsert(ChatMessage.from(message).copy(streaming = false)) else ended
            }
            "run.failed", "run.cancelled" -> {
                val run = p.decode("run", Run.serializer()) ?: return state
                if (!ours(run.roomId)) state else state.endRun(run)
            }
            "seat.added", "seat.updated" -> {
                if (!ours(p.string("room_id"))) return state
                val seat = p.decode("seat", Seat.serializer()) ?: return state
                val rest = state.seats.filter { it.id != seat.id }
                val index = state.seats.indexOfFirst { it.id == seat.id }
                state.copy(seats = if (index < 0) rest + seat else state.seats.map { if (it.id == seat.id) seat else it })
            }
            "seat.removed" -> {
                if (!ours(p.string("room_id"))) return state
                val seat = p.decode("seat", Seat.serializer()) ?: return state
                state.copy(seats = state.seats.filter { it.id != seat.id })
            }
            "member.joined" -> {
                if (!ours(p.string("room_id"))) return state
                val member = p.decode("member", Member.serializer()) ?: return state
                state.copy(members = state.members.filter { it.id != member.id } + member)
            }
            "member.left" -> {
                if (!ours(p.string("room_id"))) return state
                val member = p.decode("member", Member.serializer()) ?: return state
                state.copy(members = state.members.filter { it.id != member.id }, typing = state.typing - member.id)
            }
            "member.typing" -> {
                if (!ours(p.string("room_id"))) return state
                val id = p.string("member_id") ?: return state
                val typing = (p["typing"] as? JsonPrimitive)?.booleanOrNull == true
                state.copy(typing = if (typing) state.typing + (id to p.string("name").orEmpty()) else state.typing - id)
            }
            "room.updated" -> {
                val updated = p.decode("room", Room.serializer())?.takeIf { ours(it.id) } ?: return state
                state.copy(room = RoomInfo.of(updated), seats = updated.seats)
            }
            "room.deleted" -> if (ours(p.string("room_id"))) state.copy(deleted = true) else state
            "approval.requested" -> p.decode("approval", Approval.serializer())
                ?.takeIf { ours(it.roomId) && it.status == ApprovalStatus.PENDING }
                ?.let { state.copy(approvals = state.approvals + (it.id to it)) } ?: state
            "approval.resolved" -> p.decode("approval", Approval.serializer())
                ?.let { state.copy(approvals = state.approvals - it.id) } ?: state
            else -> state
        }
    }

    private fun RoomState.upsert(message: ChatMessage): RoomState {
        val index = messages.indexOfFirst { it.id == message.id }
        val list = if (index >= 0) {
            messages.toMutableList().also { list ->
                val old = list[index]
                // A `message.created` shell must not wipe words that already streamed into it.
                list[index] = if (message.streaming && message.text.isEmpty() && old.text.isNotEmpty()) {
                    message.copy(text = old.text, reasoning = old.reasoning, toolCalls = old.toolCalls)
                } else message
            }
        } else messages + message
        return copy(messages = list.sortedBy { it.seq })
    }

    /** A delta for a message this room does not hold (another room's) changes nothing. */
    private fun RoomState.edit(messageId: String?, change: (ChatMessage) -> ChatMessage): RoomState {
        val index = messages.indexOfFirst { it.id == messageId }
        if (index < 0) return this
        return copy(messages = messages.toMutableList().also { it[index] = change(it[index]) })
    }

    private fun RoomState.endRun(run: Run?): RoomState {
        run ?: return this
        return copy(
            tools = tools - run.id,
            messages = messages.map { if (it.runId == run.id && it.streaming) it.copy(streaming = false) else it },
        )
    }
}

/**
 * A turn in a room: consecutive messages of one speaker. In a room "the other side" is several
 * speakers, so only your own messages are on the right; everyone else — people and agents — is
 * on the left under their name (DECISIONS §69).
 */
data class RoomTurn(val mine: Boolean, val turn: hub.core.android.chat.Turn)

object RoomTurns {
    fun group(messages: List<ChatMessage>, me: String?): List<RoomTurn> {
        val turns = mutableListOf<RoomTurn>()
        for (message in messages) {
            if (message.isEmpty) continue
            val mine = message.role == MessageRole.USER && me != null && message.authorId == me
            val last = turns.lastOrNull()
            if (last != null && last.mine == mine && last.turn.role == message.role && last.turn.authorName == message.authorName &&
                last.turn.messages.last().authorId == message.authorId
            ) {
                turns[turns.lastIndex] = last.copy(turn = last.turn.copy(messages = last.turn.messages + message))
            } else {
                turns += RoomTurn(mine, hub.core.android.chat.Turn(message.role, message.authorName, listOf(message)))
            }
        }
        return turns
    }
}

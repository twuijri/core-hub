package us.i3u.hermesstudio

import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.Polling
import io.socket.engineio.client.transports.WebSocket
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder

/**
 * A room, live, over the `/group-chat` namespace — the same events the web's
 * `stores/hermes/group-chat.ts` listens to. Group chat has no REST endpoint for
 * posting: joining, speaking, typing, interrupting and answering an agent's
 * approval or question all happen here. REST gives the history; this gives
 * everything after it.
 */
class GroupSocket(
    private var baseUrl: String,
    private var token: String,
) {
    private var socket: Socket? = null
    private var joinedRoom: String? = null
    private var producer: ProducerScope<RoomEvent>? = null

    fun update(baseUrl: String, token: String) {
        this.baseUrl = baseUrl.trimEnd('/')
        this.token = token
    }

    val connected: Boolean get() = socket?.connected() == true

    /**
     * Joins [roomId] as [memberName] (the signed-in account) and emits every
     * room event until the collector leaves. Reconnects rejoin automatically
     * and replay the snapshot as a fresh [RoomEvent.Joined].
     */
    fun join(roomId: String, memberName: String, profile: String, authUserId: Int?, historyLimit: Int = 80): Flow<RoomEvent> = callbackFlow {
        val auth = mutableMapOf("token" to token, "name" to memberName)
        if (authUserId != null && authUserId > 0) auth["authUserId"] = authUserId.toString()
        val options = IO.Options.builder()
            .setForceNew(true)
            .setReconnection(true)
            .setReconnectionAttempts(Int.MAX_VALUE)
            .setReconnectionDelay(1_000)
            .setReconnectionDelayMax(30_000)
            .setTransports(arrayOf(WebSocket.NAME, Polling.NAME))
            .setAuth(auth)
            .setQuery("profile=" + URLEncoder.encode(profile, "UTF-8"))
            .setTimeout(30_000)
            .build()

        // Same guard as the workflow socket: a bad base URL is an event, not a crash.
        val live = runCatching { IO.socket(URI.create(baseUrl.trimEnd('/') + "/group-chat"), options) }
            .getOrElse { failure ->
                trySend(RoomEvent.Failed(failure.message ?: "room socket unavailable"))
                close()
                return@callbackFlow
            }
        socket = live
        joinedRoom = roomId
        producer = this

        fun forRoom(args: Array<Any>): JSONObject? {
            val event = args.firstOrNull() as? JSONObject ?: return null
            val id = event.optString("roomId")
            return if (id.isBlank() || id == roomId) event else null
        }

        live.on(Socket.EVENT_CONNECT) {
            live.emit(
                "join",
                JSONObject().put("roomId", roomId).put("name", memberName).put("historyLimit", historyLimit),
                Ack { args ->
                    val ack = args.firstOrNull() as? JSONObject
                    val error = ack?.optString("error").orEmpty()
                    if (ack == null || error.isNotBlank()) {
                        trySend(RoomEvent.Failed(error.ifBlank { "join failed" }, ack?.optString("code")?.takeIf { it.isNotBlank() }))
                        close()
                        return@Ack
                    }
                    GroupJson.snapshot(ack, roomId)?.let { trySend(RoomEvent.Joined(it)) }
                    // Activities are not part of the ack; ask for them once joined.
                    live.emit("load_room_agent_activities", JSONObject(), Ack { reply ->
                        val list = (reply.firstOrNull() as? JSONObject)?.optJSONArray("activities") ?: JSONArray()
                        for (i in 0 until list.length()) {
                            list.optJSONObject(i)?.let(GroupJson::activity)?.takeIf { it.status != "ready" }?.let { trySend(RoomEvent.Activity(it)) }
                        }
                    })
                },
            )
        }
        live.on(Socket.EVENT_DISCONNECT) { trySend(RoomEvent.Dropped) }
        live.on(Socket.EVENT_CONNECT_ERROR) { trySend(RoomEvent.Dropped) }
        live.on("message") { args -> forRoom(args)?.let(GroupJson::message)?.let { trySend(RoomEvent.Posted(it)) } }
        live.on("message_stream_start") { args -> forRoom(args)?.let(GroupJson::message)?.let { trySend(RoomEvent.StreamStarted(it)) } }
        live.on("message_stream_delta") { args -> forRoom(args)?.let { trySend(RoomEvent.StreamDelta(it.optString("id"), it.optString("delta"))) } }
        live.on("message_reasoning_delta") { args -> forRoom(args)?.let { trySend(RoomEvent.ReasoningDelta(it.optString("id"), it.optString("delta"))) } }
        live.on("message_stream_end") { args -> forRoom(args)?.let { trySend(RoomEvent.StreamEnded(it.optString("id"))) } }
        live.on("message_retracted") { args -> forRoom(args)?.let { trySend(RoomEvent.MessageRetracted(it.optString("messageId"), it.optLong("totalTokens", -1L).takeIf { t -> t >= 0 })) } }
        live.on("member_joined") { args -> forRoom(args)?.let { trySend(RoomEvent.MembersChanged(GroupJson.members(it.optJSONArray("members")))) } }
        live.on("member_left") { args -> forRoom(args)?.let { trySend(RoomEvent.MembersChanged(GroupJson.members(it.optJSONArray("members")))) } }
        live.on("member_updated") { args -> forRoom(args)?.let { trySend(RoomEvent.MembersChanged(GroupJson.members(it.optJSONArray("members")))) } }
        live.on("member_kicked") { args -> forRoom(args)?.let { trySend(RoomEvent.Kicked) } }
        live.on("agents_updated") { args -> forRoom(args)?.let { trySend(RoomEvent.AgentsUpdated(GroupJson.agents(it.optJSONArray("agents")))) } }
        live.on("typing") { args -> forRoom(args)?.let { trySend(RoomEvent.Typing(it.optString("userId"), it.optString("userName"), true)) } }
        live.on("stop_typing") { args -> forRoom(args)?.let { trySend(RoomEvent.Typing(it.optString("userId"), it.optString("userName"), false)) } }
        live.on("context_status") { args -> forRoom(args)?.let { trySend(RoomEvent.ContextStatus(it.optString("agentName"), it.optString("status"))) } }
        live.on("room_agent_activity") { args -> forRoom(args)?.let(GroupJson::activity)?.let { trySend(RoomEvent.Activity(it)) } }
        live.on("execution_queue_updated") { args -> forRoom(args)?.let { trySend(RoomEvent.QueueUpdated(GroupJson.queue(it.optJSONArray("items")))) } }
        live.on("approval.requested") { args -> forRoom(args)?.let(GroupJson::approval)?.let { trySend(RoomEvent.InteractionRequested(it)) } }
        live.on("approval.resolved") { args ->
            forRoom(args)?.let { if (it.optBoolean("resolved", true)) trySend(RoomEvent.InteractionResolved(RequiredAction.Approval, it.optString("approval_id"))) }
        }
        live.on("clarify.requested") { args -> forRoom(args)?.let(GroupJson::clarify)?.let { trySend(RoomEvent.InteractionRequested(it)) } }
        live.on("clarify.resolved") { args -> forRoom(args)?.let { trySend(RoomEvent.InteractionResolved(RequiredAction.Clarification, it.optString("clarify_id"))) } }
        live.on("room_updated") { args ->
            forRoom(args)?.let {
                trySend(
                    RoomEvent.RoomUpdated(
                        name = it.optString("name").takeIf { n -> n.isNotBlank() },
                        totalTokens = if (it.has("totalTokens")) it.optLong("totalTokens") else null,
                        workspace = if (it.has("workspace")) it.optString("workspace") else null,
                    ),
                )
            }
        }
        live.on("room_cleared") { args -> forRoom(args)?.let { trySend(RoomEvent.RoomCleared(it.optLong("totalTokens", 0L))) } }
        live.on("room_summary_updated") { args -> forRoom(args)?.let(GroupJson::summary)?.let { trySend(RoomEvent.SummaryUpdated(it)) } }
        live.on("handoff_updated") { args -> forRoom(args)?.let(GroupJson::handoff)?.let { trySend(RoomEvent.HandoffUpdated(it)) } }

        live.connect()

        awaitClose {
            live.off()
            live.disconnect()
            if (socket === live) {
                socket = null
                joinedRoom = null
                producer = null
            }
        }
    }

    private fun emitWithAck(event: String, payload: JSONObject, onResult: (error: String?, reply: JSONObject?) -> Unit): Boolean {
        val live = socket ?: return false
        if (!live.connected()) return false
        live.emit(
            event,
            payload,
            Ack { args ->
                val reply = args.firstOrNull() as? JSONObject
                val error = reply?.optString("error").orEmpty()
                onResult(error.ifBlank { null }, reply)
            },
        )
        return true
    }

    /**
     * Posts into the joined room. Attachments become the same content blocks
     * the web sends (`text` + `image`/`file` with the stored path).
     */
    fun post(roomId: String, text: String, attachments: List<Upload> = emptyList(), mentionAll: Boolean = false, onResult: (error: String?) -> Unit = {}): Boolean {
        val content: Any = if (attachments.isEmpty()) text else JSONArray().apply {
            if (text.isNotBlank()) put(JSONObject().put("type", "text").put("text", text))
            attachments.forEach { file ->
                put(
                    JSONObject()
                        .put("type", if (file.mime.startsWith("image/")) "image" else "file")
                        .put("name", file.name)
                        .put("path", file.path)
                        .put("media_type", file.mime),
                )
            }
        }
        val payload = JSONObject().put("roomId", roomId).put("id", AppUploads.newId(24)).put("content", content)
        if (mentionAll) payload.put("mentions", JSONArray().put(JSONObject().put("type", "all").put("displayName", "all")))
        return emitWithAck("message", payload) { error, _ -> onResult(error) }
    }

    /** `load_messages` with the oldest loaded id as the cursor; the reply is delivered as [RoomEvent.HistoryLoaded]. */
    fun loadOlder(roomId: String, before: String, limit: Int = 60): Boolean =
        emitWithAck("load_messages", JSONObject().put("roomId", roomId).put("before", before).put("limit", limit).put("history", true)) { error, reply ->
            val scope = producer ?: return@emitWithAck
            if (error != null) scope.trySend(RoomEvent.Failed(error))
            else scope.trySend(RoomEvent.HistoryLoaded(GroupJson.messages(reply?.optJSONArray("messages")), reply?.optBoolean("hasMore", false) ?: false))
        }

    fun typing(roomId: String, typing: Boolean) {
        val live = socket ?: return
        if (live.connected()) live.emit(if (typing) "typing" else "stop_typing", JSONObject().put("roomId", roomId))
    }

    fun interrupt(roomId: String, agentName: String, onResult: (error: String?) -> Unit): Boolean =
        emitWithAck("interrupt_agent", JSONObject().put("roomId", roomId).put("agentName", agentName)) { error, _ -> onResult(error) }

    fun respondApproval(roomId: String, approvalId: String, choice: String, onResult: (error: String?) -> Unit): Boolean =
        emitWithAck("approval.respond", JSONObject().put("roomId", roomId).put("approval_id", approvalId).put("choice", choice)) { error, _ -> onResult(error) }

    fun respondClarify(roomId: String, clarifyId: String, response: String, onResult: (error: String?) -> Unit): Boolean =
        emitWithAck("clarify.respond", JSONObject().put("roomId", roomId).put("clarify_id", clarifyId).put("response", response)) { error, _ -> onResult(error) }

    fun cancelQueueItem(roomId: String, queueId: String, onResult: (error: String?) -> Unit): Boolean =
        emitWithAck("cancel_execution_queue_item", JSONObject().put("roomId", roomId).put("queueId", queueId)) { error, _ -> onResult(error) }
}

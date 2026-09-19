package us.i3u.hermesstudio

import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.Polling
import io.socket.engineio.client.transports.WebSocket
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder

/** Live run status from the `/workflow` namespace. */
sealed interface WorkflowEvent {
    data object Connected : WorkflowEvent
    data object Dropped : WorkflowEvent
    data class Failed(val error: String) : WorkflowEvent
    /** The subscribe ack (every status at once) or one `workflow.status.updated`. */
    data class Statuses(val statuses: List<WorkflowLiveStatus>) : WorkflowEvent
    data class StatusError(val workflowId: String, val error: String) : WorkflowEvent
}

/**
 * The workflow socket the web's `api/studio/workflow-socket.ts` opens:
 * `workflow.status.subscribe` (ack: the current statuses) then a stream of
 * `workflow.status.updated` snapshots with per-node states and pending
 * approvals — what keeps the list chips and the run timeline moving.
 */
class WorkflowSocket(
    private var baseUrl: String,
    private var token: String,
) {
    fun update(baseUrl: String, token: String) {
        this.baseUrl = baseUrl.trimEnd('/')
        this.token = token
    }

    /** Subscribes to one workflow (or every one the user can see when [workflowId] is null). */
    fun subscribe(profile: String, workflowId: String? = null): Flow<WorkflowEvent> = callbackFlow {
        val options = IO.Options.builder()
            .setForceNew(true)
            .setReconnection(true)
            .setReconnectionAttempts(Int.MAX_VALUE)
            .setReconnectionDelay(1_000)
            .setReconnectionDelayMax(30_000)
            .setTransports(arrayOf(WebSocket.NAME, Polling.NAME))
            .setAuth(mapOf("token" to token))
            .setQuery("profile=" + URLEncoder.encode(profile, "UTF-8"))
            .setTimeout(30_000)
            .build()
        // A blank or malformed base URL must surface as an event, not as an
        // exception thrown out of the flow builder onto the main thread.
        val live = runCatching { IO.socket(URI.create(baseUrl.trimEnd('/') + "/workflow"), options) }
            .getOrElse { failure ->
                trySend(WorkflowEvent.Failed(failure.message ?: "workflow socket unavailable"))
                close()
                return@callbackFlow
            }

        live.on(Socket.EVENT_CONNECT) {
            trySend(WorkflowEvent.Connected)
            val request = JSONObject().apply { if (!workflowId.isNullOrBlank()) put("workflowId", workflowId) }
            live.emit(
                "workflow.status.subscribe",
                request,
                Ack { args ->
                    val ack = args.firstOrNull() as? JSONObject
                    if (ack == null || !ack.optBoolean("ok", false)) {
                        trySend(WorkflowEvent.Failed(ack?.optString("error").orEmpty().ifBlank { "workflow subscribe failed" }))
                        return@Ack
                    }
                    val list = ack.optJSONObject("data")?.optJSONArray("statuses") ?: JSONArray()
                    trySend(WorkflowEvent.Statuses((0 until list.length()).mapNotNull { list.optJSONObject(it)?.let(WorkflowJson::status) }))
                },
            )
        }
        live.on(Socket.EVENT_DISCONNECT) { trySend(WorkflowEvent.Dropped) }
        live.on(Socket.EVENT_CONNECT_ERROR) { trySend(WorkflowEvent.Dropped) }
        live.on("workflow.status.updated") { args ->
            (args.firstOrNull() as? JSONObject)?.let(WorkflowJson::status)?.let { trySend(WorkflowEvent.Statuses(listOf(it))) }
        }
        live.on("workflow.status.error") { args ->
            (args.firstOrNull() as? JSONObject)?.let { trySend(WorkflowEvent.StatusError(it.optString("workflowId"), it.optString("error"))) }
        }
        live.connect()

        awaitClose {
            live.off()
            live.disconnect()
        }
    }
}

package hub.core.android.realtime

import hub.core.android.data.StoredSession
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.Polling
import io.socket.engineio.client.transports.WebSocket
import java.net.URI
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import org.json.JSONObject

/** Engine path of every namespace (docs/ARCHITECTURE.md §Realtime). */
const val SOCKET_PATH = "/rt"
const val SESSIONS_NAMESPACE = "/rt/sessions"
const val DEVICES_NAMESPACE = "/rt/devices"
const val TASKS_NAMESPACE = "/rt/tasks"
const val SCHEDULES_NAMESPACE = "/rt/schedules"

/** One realtime message: the envelope of packages/contracts/events/README.md. */
data class Envelope(
    val event: String,
    val namespace: String,
    val profile: String?,
    val seq: Long,
    val ts: String,
    val payload: JsonObject,
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** Null for anything that is not an envelope (a malformed or foreign message). */
        fun parse(text: String): Envelope? {
            val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
            fun prim(key: String) = obj[key] as? JsonPrimitive
            val event = prim("event")?.contentOrNull ?: return null
            val namespace = prim("namespace")?.contentOrNull ?: return null
            val seq = prim("seq")?.longOrNull ?: return null
            val ts = prim("ts")?.contentOrNull ?: return null
            val payload = obj["payload"] as? JsonObject ?: return null
            val profile = prim("profile")?.takeIf { it.isString }?.contentOrNull
            return Envelope(event, namespace, profile, seq, ts, payload)
        }
    }
}

/**
 * The envelope in what the Java client hands an `onAnyIncoming` listener: the event's name
 * first, then its single argument (a live hub showed the name comes first — reading only the
 * first argument dropped every event).
 */
fun envelopeOf(args: Array<out Any?>): Envelope? {
    val payload = args.firstOrNull { it is JSONObject } as? JSONObject ?: return null
    return Envelope.parse(payload.toString())
}

/** The answer to `subscribe`: `{ ok, replayed, truncated }` or `{ ok: false, error, code }`. */
data class SubscribeAck(val ok: Boolean, val replayed: Int = 0, val truncated: Boolean = false, val code: String? = null) {
    companion object {
        fun parse(text: String?): SubscribeAck {
            val obj = text?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
                ?: return SubscribeAck(false, code = "no_answer")
            fun prim(key: String) = obj[key] as? JsonPrimitive
            return SubscribeAck(
                ok = prim("ok")?.booleanOrNull == true,
                replayed = prim("replayed")?.intOrNull ?: 0,
                truncated = prim("truncated")?.booleanOrNull == true,
                code = prim("code")?.contentOrNull,
            )
        }
    }
}

/**
 * The app's sockets to one hub. `/rt/sessions`, `/rt/tasks` and `/rt/schedules` join every
 * profile the person may enter (`profiles: 'all'`, ADR 0016) because the chats list, the Tasks
 * board and Schedules show them all; `/rt/devices` carries the person's own notices.
 *
 * Socket.IO reconnects with backoff capped at 30 s, as the contract asks; after a reconnect
 * [reconnects] ticks so an open chat re-subscribes with `after_seq`. A refused handshake is
 * not retried by Socket.IO: [refused] carries its code so the owner of the token can renew it
 * and call [connect] again.
 */
class Realtime(private val http: OkHttpClient) {
    private val sockets = mutableMapOf<String, Socket>()
    /** Namespaces subscribed to with `{}`: subscribed again on every (re)connect. */
    private val wholeNamespaces = mutableSetOf<String>()
    private var connectedAs: String? = null
    private val _events = MutableSharedFlow<Envelope>(extraBufferCapacity = 512)
    val events: SharedFlow<Envelope> = _events.asSharedFlow()
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()
    private val _reconnects = MutableStateFlow(0)
    val reconnects: StateFlow<Int> = _reconnects.asStateFlow()
    private val _refused = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val refused: SharedFlow<String> = _refused.asSharedFlow()

    /**
     * Opens the sockets for this hub, person and profile. A token that merely rotated does not
     * reconnect a live socket; [force] does, after a refused handshake was answered with a
     * fresh token.
     */
    @Synchronized
    fun connect(session: StoredSession, force: Boolean = false) {
        val identity = "${session.hub}|${session.user.id}|${session.profile}"
        if (identity == connectedAs && !force) return
        close()
        connectedAs = identity
        for (namespace in listOf(SESSIONS_NAMESPACE, DEVICES_NAMESPACE, TASKS_NAMESPACE, SCHEDULES_NAMESPACE)) {
            sockets[namespace] = open(session, namespace)
        }
    }

    private fun open(session: StoredSession, namespace: String): Socket {
        val auth = buildMap {
            put("token", session.accessToken)
            if (namespace != DEVICES_NAMESPACE) {
                put("profile", session.profile)
                put("profiles", "all")
            }
        }
        val options = IO.Options.builder()
            .setPath(SOCKET_PATH)
            .setTransports(arrayOf(WebSocket.NAME, Polling.NAME))
            .setReconnection(true)
            .setReconnectionDelay(1_000)
            .setReconnectionDelayMax(30_000)
            .setTimeout(10_000)
            .setAuth(auth)
            .build()
        options.callFactory = http
        options.webSocketFactory = http
        val socket = IO.socket(URI.create(session.hub + namespace), options)
        var everConnected = false
        socket.on(Socket.EVENT_CONNECT) {
            if (synchronized(this) { namespace in wholeNamespaces }) socket.emit("subscribe", JSONObject())
            if (namespace == SESSIONS_NAMESPACE) {
                _connected.value = true
                if (everConnected) _reconnects.value += 1
                everConnected = true
            }
        }
        socket.on(Socket.EVENT_DISCONNECT) { if (namespace == SESSIONS_NAMESPACE) _connected.value = false }
        socket.on(Socket.EVENT_CONNECT_ERROR) { args ->
            if (namespace == SESSIONS_NAMESPACE) _connected.value = false
            val code = (args.firstOrNull() as? Exception)?.message
                ?: (args.firstOrNull() as? JSONObject)?.optString("message")
            if (code in REFUSALS) _refused.tryEmit(code!!)
        }
        socket.onAnyIncoming { args -> envelopeOf(args)?.let { _events.tryEmit(it) } }
        socket.connect()
        return socket
    }

    /** `subscribe { session_id, after_seq? }` on `/rt/sessions`; null when the socket is not up. */
    suspend fun subscribe(sessionId: String, afterSeq: Long): SubscribeAck? {
        val socket = synchronized(this) { sockets[SESSIONS_NAMESPACE] } ?: return null
        if (!socket.connected()) return null
        val body = JSONObject().put("session_id", sessionId)
        if (afterSeq > 0) body.put("after_seq", afterSeq)
        return withTimeoutOrNull(10_000) {
            suspendCancellableCoroutine { cont ->
                socket.emit("subscribe", arrayOf<Any>(body), Ack { args ->
                    if (cont.isActive) cont.resume(SubscribeAck.parse(args.firstOrNull()?.toString()))
                })
            }
        }
    }

    fun unsubscribe(sessionId: String) {
        synchronized(this) { sockets[SESSIONS_NAMESPACE] }?.emit("unsubscribe", JSONObject().put("session_id", sessionId))
    }

    /**
     * `subscribe {}` on `/rt/tasks` or `/rt/schedules`: every event of the profiles joined, now
     * and after every reconnect.
     */
    fun subscribeAll(namespace: String) {
        val socket = synchronized(this) {
            wholeNamespaces += namespace
            sockets[namespace]
        }
        if (socket?.connected() == true) socket.emit("subscribe", JSONObject())
    }

    @Synchronized
    fun close() {
        sockets.values.forEach { it.off(); it.disconnect() }
        sockets.clear()
        connectedAs = null
        _connected.value = false
    }

    private companion object {
        val REFUSALS = setOf("unauthorized", "token_expired", "profile_not_found")
    }
}

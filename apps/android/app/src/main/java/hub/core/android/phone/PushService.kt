package hub.core.android.phone

import android.content.Context
import android.os.Build
import android.util.Log
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import hub.core.android.BuildConfig
import hub.core.android.data.StoredSession
import hub.core.android.graph
import hub.core.client.model.DeviceKind
import hub.core.client.model.DevicePlatform
import hub.core.client.model.DeviceRegistration
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** How this phone describes itself to the hub (pairing and `devices.register` alike). */
fun thisPhone(deviceKey: String, name: String = "${Build.MANUFACTURER} ${Build.MODEL}") = DeviceRegistration(
    deviceKey = deviceKey,
    name = name.trim().ifEmpty { Build.MODEL ?: "Android" }.take(80),
    platform = DevicePlatform.ANDROID,
    kind = DeviceKind.PHONE,
    brand = Build.MANUFACTURER,
    model = Build.MODEL,
    appVersion = BuildConfig.VERSION_NAME,
    capabilities = emptyList(),
)

/**
 * FCM on this phone. Only a build made with `google-services.json` (the signed build) has a
 * Firebase project; any other build — a pull request, a fork, a local debug build — has none,
 * says so on This device, and keeps polling. FCM's own auto-init is off (AndroidManifest.xml),
 * so no token exists before someone signs in, and none is kept after they sign out.
 *
 * It uses FCM registration tokens (`getToken`, `deleteToken`, `onNewToken`), which Firebase
 * Messaging 25.1 marks deprecated in favour of registering by installation id (`register()`,
 * `onRegistered`). The hub's FCM sender addresses a registration token (HTTP v1
 * `message.token`), so the app stays on tokens until the hub can send the other way.
 */
@Suppress("DEPRECATION")
class PushManager(
    private val context: Context,
    private val registrar: PushRegistrar,
    private val language: () -> String,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(if (available()) PushState.IDLE else PushState.NOT_IN_BUILD)
    val state: StateFlow<PushState> = _state.asStateFlow()
    private val lock = Mutex()

    /** True while the hub pushes to this phone; the background check is off then. */
    val active: Boolean get() = _state.value == PushState.ACTIVE

    private fun available(): Boolean =
        BuildConfig.FIREBASE && runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)

    /** After each sign-in, and at each launch while signed in. */
    fun refresh() {
        if (!available()) return
        scope.launch {
            val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrElse {
                Log.w(TAG, "no FCM token: ${it.javaClass.simpleName}")
                _state.value = PushState.FAILED
                return@launch
            }
            register(token)
        }
    }

    /** Firebase rotated the token (PushService.onNewToken). */
    fun onNewToken(token: String) {
        if (!available()) return
        scope.launch { register(token) }
    }

    private suspend fun register(token: String) = lock.withLock {
        _state.value = when (val outcome = registrar.register(token, language())) {
            is PushRegistrar.Outcome.Registered -> PushState.ACTIVE
            PushRegistrar.Outcome.NoSender -> PushState.NO_SENDER
            PushRegistrar.Outcome.SignedOut -> PushState.IDLE
            is PushRegistrar.Outcome.Failed -> {
                Log.w(TAG, "push registration refused: ${outcome.error.status} ${outcome.error.code}")
                PushState.FAILED
            }
        }
    }

    /** Before signing out, while the token still works: the hub stops pushing to this phone. */
    suspend fun signOut(session: StoredSession) {
        registrar.unregister(session)
        forget()
    }

    /**
     * Signed out by the person or by the hub: the FCM token is deleted, so a hub that still has it
     * gets `UNREGISTERED` on its next push and forgets it; the next sign-in makes a new one.
     */
    fun forget() {
        if (!available()) return
        _state.value = PushState.IDLE
        runCatching { FirebaseMessaging.getInstance().deleteToken() }
    }

    private companion object {
        const val TAG = "CoreHubPush"
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnCompleteListener { task ->
        val error = task.exception
        if (error != null) cont.resumeWithException(error)
        else if (task.isCanceled) cont.cancel()
        else cont.resume(task.result)
    }
}

/**
 * Receives FCM. With the app in the background the system shows a push itself (channel
 * `notices`, tagged with the notice id) and a tap opens MainActivity with the push's `data` as
 * extras; this service sees a push only while the app is in front, where the app's own screens
 * show notices and nothing is posted — the same rule as a notice from the socket.
 */
class PushService : FirebaseMessagingService() {
    @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
    override fun onNewToken(token: String) {
        applicationContext.graph.push.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val graph = applicationContext.graph
        if (graph.inForeground()) return
        val data = message.data
        val id = data[PushPayload.NOTICE_ID] ?: return
        val path = PushPayload.path(data) ?: return
        val title = message.notification?.title ?: return
        Notifier(applicationContext).post(id, title, message.notification?.body, path)
    }
}

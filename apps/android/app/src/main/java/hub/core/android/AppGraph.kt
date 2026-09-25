package hub.core.android

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import hub.core.android.data.HttpClients
import hub.core.android.data.HubApis
import hub.core.android.data.KeystoreSealer
import hub.core.android.data.SecureStore
import hub.core.android.data.SessionStore
import hub.core.android.data.StoredSession
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import hub.core.android.phone.DeviceSettings
import hub.core.android.phone.NoticeTracker
import hub.core.android.phone.NoticeWorker
import hub.core.android.phone.Notifier
import hub.core.android.phone.Speaker
import hub.core.android.realtime.DEVICES_NAMESPACE
import hub.core.android.realtime.Realtime
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Notice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import hub.core.android.ui.theme.ThemeChoice
import java.util.Locale
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** The two UI languages; content direction is decided per message, not by this. */
enum class AppLanguage(val tag: String) {
    AR("ar"), EN("en");

    companion object {
        fun of(tag: String?): AppLanguage? = entries.firstOrNull { it.tag == tag }
        fun system(): AppLanguage = if (Locale.getDefault().language == "ar") AR else EN
    }
}

/** Local preferences of this install (NAVIGATION.md §1 footer chips: language and theme). */
class AppPrefs(private val prefs: SharedPreferences) {
    /** Null follows the phone's language. */
    var language: AppLanguage?
        get() = AppLanguage.of(prefs.getString(KEY_LANGUAGE, null))
        set(value) = prefs.edit().putString(KEY_LANGUAGE, value?.tag).apply()

    val effectiveLanguage: AppLanguage get() = language ?: AppLanguage.system()

    private val _theme = MutableStateFlow(
        runCatching { ThemeChoice.valueOf(prefs.getString(KEY_THEME, null) ?: "") }.getOrDefault(ThemeChoice.SYSTEM),
    )
    val theme: StateFlow<ThemeChoice> = _theme.asStateFlow()

    fun setTheme(choice: ThemeChoice) {
        prefs.edit().putString(KEY_THEME, choice.name).apply()
        _theme.value = choice
    }

    private companion object {
        const val KEY_LANGUAGE = "language"
        const val KEY_THEME = "theme"
    }
}

/** Everything long-lived the screens share, made once per process. */
class AppGraph(context: Context) {
    val prefs = AppPrefs(context.getSharedPreferences("corehub.prefs", Context.MODE_PRIVATE))
    val store = SessionStore(
        SecureStore(context.getSharedPreferences("corehub.secure", Context.MODE_PRIVATE), KeystoreSealer()),
    )
    private val _signedOut = MutableSharedFlow<String?>(extraBufferCapacity = 4)

    /** Emits when the hub ended the session (revoked, expired): the reason code, if any. */
    val signedOut: SharedFlow<String?> = _signedOut.asSharedFlow()
    val http = HttpClients(store, { prefs.effectiveLanguage.tag }) { reason -> _signedOut.tryEmit(reason) }
    val realtime = Realtime(http.plain)

    /** This phone's own choices (This device), kept on the phone. */
    val device = DeviceSettings(context.getSharedPreferences("corehub.device", Context.MODE_PRIVATE))
    val speaker = Speaker(context)
    private val notifier = Notifier(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** True while a screen of the app is visible. */
    fun inForeground(): Boolean = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    init {
        notifier.ensureChannel()
        // While the process lives, a notice the hub announces becomes a notification when no screen shows it.
        scope.launch {
            realtime.events.collect { e ->
                if (e.namespace != DEVICES_NAMESPACE || e.event != "notice.created") return@collect
                val notice = e.payload["notice"]?.let {
                    runCatching { Serializer.kotlinxSerializationJson.decodeFromJsonElement(Notice.serializer(), it) }.getOrNull()
                } ?: return@collect
                if (!inForeground()) notifier.post(notice)
                device.noticesSeenAt = NoticeTracker.seenAfter(listOf(notice), device.noticesSeenAt)
            }
        }
        // The background check runs while someone is signed in and This device allows it.
        scope.launch {
            store.session.map { it != null }.distinctUntilChanged().collect { signedIn ->
                runCatching { NoticeWorker.schedule(context, signedIn && device.choices.value.backgroundNotices) }
            }
        }
    }

    /**
     * The first message of a chat created from the draft, waiting for the conversation screen:
     * it subscribes before it sends, so not one event of the first reply is missed.
     */
    val outbox = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** Text another app shared to Core Hub, waiting to become a new chat's draft. */
    val sharedText = MutableStateFlow<String?>(null)

    private var apisFor: String? = null
    private var cachedApis: HubApis? = null

    /** The generated API of the signed-in hub. */
    @Synchronized
    fun apis(session: StoredSession): HubApis {
        if (apisFor != session.hub || cachedApis == null) {
            cachedApis = HubApis(session.hub, http.authed)
            apisFor = session.hub
        }
        return cachedApis!!
    }

    /** An API with no credentials, for sign-in, first-run setup and claiming a pairing. */
    fun anonymous(hub: String) = HubApis(hub, http.plain)
}

class CoreHubApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

val Context.graph: AppGraph get() = (applicationContext as CoreHubApp).graph

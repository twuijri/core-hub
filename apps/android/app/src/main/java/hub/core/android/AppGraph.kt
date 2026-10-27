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
import hub.core.android.phone.DeviceProof
import hub.core.android.phone.DeviceSettings
import hub.core.android.phone.KeystoreProofKeys
import hub.core.android.phone.NoticeTracker
import hub.core.android.phone.NoticeWorker
import hub.core.android.phone.Notifier
import hub.core.android.phone.PushManager
import hub.core.android.phone.PushRegistrar
import hub.core.android.phone.PushState
import hub.core.android.phone.DeviceInfos
import hub.core.android.phone.thisPhone
import hub.core.android.phone.thisPhoneReport
import hub.core.android.data.hubCall
import hub.core.android.phone.Speaker
import hub.core.android.realtime.DEVICES_NAMESPACE
import hub.core.android.realtime.Realtime
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Notice
import hub.core.client.model.PushBlocker
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import hub.core.android.generated.LanguageInfo
import hub.core.android.generated.Languages
import hub.core.android.ui.theme.ThemeChoice
import java.util.Locale
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A UI language of the registry (locales/languages.json, ADR 0028), generated into [Languages];
 * content direction is decided per message, not by this. Arabic and English are always there.
 */
class AppLanguage private constructor(val info: LanguageInfo) {
    val tag: String get() = info.code

    /**
     * The locale its resources are filed under: the tag itself, but for Android's own reserved
     * pseudo-locales, whose test-only words (debug build) are filed as en-XL and ar-XR.
     */
    val resourceTag: String get() = when (tag) {
        "en-XA" -> "en-XL"
        "ar-XB" -> "ar-XR"
        else -> tag
    }
    val rtl: Boolean get() = info.rtl

    /**
     * The contract's `Locale` (`ar` | `en`) nearest to this language: the hub stores it and writes
     * its own notices in it (DECISIONS §130). The first of the two on the fallback chain.
     */
    val hubLocale: String
        get() = (listOf(tag) + info.fallback + "en").first { it == "ar" || it == "en" }

    override fun equals(other: Any?) = other is AppLanguage && other.tag == tag
    override fun hashCode() = tag.hashCode()
    override fun toString() = tag

    companion object {
        /** Every language a person can choose, in the registry's order. */
        val entries: List<AppLanguage> = Languages.all.map(::AppLanguage)
        val AR: AppLanguage = entries.first { it.tag == "ar" }
        val EN: AppLanguage = entries.first { it.tag == "en" }

        /**
         * A registered language by its tag — or a test-only pseudo-locale (en-XA, ar-XB, zh-XC,
         * th-XD), whose words exist in the debug build only and which no picker lists.
         */
        fun of(tag: String?): AppLanguage? =
            entries.firstOrNull { it.tag == tag } ?: Languages.pseudo.firstOrNull { it.code == tag }?.let(::AppLanguage)

        /**
         * The registered language for a locale: the exact tag, the language with its script
         * (`zh-TW` → `zh-Hant`), the bare language, then any variant of it.
         */
        fun match(locale: Locale): AppLanguage? {
            val script = locale.script.ifEmpty {
                when {
                    locale.language == "zh" && locale.country in setOf("TW", "HK", "MO") -> "Hant"
                    locale.language == "zh" -> "Hans"
                    else -> ""
                }
            }
            val candidates = listOfNotNull(
                locale.toLanguageTag(),
                if (script.isNotEmpty() && locale.country.isNotEmpty()) "${locale.language}-$script-${locale.country}" else null,
                if (script.isNotEmpty()) "${locale.language}-$script" else null,
                if (locale.country.isNotEmpty()) "${locale.language}-${locale.country}" else null,
                locale.language,
            )
            for (candidate in candidates) entries.firstOrNull { it.tag.equals(candidate, ignoreCase = true) }?.let { return it }
            return entries.firstOrNull { it.tag.substringBefore('-') == locale.language }
        }

        /** The phone's language (not the process default, which follows the app's choice: [Digits.useAppLocale]). */
        fun system(): AppLanguage = match(Digits.phoneLocales()[0]) ?: EN

        /** What the one-press language switch goes to: the other of two languages, else the next. */
        fun next(current: AppLanguage): AppLanguage = entries[(entries.indexOf(current) + 1) % entries.size]
    }
}

/** Local preferences of this install (NAVIGATION.md §1 footer chips: language and theme). */
class AppPrefs(private val prefs: SharedPreferences) {
    /** Called when the in-app language changes: the graph tells Android's per-app setting. */
    var onLanguageChanged: ((AppLanguage?) -> Unit)? = null

    /** Null follows the phone's language. */
    var language: AppLanguage?
        get() = AppLanguage.of(prefs.getString(KEY_LANGUAGE, null))
        set(value) {
            prefs.edit().putString(KEY_LANGUAGE, value?.tag).apply()
            onLanguageChanged?.invoke(value)
        }

    /** Android's per-app language (13+), which the graph reads from the system. */
    var perApp: (() -> AppLanguage?)? = null

    val effectiveLanguage: AppLanguage get() = perApp?.invoke() ?: language ?: AppLanguage.system()

    private val _theme = MutableStateFlow(
        runCatching { ThemeChoice.valueOf(prefs.getString(KEY_THEME, null) ?: "") }.getOrDefault(ThemeChoice.SYSTEM),
    )
    val theme: StateFlow<ThemeChoice> = _theme.asStateFlow()

    fun setTheme(choice: ThemeChoice) {
        prefs.edit().putString(KEY_THEME, choice.name).apply()
        _theme.value = choice
    }

    /** The line under a channel composer, put away on this phone once read (owner, 2026-10-27). */
    var channelSendHintHidden: Boolean
        get() = prefs.getBoolean(KEY_CHANNEL_HINT, false)
        set(value) {
            prefs.edit().putBoolean(KEY_CHANNEL_HINT, value).apply()
        }

    private companion object {
        const val KEY_LANGUAGE = "language"
        const val KEY_THEME = "theme"
        const val KEY_CHANNEL_HINT = "channel_send_hint_hidden"
    }
}

/**
 * Everything long-lived the screens share, made once per process. [sealer] guards the stored
 * tokens: the Android Keystore in the app; the JVM screenshot tests hand in their own.
 */
class AppGraph(
    context: Context,
    sealer: hub.core.android.data.Sealer = KeystoreSealer(),
    /** Where self-update asks for the latest release: GitHub; the screenshot tests hand in their own. */
    releaseSource: hub.core.android.phone.ReleaseSource? = null,
) {
    val prefs = AppPrefs(context.getSharedPreferences("corehub.prefs", Context.MODE_PRIVATE))
        .also { prefs ->
            prefs.onLanguageChanged = { Digits.publishAppLanguage(context, it) }
            prefs.perApp = { Digits.perAppLanguage(context) }
        }
    /** The order the person dragged the chats into, per view (ChatOrder.kt). */
    val chatOrder = hub.core.android.ui.screens.ChatOrderStore(context.getSharedPreferences("corehub.chatorder", Context.MODE_PRIVATE))
    /** Which drawer groups («Tools») are closed on this device (nav/SidebarGroups.kt). */
    val sidebarGroups = hub.core.android.nav.SidebarGroupsStore(context.getSharedPreferences("corehub.prefs", Context.MODE_PRIVATE))
    val store = SessionStore(
        SecureStore(context.getSharedPreferences("corehub.secure", Context.MODE_PRIVATE), sealer),
    )
    private val _signedOut = MutableSharedFlow<String?>(extraBufferCapacity = 4)

    /** Emits when the hub ended the session (revoked, expired): the reason code, if any. */
    val signedOut: SharedFlow<String?> = _signedOut.asSharedFlow()
    val http = HttpClients(store, { prefs.effectiveLanguage.tag }) { reason -> _signedOut.tryEmit(reason) }
    val realtime = Realtime(http.plain)

    /** The agents of each profile, for their names, marks and pictures (`ui/components/AgentIdentity.kt`). */
    val agents = hub.core.android.ui.components.AgentDirectory(this)

    /** This phone's own choices (This device), kept on the phone. */
    val device = DeviceSettings(context.getSharedPreferences("corehub.device", Context.MODE_PRIVATE))
    val speaker = Speaker(context)
    private val notifier = Notifier(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** This install's key for the push relay's device proof (DeviceProof.kt). */
    private val proofKeys = KeystoreProofKeys()

    /** FCM: registered with the hub while someone is signed in, when this build has Firebase. */
    val push = PushManager(
        context,
        PushRegistrar(store, { apis(it) }, { token -> DeviceProof.proof(proofKeys, "fcm", token) }) {
            thisPhone(store.deviceKey, DeviceInfos.current(context).name, pushBlocker())
        },
        // The contract's Locale is Arabic or English: the nearest of the two (DECISIONS §130).
        { prefs.effectiveLanguage.hubLocale },
        scope,
    )

    private val appContext: Context = context.applicationContext ?: context

    /** What stops push on this phone right now (the hub shows it on the device's card). */
    fun pushBlocker(): PushBlocker = DeviceInfos.pushBlocker(
        inBuild = push.inBuild,
        notificationsAllowed = NotificationManagerCompat.from(appContext).areNotificationsEnabled(),
        // Refused once (or turned off): Android will not ask again, so it is the person's choice.
        asked = device.notificationsDenied,
        sdk = android.os.Build.VERSION.SDK_INT,
    )

    /** Tells the hub what this phone is now; at each launch, after the permission answer, and when the location choice changes. */
    fun reportDevice() {
        val capabilities = listOf(hub.core.android.phone.Locating.capability(locationChoices.choice.value))
        scope.launch { push.registrar.report(thisPhoneReport(pushBlocker(), DeviceInfos.current(appContext), capabilities)) }
    }

    /** Whether agents may ask where this phone is (§105): asked once, kept here. */
    val locationChoices = hub.core.android.phone.LocationChoices(context.getSharedPreferences("corehub.device", Context.MODE_PRIVATE))

    /** Location requests to answer, from `/rt/devices` and the catch-up when the app comes back. */
    val locations = hub.core.android.phone.LocationRequests(
        { store.current?.let { apis(it) to it } },
        locationChoices,
    ) { hub.core.android.phone.PhoneLocation.read(appContext) }

    /** True while a screen of the app is visible. */
    fun inForeground(): Boolean = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    /**
     * Self-update from the public repository's GitHub releases (SelfUpdate.kt): off in a build for
     * Google Play (`BuildConfig.SELF_UPDATE`). Its own HTTP client: nothing of the hub's goes to GitHub.
     */
    private val github = okhttp3.OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    val updates = hub.core.android.phone.SelfUpdate(
        appContext,
        hub.core.android.phone.UpdateChecker(
            enabled = BuildConfig.SELF_UPDATE,
            current = BuildConfig.VERSION_NAME,
            store = hub.core.android.phone.PrefsUpdateStore(context.getSharedPreferences("corehub.updates", Context.MODE_PRIVATE)),
            source = releaseSource ?: hub.core.android.phone.GitHubReleases(github, BuildConfig.VERSION_NAME),
        ),
        hub.core.android.phone.ApkDownloader(github),
        scope,
        ::inForeground,
    )

    init {
        notifier.ensureChannel()
        // While the process lives, a notice the hub announces becomes a notification when no screen shows it.
        scope.launch {
            realtime.events.collect { e ->
                hub.core.android.realtime.JobsFeed.receive(e)
                hub.core.android.phone.Locating.requestOf(e)?.let { request -> launch { locations.heard(request) } }
                if (e.namespace != DEVICES_NAMESPACE || e.event != "notice.created") return@collect
                val notice = e.payload["notice"]?.let {
                    runCatching { Serializer.kotlinxSerializationJson.decodeFromJsonElement(Notice.serializer(), it) }.getOrNull()
                } ?: return@collect
                // With push active the hub's push shows it (the same notification slot, AppGraph.push).
                if (!inForeground() && !push.active) notifier.post(notice)
                device.noticesSeenAt = NoticeTracker.seenAfter(listOf(notice), device.noticesSeenAt)
            }
        }
    }

    /**
     * The first message of a chat created from the draft, waiting for the conversation screen:
     * it subscribes before it sends, so not one event of the first reply is missed.
     */
    val outbox = java.util.concurrent.ConcurrentHashMap<String, hub.core.android.chat.Outgoing>()

    /** Text another app shared to Core Hub, waiting to become a new chat's draft. */
    val sharedText = MutableStateFlow<String?>(null)

    /** Pictures and files another app shared, copied into the cache, waiting for the new chat's tray. */
    val sharedFiles = MutableStateFlow<List<hub.core.android.phone.Share.SharedFile>>(emptyList())

    /** Profile files made attachments on the hub, waiting for the chat the Files page opens. */
    val handOff = hub.core.android.chat.AttachmentHandOff()

    /** The files of messages, fetched once into the cache and opened from there (chat/HubFiles.kt). */
    val files = hub.core.android.chat.FileDownloads(
        hub.core.android.chat.HubFileFetcher(http.authed, java.io.File(appContext.cacheDir, "attachments")),
        { store.current?.hub },
        scope,
    )

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

    /**
     * Ends the session on this phone. Push goes first, while the token still works, so the hub
     * stops pushing here; then the hub's sign-out when [logout] (moving to another hub by a new
     * pairing only forgets this one).
     */
    suspend fun signOut(logout: Boolean = true) {
        val session = store.current ?: return
        push.signOut(session)
        if (logout) hubCall { apis(session).auth.authLogout() }
        realtime.close()
        agents.forget()
        store.save(null)
    }

    init {
        // Push is registered for each sign-in (and again at each launch); a sign-out the hub
        // decided (a revoked device, an expired session) deletes the FCM token.
        scope.launch {
            store.session.map { s -> s?.let { it.hub to it.user.id } }.distinctUntilChanged().collect { who ->
                if (who != null) {
                    reportDevice()
                    push.refresh()
                } else {
                    push.forget()
                }
            }
        }
        // Back in front: push is tried again when it was not set up — the hub may have been given
        // a sender since, or the network is back (not only at the next cold launch).
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            androidx.lifecycle.LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_START && store.current != null &&
                    hub.core.android.phone.PushStatus.retriesOnForeground(push.state.value)
                ) {
                    push.refresh()
                }
                // A location request asked while the app was closed waits to be answered.
                if (event == Lifecycle.Event.ON_START && store.current != null) scope.launch { locations.catchUp() }
            },
        )
        // The background check runs while someone is signed in, This device allows it, and push
        // is not already carrying the notices.
        scope.launch {
            combine(
                store.session.map { it != null },
                device.choices.map { it.backgroundNotices },
                push.state,
            ) { signedIn, background, state -> signedIn && background && state != PushState.ACTIVE }
                .distinctUntilChanged()
                .collect { on -> runCatching { NoticeWorker.schedule(context, on) } }
        }
    }
}

open class CoreHubApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        // Latin digits in background work too (notifications, workers): DECISIONS §113.
        Locale.setDefault(Digits.latin(Locale.getDefault()))
        graph = makeGraph()
        // …and the app's language for dates and month names there too, not the phone's.
        runCatching { Digits.useAppLocale(graph.prefs.language) }
    }

    /** The graph of this process; the screenshot tests' application builds it without the Keystore. */
    protected open fun makeGraph(): AppGraph = AppGraph(this)
}

val Context.graph: AppGraph get() = (applicationContext as CoreHubApp).graph

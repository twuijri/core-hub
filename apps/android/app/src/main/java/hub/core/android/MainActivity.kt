package hub.core.android

import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.MenuItem
import androidx.compose.foundation.layout.fillMaxWidth
import android.content.Context
import android.content.Intent
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import hub.core.android.data.DeepLink
import hub.core.android.data.PairingRequest
import hub.core.android.nav.AppPaths
import hub.core.android.nav.Navigator
import hub.core.android.nav.Route
import hub.core.android.ui.screens.ChatScreen
import hub.core.android.ui.screens.PendingButton
import hub.core.android.ui.screens.RoomScreen
import hub.core.android.ui.screens.ConnectScreen
import hub.core.android.ui.screens.MainShell
import hub.core.android.nav.Screens
import hub.core.android.ui.screens.AdminOnly
import hub.core.android.ui.screens.AgentPageScreen
import hub.core.android.ui.screens.AgentsScreen
import hub.core.android.ui.screens.GlobalAgentScreen
import hub.core.android.ui.screens.PlaceholderScreen
import hub.core.android.ui.screens.SchedulesScreen
import hub.core.android.ui.screens.SearchScreen
import hub.core.android.ui.screens.SettingsPageScreen
import hub.core.android.ui.screens.SettingsScreen
import hub.core.android.ui.screens.TasksScreen
import hub.core.android.phone.PushPayload
import hub.core.android.phone.Share
import hub.core.android.phone.ThisDevicePage
import hub.core.android.ui.screens.ShellViewModel
import hub.core.android.ui.screens.TopBar
import hub.core.android.ui.screens.term
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.LocalTokens
import java.util.Locale

class MainActivity : ComponentActivity() {
    private var pendingPairing by mutableStateOf<PairingRequest?>(null)
    private var pendingPath by mutableStateOf<String?>(null)

    /** The in-app language (the footer's language chip) wins over the phone's. */
    override fun attachBaseContext(base: Context) {
        val language = (base.applicationContext as? CoreHubApp)?.graph?.prefs?.language
        if (language == null) {
            super.attachBaseContext(base)
            return
        }
        val locale = Locale.forLanguageTag(language.tag)
        val config = Configuration(base.resources.configuration)
        config.setLocale(locale)
        config.setLayoutDirection(locale)
        super.attachBaseContext(base.createConfigurationContext(config))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent {
            val theme by graph.prefs.theme.collectAsState()
            CoreHubTheme(theme) {
                // The system bars' icons follow the app's theme, not only the phone's.
                val dark = hub.core.android.ui.theme.LocalDarkTheme.current
                LaunchedEffect(dark) {
                    val style = if (dark) androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                    else androidx.activity.SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                    enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
                }
                Box(Modifier.fillMaxSize().background(LocalTokens.current.bg)) {
                    AppRoot(pendingPairing, { pendingPairing = null }, pendingPath, { pendingPath = null })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        // «Share to Core Hub»: the shared text becomes a new chat's draft, pictures and files its
        // attachments. The streams are read now, while this activity holds the permission to.
        Share.textOf(intent)?.let { graph.sharedText.value = it }
        val streams = Share.streamsOf(intent)
        if (streams.isNotEmpty()) {
            lifecycleScope.launch {
                val files = withContext(Dispatchers.IO) { streams.mapNotNull { copyShared(it) } }
                if (files.isNotEmpty()) graph.sharedFiles.value = graph.sharedFiles.value + files
                // The chat opens for files alone too.
                if (graph.sharedText.value == null) graph.sharedText.value = ""
            }
        }
        // A push the system showed (the app was in the background): FCM opens this activity with
        // the push's `data` as extras; the tap leads where the notice is about.
        pushExtras(intent)?.let(PushPayload::path)?.let {
            pendingPath = it
            return
        }
        val data = intent?.dataString ?: return
        when (val link = DeepLink.parse(data)) {
            is DeepLink.Pair -> pendingPairing = link.request
            is DeepLink.Open -> pendingPath = link.path
            else -> Unit
        }
    }

    /** A shared stream as a file the tray can upload: a picture as the + menu would take it (smaller, or its original). */
    private fun copyShared(uri: android.net.Uri): Share.SharedFile? {
        val name = hub.core.android.ui.components.PickedFiles.displayName(this, uri)
        val image = Share.isImage(contentResolver.getType(uri), name)
        if (image && !graph.device.choices.value.photoOriginal) {
            hub.core.android.ui.components.PickedFiles.photo(this, uri)?.let { (file, thumb) -> return Share.SharedFile(file, true, thumb) }
        }
        val file = hub.core.android.ui.components.PickedFiles.copy(this, uri) ?: return null
        return Share.SharedFile(file, image, if (image) hub.core.android.ui.components.PickedFiles.thumbnail(file) else null)
    }

    private fun pushExtras(intent: Intent?): Map<String, String?>? {
        val extras = intent?.extras ?: return null
        if (extras.getString(PushPayload.TYPE) == null) return null
        return PushPayload.KEYS.associateWith { extras.getString(it) }
    }
}

@Composable
private fun AppRoot(pendingPairing: PairingRequest?, onPairingHandled: () -> Unit, pendingPath: String?, onPathHandled: () -> Unit) {
    val graph = androidx.compose.ui.platform.LocalContext.current.graph
    val session by graph.store.session.collectAsState()
    if (session == null) {
        ConnectScreen(pendingPairing, onPairingHandled)
        return
    }
    val leave = androidx.compose.runtime.rememberCoroutineScope()
    if (pendingPairing != null) {
        // Already signed in: pairing again moves this phone to that hub, so ask first.
        ConfirmDialog(
            title = stringResource(R.string.pair_switch_title),
            body = stringResource(R.string.pair_switch_body, pendingPairing.hub),
            confirm = stringResource(R.string.pair_switch_confirm),
            onConfirm = { leave.launch { graph.signOut(logout = false) } },
            onDismiss = onPairingHandled,
        )
    }
    val nav = remember(session?.hub, session?.user?.id) { Navigator() }
    val shared by graph.sharedText.collectAsState()
    LaunchedEffect(shared) { if (shared != null) nav.go(Route.NewChat) }
    // While Android has not asked yet: once a launch, never again after a no (NotificationAsk).
    hub.core.android.phone.NotificationPermission()
    // An agent asked where this phone is: the person answers here (§105).
    hub.core.android.phone.LocationConsent()
    // `corehub://open/<path>`: the same paths as the web (surfaceRoutes.android).
    LaunchedEffect(pendingPath) {
        val path = pendingPath ?: return@LaunchedEffect
        AppPaths.resolve(path)?.let { AppPaths.route(it, session!!.profile) }?.let(nav::go)
        onPathHandled()
    }
    MainShell(nav) { route, navigator, shell, openDrawer -> Destination(route, navigator, shell, openDrawer) }
}

/** What each route draws. Pages not built on the phone yet say so plainly. */
@Composable
private fun Destination(route: Route, nav: Navigator, shell: ShellViewModel, openDrawer: () -> Unit) {
    val session by shell.session.collectAsState()
    // Read so a profile's name replaces its slug once the list arrives (shell.profileName).
    shell.profiles.collectAsState().value
    val s = session ?: return
    Column(Modifier.fillMaxSize().navigationBarsPadding().testTag("screen.${route.destination}")) {
        when (route) {
            Route.NewChat -> {
                // The page itself names the profile the chat will be made in (as on iOS).
                TopBar(term("new_chat"), onMenu = openDrawer) { PendingButton(shell, nav) }
                ChatScreen(null, s.profile, shell.profileName(s.profile), onCreated = { id, profile -> nav.go(Route.Chat(id, profile)) })
            }
            is Route.Chat -> {
                val chats by shell.chats.collectAsState()
                val chat = chats.items.firstOrNull { it.id == route.sessionId }
                val title = chat?.title ?: term("new_chat")
                // The top bar names the conversation and wears its agent's face (as the web's header).
                val agents = hub.core.android.ui.components.rememberAgents(route.profile)
                val agent = agents.firstOrNull { it.id == chat?.agentId }
                TopBar(
                    title, onMenu = openDrawer,
                    subtitle = listOfNotNull(agent?.name, if (route.profile != s.profile) shell.profileName(route.profile) else null)
                        .joinToString(" · ").ifEmpty { null },
                ) {
                    PendingButton(shell, nav)
                    ExportButton(shell, route.sessionId, route.profile, title)
                }
                ChatScreen(route.sessionId, route.profile, shell.profileName(route.profile), onCreated = { _, _ -> })
            }
            is Route.Room -> {
                RoomScreen(
                    route.roomId, route.profile,
                    subtitle = if (route.profile != s.profile) shell.profileName(route.profile) else null,
                    onMenu = openDrawer,
                    onGone = { nav.go(Route.NewChat) },
                ) { PendingButton(shell, nav) }
            }
            Route.Search -> {
                TopBar(term("search"), onMenu = openDrawer)
                SearchScreen(shell, onOpen = nav::go)
            }
            Route.Agents -> {
                TopBar(term("agent_manager"), onMenu = openDrawer, subtitle = shell.profileName(s.profile))
                AdminOnly(s.user.isAdmin, onRefused = { nav.go(Route.NewChat) }) { AgentsScreen(s.profile, onOpen = nav::go) }
            }
            is Route.AgentPage -> {
                TopBar(term(titleOf(route)), onMenu = null, onBack = { if (!nav.back()) nav.go(Route.Agents) }, subtitle = shell.profileName(s.profile))
                AdminOnly(s.user.isAdmin, onRefused = { nav.go(Route.NewChat) }) {
                    AgentPageScreen(route, s.profile, onOpen = { nav.back(); nav.go(it) }, onBackToAgents = { nav.go(Route.Agents) })
                }
            }
            Route.Tasks -> {
                TopBar(term("tasks"), onMenu = openDrawer)
                TasksScreen(shell, onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) })
            }
            Route.Schedules -> {
                TopBar(term("schedules"), onMenu = openDrawer)
                SchedulesScreen(shell, onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) })
            }
            Route.Settings -> {
                TopBar(term("settings"), onMenu = openDrawer)
                SettingsScreen(s.user.isAdmin, onOpen = nav::go, onBackToChats = nav::backToChats)
            }
            is Route.SettingsPage -> {
                TopBar(term(route.destination), onMenu = null, onBack = { if (!nav.back()) nav.go(Route.Settings) })
                if (Screens.visible(route.destination, s.user.isAdmin)) {
                    SettingsPageScreen(route.destination, shell, onOpen = nav::go) { ThisDevicePage(shell) }
                } else {
                    PlaceholderScreen(term(route.destination), stringResource(R.string.admin_only))
                }
            }
            is Route.GlobalAgent -> {
                val profile = route.profile ?: s.profile
                TopBar(term("global_agent"), onMenu = openDrawer, subtitle = shell.profileName(profile))
                GlobalAgentScreen(profile, shell.profileName(profile))
            }
        }
    }
}

/** The navigation term a route's title uses (`destinations[].title` in navigation.json). */
fun titleOf(route: Route): String = when (route) {
    is Route.AgentPage -> when (route.destination) {
        "agent_settings" -> "agent_settings"
        else -> route.destination.removePrefix("agent_")
    }
    else -> route.destination
}

/**
 * The conversation's «⋮»: Export, which asks the hub for the chat's Markdown transcript
 * (`sessions.export`) and hands it to the share sheet.
 */
@Composable
private fun ExportButton(shell: ShellViewModel, sessionId: String, profile: String, title: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var open by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    var failed by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    androidx.compose.foundation.layout.Box {
        HubIconButton(Lucide.Ellipsis, stringResource(R.string.chat_more), { open = true }, kind = IconKind.Glass, modifier = Modifier.testTag("chat.more"))
        HubMenu(open, { open = false }) {
            MenuItem(
                stringResource(R.string.chat_export), {
                    open = false
                    scope.launch {
                        val file = shell.exportChat(context, sessionId, profile, title)
                        if (file == null) failed = true
                        else hub.core.android.ui.components.AttachmentFiles.share(context, file, "text/markdown")
                    }
                },
                icon = Lucide.Share2,
                modifier = Modifier.testTag("chat.export"),
            )
        }
    }
    if (failed) {
        HubDialog({ failed = false }) {
            Text(stringResource(R.string.chat_export_failed))
            androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth(), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.End) {
                HubButton(stringResource(R.string.ok), { failed = false }, size = ControlSize.Md)
            }
        }
    }
}

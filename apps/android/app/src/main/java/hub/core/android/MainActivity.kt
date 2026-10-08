package hub.core.android

import hub.core.android.ui.kit.ConfirmDialog
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import android.content.Context
import android.content.Intent
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
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
import hub.core.android.ui.screens.NewTaskButton
import hub.core.android.ui.screens.TasksScreen
import hub.core.android.phone.PushPayload
import hub.core.android.phone.Share
import hub.core.android.phone.ThisDevicePage
import hub.core.android.ui.screens.ShellViewModel
import hub.core.android.ui.screens.TopBar
import hub.core.android.ui.screens.term
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.LocalTokens

class MainActivity : ComponentActivity() {
    private var pendingPairing by mutableStateOf<PairingRequest?>(null)
    private var pendingPath by mutableStateOf<String?>(null)

    /**
     * The in-app language (the footer's language chip) wins over the phone's, and digits are
     * Latin in both (DECISIONS §113) — also when the app follows an Arabic phone.
     */
    override fun attachBaseContext(base: Context) {
        // Android's per-app language (13+) and the in-app one are kept the same (AppPrefs); the
        // system's wins if a person changed it in Android's settings since.
        val language = Digits.perAppLanguage(base) ?: (base.applicationContext as? CoreHubApp)?.graph?.prefs?.language
        super.attachBaseContext(Digits.wrap(base, language))
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

    /** Each return to the app may look for a newer release (at most every six hours, SelfUpdate.kt). */
    override fun onStart() {
        super.onStart()
        graph.updates.onForeground()
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
        AppPaths.resolve(path)?.let { target ->
            val route = AppPaths.route(target, session!!.profile) ?: return@let
            // A workflow run named in the path opens on its page (nav/Focus.kt).
            AppPaths.focus(target, session!!.profile)?.let { hub.core.android.nav.Focus.item.value = it }
            nav.go(route)
        }
        onPathHandled()
    }
    // Links to this hub's own pages in a reply open here (nav/HubLinks.kt); a room invite opens Join.
    val display by hub.core.android.ui.screens.HubDisplay.prefs.collectAsState()
    val openInApp: (String) -> Boolean = open@{ uri ->
        val s = graph.store.current ?: return@open false
        // The person may have chosen the browser for links (Display → where links open).
        if (!hub.core.android.ui.screens.HubDisplay.linksInApp(display)) return@open false
        when (val link = hub.core.android.nav.HubLinks.target(uri, s.hub, s.profile)) {
            is hub.core.android.nav.InAppLink.Page -> {
                link.focus?.let { hub.core.android.nav.Focus.item.value = it }
                nav.go(link.route)
                true
            }
            is hub.core.android.nav.InAppLink.Join -> { hub.core.android.nav.HubLinks.joinCode.value = link.code; true }
            null -> false
        }
    }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val scale = hub.core.android.ui.screens.HubDisplay.textScale(display)
    androidx.compose.runtime.CompositionLocalProvider(
        hub.core.android.nav.LocalOpenInApp provides openInApp,
        hub.core.android.ui.screens.LocalChatDisplay provides hub.core.android.ui.screens.HubDisplay.chat(display),
        // Text size (Display): every text of the app, over the phone's own font scale.
        androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(density.density, density.fontScale * scale),
    ) {
        MainShell(nav) { route, navigator, shell, openDrawer -> Destination(route, navigator, shell, openDrawer) }
    }
    hub.core.android.ui.screens.JoinFromLink(nav)
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
                TopBar(term("new_chat"), onMenu = openDrawer) {
                    PendingButton(shell, nav)
                    hub.core.android.ui.screens.BackgroundButton(shell, nav)
                }
                // A newer Core Hub on GitHub: Update or Later, under the top bar (SelfUpdate.kt).
                hub.core.android.phone.UpdateBanner(Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                ChatScreen(null, s.profile, shell.profileName(s.profile), onCreated = { id, profile -> nav.go(Route.Chat(id, profile)) })
            }
            is Route.Chat -> {
                val chats by shell.chats.collectAsState()
                val chat = chats.items.firstOrNull { it.id == route.sessionId }
                // The open chat's own title first: a rename shows even when the list filters it out.
                val live by hub.core.android.ui.screens.rememberChatViewModel(route.sessionId, route.profile).ui.collectAsState()
                val title = live.chat.session?.title ?: chat?.title ?: term("new_chat")
                // The top bar names the conversation and wears its agent's face (as the web's header).
                val agents = hub.core.android.ui.components.rememberAgents(route.profile)
                val agent = agents.firstOrNull { it.id == chat?.agentId }
                TopBar(
                    title, onMenu = openDrawer,
                    subtitle = listOfNotNull(agent?.name, if (route.profile != s.profile) shell.profileName(route.profile) else null)
                        .joinToString(" · ").ifEmpty { null },
                ) {
                    PendingButton(shell, nav)
                    hub.core.android.ui.screens.BackgroundButton(shell, nav)
                    // The context ring and running subagents (apps batch 6); their sheets live here too.
                    hub.core.android.ui.components.ChatInsightBar(route.sessionId, route.profile)
                    hub.core.android.ui.screens.ChatMenuButton(
                        shell, route.sessionId, route.profile, title,
                        onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) },
                        onGone = { nav.go(Route.NewChat) },
                    )
                }
                ChatScreen(
                    route.sessionId, route.profile, shell.profileName(route.profile), onCreated = { _, _ -> },
                    onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) },
                    onNewChat = { nav.go(Route.NewChat) },
                )
            }
            is Route.ChannelChat -> {
                // A Telegram or WhatsApp conversation Hermes keeps: an admin writes into it (§153), with Continue in Core Hub.
                hub.core.android.ui.screens.ChannelChatScreen(
                    route.conversationId, route.profile, shell, onMenu = openDrawer,
                    onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) },
                    onGone = { nav.go(Route.NewChat) },
                    subtitleProfile = if (route.profile != s.profile) shell.profileName(route.profile) else null,
                    onOpenConversation = { id, profile -> nav.go(Route.ChannelChat(id, profile)) },
                )
            }
            is Route.Room -> {
                RoomScreen(
                    route.roomId, route.profile,
                    subtitle = if (route.profile != s.profile) shell.profileName(route.profile) else null,
                    onMenu = openDrawer,
                    onGone = { nav.go(Route.NewChat) },
                ) {
                    PendingButton(shell, nav)
                    hub.core.android.ui.screens.BackgroundButton(shell, nav)
                }
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
                TopBar(term("tasks"), onMenu = openDrawer) { NewTaskButton() }
                TasksScreen(shell, onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) })
            }
            Route.Schedules -> {
                TopBar(term("schedules"), onMenu = openDrawer)
                SchedulesScreen(shell, onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) })
            }
            Route.Workflows -> {
                TopBar(term("workflows"), onMenu = openDrawer) { hub.core.android.ui.screens.NewWorkflowButton() }
                hub.core.android.ui.screens.WorkflowsList(shell, onOpenChat = { id, profile -> nav.go(Route.Chat(id, profile)) })
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
                GlobalAgentScreen(profile, shell.profileName(profile)) { sessionId ->
                    TopBar(term("global_agent"), onMenu = openDrawer, subtitle = shell.profileName(profile)) {
                        if (sessionId != null) {
                            hub.core.android.ui.components.ChatInsightBar(sessionId, profile)
                            hub.core.android.ui.screens.ChatMenuButton(
                                shell, sessionId, profile, term("global_agent"),
                                onOpenChat = { id, p -> nav.go(Route.Chat(id, p)) },
                                onGone = { nav.go(Route.NewChat) },
                            )
                        }
                    }
                }
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


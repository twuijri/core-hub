package hub.core.android

import android.content.Context
import android.content.Intent
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import hub.core.android.data.DeepLink
import hub.core.android.data.PairingRequest
import hub.core.android.nav.AppPaths
import hub.core.android.nav.Navigator
import hub.core.android.nav.Route
import hub.core.android.ui.screens.ChatScreen
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
import kotlinx.coroutines.launch
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
        // «Share to Core Hub»: the shared text becomes a new chat's draft.
        Share.textOf(intent)?.let { graph.sharedText.value = it }
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
        AlertDialog(
            onDismissRequest = onPairingHandled,
            title = { Text(stringResource(R.string.pair_switch_title)) },
            text = { Text(stringResource(R.string.pair_switch_body, pendingPairing.hub)) },
            confirmButton = {
                TextButton(onClick = { leave.launch { graph.signOut(logout = false) } }) { Text(stringResource(R.string.pair_switch_confirm)) }
            },
            dismissButton = { TextButton(onClick = onPairingHandled) { Text(stringResource(R.string.cancel)) } },
        )
    }
    val nav = remember(session?.hub, session?.user?.id) { Navigator() }
    val shared by graph.sharedText.collectAsState()
    LaunchedEffect(shared) { if (shared != null) nav.go(Route.NewChat) }
    // While Android has not asked yet: once a launch, never again after a no (NotificationAsk).
    hub.core.android.phone.NotificationPermission()
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
    val s = session ?: return
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        when (route) {
            Route.NewChat -> {
                TopBar(term("new_chat"), onMenu = openDrawer, subtitle = shell.profileName(s.profile))
                ChatScreen(null, s.profile, shell.profileName(s.profile), onCreated = { id, profile -> nav.go(Route.Chat(id, profile)) })
            }
            is Route.Chat -> {
                val chats by shell.chats.collectAsState()
                val title = chats.items.firstOrNull { it.id == route.sessionId }?.title ?: term("new_chat")
                TopBar(
                    title, onMenu = openDrawer,
                    subtitle = if (route.profile != s.profile) shell.profileName(route.profile) else null,
                )
                ChatScreen(route.sessionId, route.profile, shell.profileName(route.profile), onCreated = { _, _ -> })
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

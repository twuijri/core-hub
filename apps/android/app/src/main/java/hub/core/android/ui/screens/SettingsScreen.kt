package hub.core.android.ui.screens

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.AppLanguage
import hub.core.android.BuildConfig
import hub.core.android.R
import hub.core.android.data.TokenKind
import hub.core.android.data.hubCall
import hub.core.android.generated.Product
import hub.core.android.graph
import hub.core.android.nav.AppPaths
import hub.core.android.nav.Route
import hub.core.android.nav.Screens
import hub.core.android.ui.components.EmptyState
import hub.core.android.ui.components.ListRow
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.StatusBadge
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.ThemeChoice
import hub.core.client.model.NotifyMarkAllReadRequest
import hub.core.client.model.NotifyUpdateNoticeRequest
import hub.core.client.model.ResourceRef
import kotlinx.coroutines.launch

/** The Settings list's three groups, in the manifest's order (the parity test compares them). */
object SettingsList {
    val groups: List<Pair<Int?, List<String>>> = listOf(
        null to Screens.settingsTabs,
        R.string.settings_management to Screens.settingsManagement,
        R.string.settings_tools to Screens.settingsTools,
    )

    /** What this person sees: admin-only rows are hidden from members; This device is this surface's. */
    fun visible(isAdmin: Boolean): List<Pair<Int?, List<String>>> =
        groups.map { (title, rows) -> title to rows.filter { Screens.visible(it, isAdmin) } }

    /** The pages the phone draws itself; the rest open the same page on the web. */
    val native = setOf("account", "display", "notifications", "privacy", "this_device", "about", "theme", "workspaces", "users")
}

/**
 * Settings on the phone: the list is the page (NAVIGATION.md §2), headed by «Back to chats»,
 * which returns to the conversation that was open before Settings.
 */
@Composable
fun SettingsScreen(isAdmin: Boolean, onOpen: (Route) -> Unit, onBackToChats: () -> Unit) {
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item {
            TextButton(onClick = onBackToChats) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                Text(stringResource(R.string.settings_back_to_chats), modifier = Modifier.padding(start = 6.dp))
            }
        }
        SettingsList.visible(isAdmin).forEach { (title, rows) ->
            if (title != null) item(key = "h$title") {
                Text(stringResource(title), style = MaterialTheme.typography.labelLarge, color = LocalTokens.current.textMuted, modifier = Modifier.padding(top = 12.dp, start = 4.dp))
            }
            items(rows, key = { it }) { destination ->
                ListRow(term(destination), trailing = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) }, onClick = { onOpen(Route.SettingsPage(destination)) })
            }
        }
    }
}

/** One page under Settings; «Back to Settings» is the top bar's back arrow. */
@Composable
fun SettingsPageScreen(destination: String, shell: ShellViewModel, onOpen: (Route) -> Unit, thisDevice: @Composable () -> Unit) {
    when (destination) {
        "account" -> AccountPage(shell)
        "display", "theme" -> DisplayPage(showLanguage = destination == "display")
        "notifications" -> NotificationsPage(onOpen)
        "about" -> AboutPage()
        "workspaces" -> ProfilesPage()
        "users" -> UsersPage()
        "privacy" -> PrivacyPage()
        "this_device" -> thisDevice()
        else -> OnTheWebPage(destination)
    }
}

private fun LazyListScope.header(text: String) = item { Text(text, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp)) }

@Composable
private fun AccountPage(shell: ShellViewModel) {
    val session by shell.session.collectAsState()
    val s = session ?: return
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item { ListRow(s.user.displayName, "@${s.user.username}", trailing = { StatusBadge(s.user.role) }) }
        item { ListRow(stringResource(R.string.account_profiles), s.user.profiles.joinToString(" · ") { shell.profileName(it) }) }
        item { OutlinedButton(onClick = shell::signOut, modifier = Modifier.fillMaxWidth()) { Text(term("sign_out")) } }
    }
}

@Composable
private fun DisplayPage(showLanguage: Boolean) {
    val context = LocalContext.current
    val prefs = context.graph.prefs
    val theme by prefs.theme.collectAsState()
    val languageTitle = stringResource(R.string.display_language)
    val themeTitle = term("theme")
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (showLanguage) {
            header(languageTitle)
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(null to R.string.display_language_system, AppLanguage.AR to R.string.display_language_ar, AppLanguage.EN to R.string.display_language_en)
                        .forEach { (lang, label) ->
                            FilterChip(selected = prefs.language == lang, onClick = {
                                prefs.language = lang
                                (context as? Activity)?.recreate()
                            }, label = { Text(stringResource(label)) })
                        }
                }
            }
        }
        header(themeTitle)
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ThemeChoice.entries.forEach { choice ->
                    FilterChip(selected = theme == choice, onClick = { prefs.setTheme(choice) }, label = {
                        Text(stringResource(when (choice) { ThemeChoice.LIGHT -> R.string.theme_light; ThemeChoice.DARK -> R.string.theme_dark; ThemeChoice.SYSTEM -> R.string.theme_system }))
                    })
                }
            }
        }
    }
}

/** The notifications inbox: newest first, a tap marks one read and opens what it is about. */
@Composable
private fun NotificationsPage(onOpen: (Route) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val notices = rememberLoad { context.graph.apis(context.graph.store.current!!).notify.notifyListNotices(limit = 100).items }
    Column(Modifier.fillMaxSize()) {
        TextButton(onClick = {
            scope.launch {
                hubCall { context.graph.apis(context.graph.store.current!!).notify.notifyMarkAllRead(NotifyMarkAllReadRequest()) }
                notices.reload()
            }
        }, modifier = Modifier.padding(horizontal = 8.dp)) { Text(stringResource(R.string.notices_mark_all)) }
        LoadView(notices) { list ->
            if (list.isEmpty()) EmptyState(stringResource(R.string.notices_empty))
            LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(list, key = { it.id }) { notice ->
                    ListRow(
                        notice.title,
                        listOfNotNull(notice.body, localTime(notice.createdAt)).joinToString(" · "),
                        trailing = { if (notice.readAt == null) StatusBadge(stringResource(R.string.notices_new), Tone.INFO) },
                        onClick = {
                            scope.launch {
                                hubCall { context.graph.apis(context.graph.store.current!!).notify.notifyUpdateNotice(notice.id, NotifyUpdateNoticeRequest(read = true)) }
                                notices.reload()
                            }
                            NoticeLinks.route(notice.resource, notice.profile)?.let(onOpen)
                        },
                    )
                }
            }
        }
    }
}

/** Where a notice leads: its conversation, the board, or Schedules. */
object NoticeLinks {
    fun route(resource: ResourceRef?, profile: String?): Route? = when (resource?.kind) {
        ResourceRef.Kind.SESSION -> profile?.let { Route.Chat(resource.id, it) }
        ResourceRef.Kind.TASK, ResourceRef.Kind.PROJECT -> Route.Tasks
        ResourceRef.Kind.SCHEDULE, ResourceRef.Kind.SCHEDULE_RUN, ResourceRef.Kind.WORKFLOW_RUN -> Route.Schedules
        else -> null
    }
}

@Composable
private fun AboutPage() {
    val context = LocalContext.current
    val meta = rememberLoad { context.graph.apis(context.graph.store.current!!).meta.metaGet() }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item { ListRow(stringResource(R.string.app_name), stringResource(R.string.about_app, BuildConfig.VERSION_NAME)) }
        item {
            LoadView(meta) { m ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ListRow(m.name, stringResource(R.string.about_hub, m.serverVersion, m.contractVersion))
                    ListRow(stringResource(R.string.about_address), context.graph.store.current?.hub)
                }
            }
        }
        item { Text(stringResource(R.string.about_license, Product.NAME), style = MaterialTheme.typography.bodySmall, color = LocalTokens.current.textMuted) }
    }
}

@Composable
private fun ProfilesPage() {
    val context = LocalContext.current
    val profiles = rememberLoad { context.graph.apis(context.graph.store.current!!).auth.authListProfiles().items }
    LoadView(profiles) { list ->
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(list, key = { it.id }) { p ->
                ListRow(p.name, stringResource(R.string.profiles_counts, p.slug, p.agentCount, p.sessionCount))
            }
        }
    }
}

@Composable
private fun UsersPage() {
    val context = LocalContext.current
    val users = rememberLoad { context.graph.apis(context.graph.store.current!!).auth.authListUsers(limit = 200).items }
    LoadView(users) { list ->
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(list, key = { it.id }) { u -> ListRow(u.displayName, "@${u.username}", trailing = { StatusBadge(u.role.value) }) }
        }
    }
}

/** App tokens and paired devices that can act as this person, as the web's Privacy lists them. */
@Composable
private fun PrivacyPage() {
    val context = LocalContext.current
    val tokens = rememberLoad { context.graph.apis(context.graph.store.current!!).auth.authListAppTokens().items }
    LoadView(tokens) { list ->
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            item { Text(stringResource(R.string.privacy_tokens), color = LocalTokens.current.textMuted, style = MaterialTheme.typography.bodySmall) }
            if (list.isEmpty()) item { Text(stringResource(R.string.privacy_none), color = LocalTokens.current.textMuted) }
            items(list, key = { it.id }) { token -> ListRow(token.name, token.lastUsedAt?.let(::localTime)) }
        }
    }
}

/** A page the phone does not draw: said plainly, with the same page on the web one tap away. */
@Composable
private fun OnTheWebPage(destination: String) {
    val context = LocalContext.current
    val hub = context.graph.store.current?.hub
    val url = hub?.let { AppPaths.webUrl(it, destination) }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        EmptyState(term(destination), stringResource(R.string.on_the_web_body))
        if (url != null) {
            Button(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.on_the_web_open))
            }
        }
    }
}

/** This device, part 2: the hub this phone talks to and how it signed in. Part 3 adds voice and more. */
@Composable
fun ThisDeviceBasics(shell: ShellViewModel) {
    val session by shell.session.collectAsState()
    val s = session ?: return
    val connectionTitle = stringResource(R.string.device_connection)
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        header(connectionTitle)
        item {
            ListRow(
                s.hub,
                stringResource(if (s.kind == TokenKind.APP) R.string.device_paired else R.string.device_signed_in) +
                    (s.expiresAt?.let { " · " + stringResource(R.string.device_until, localTime(java.time.Instant.ofEpochMilli(it).atOffset(java.time.ZoneOffset.UTC))) } ?: ""),
            )
        }
        item { OutlinedButton(onClick = shell::signOut, modifier = Modifier.fillMaxWidth()) { Text(term("sign_out")) } }
    }
}

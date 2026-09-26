package hub.core.android.ui.screens

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.StatusDot
import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.AppLanguage
import hub.core.android.BuildConfig
import hub.core.android.R
import hub.core.android.data.hubCall
import hub.core.android.generated.Product
import hub.core.android.graph
import hub.core.android.nav.AppPaths
import hub.core.android.nav.Route
import hub.core.android.nav.Screens
import hub.core.android.ui.components.LoadView
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
    val native = setOf(
        "account", "display", "notifications", "privacy", "this_device", "about", "theme", "workspaces", "users",
        "logs", "performance",
    )
}

/** Each Settings row's icon, the iOS app's and the web's (Lucide on every surface). */
fun settingsIcon(destination: String): Int = when (destination) {
    "account" -> Lucide.CircleUserRound
    "users" -> Lucide.Users
    "webhooks" -> Lucide.Webhook
    "display" -> Lucide.Type
    "notifications" -> Lucide.Bell
    "privacy" -> Lucide.Hand
    "this_device" -> Lucide.Smartphone
    "about" -> Lucide.Info
    "models" -> Lucide.Layers
    "device_connections" -> Lucide.QrCode
    "knowledge" -> Lucide.Library
    "logs" -> Lucide.FileSearch
    "usage" -> Lucide.ChartColumn
    "skills_usage" -> Lucide.WandSparkles
    "performance" -> Lucide.Gauge
    "theme" -> Lucide.Palette
    "workspaces" -> Lucide.LayoutGrid
    "updates" -> Lucide.CircleArrowDown
    "plugins" -> Lucide.Puzzle
    "files" -> Lucide.Folder
    else -> Lucide.Settings
}

/**
 * Settings on the phone, as on iOS: the list is the page (NAVIGATION.md §2), headed by «Back to
 * chats» (which returns to the conversation that was open before Settings), then the groups as
 * inset lists with an icon per row.
 */
@Composable
fun SettingsScreen(isAdmin: Boolean, onOpen: (Route) -> Unit, onBackToChats: () -> Unit) {
    val t = LocalTokens.current
    LazyColumn(Modifier.fillMaxSize().testTag("settings.list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp)) {
        item {
            GroupedList {
                Item(
                    stringResource(R.string.settings_back_to_chats), icon = Lucide.ArrowLeft, onClick = onBackToChats, tag = "settings.back", accent = true,
                )
            }
        }
        SettingsList.visible(isAdmin).forEach { (title, rows) ->
            if (rows.isEmpty()) return@forEach
            item(key = "g$title") {
                GroupedList(Modifier.padding(top = if (title == null) 16.dp else 0.dp), title = title?.let { stringResource(it) }) {
                    rows.forEach { destination ->
                        Item(
                            term(destination), icon = settingsIcon(destination), iconTint = t.accent, chevron = true,
                            tag = "settings.row.$destination", onClick = { onOpen(Route.SettingsPage(destination)) },
                        )
                    }
                }
            }
        }
    }
}

/** One page under Settings; «Back to Settings» is the top bar's back arrow. */
@Composable
fun SettingsPageScreen(destination: String, shell: ShellViewModel, onOpen: (Route) -> Unit, thisDevice: @Composable () -> Unit) {
    val session by shell.session.collectAsState()
    val s = session ?: return
    when (destination) {
        // Native on the phone since phone parity (owner: «why are sections missing»).
        "models" -> ModelsPage(s.profile, shell.profileName(s.profile), s.user.isAdmin)
        "device_connections" -> DevicesPage(s.profile)
        "usage" -> UsagePage(s.profile, s.user.isAdmin)
        "account" -> AccountPage(shell)
        "display", "theme" -> DisplayPage(showLanguage = destination == "display")
        "notifications" -> NotificationsPage(onOpen, s.profile)
        "about" -> AboutPage()
        "workspaces" -> ProfilesPage()
        "users" -> PeoplePage(s.profile, s.user.id)
        "privacy" -> PrivacyPage()
        "this_device" -> thisDevice()
        "logs" -> LogsPage()
        "performance" -> PerformancePage()
        else -> OnTheWebPage(destination)
    }
}

private val pagePadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp)

@Composable
private fun AccountPage(shell: ShellViewModel) {
    val session by shell.session.collectAsState()
    val s = session ?: return
    LazyColumn(contentPadding = pagePadding, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            GroupedList {
                Item(s.user.displayName, subtitle = "@${s.user.username}", icon = Lucide.CircleUserRound, trailing = { Badge(s.user.role) })
                Item(stringResource(R.string.account_profiles), subtitle = s.user.profiles.joinToString(" · ") { shell.profileName(it) }, icon = Lucide.LayoutGrid)
            }
        }
        item {
            HubButton(term("sign_out"), shell::signOut, kind = ButtonKind.Danger, icon = Lucide.LogOut, fill = true, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun DisplayPage(showLanguage: Boolean) {
    val context = LocalContext.current
    val prefs = context.graph.prefs
    val theme by prefs.theme.collectAsState()
    LazyColumn(contentPadding = pagePadding, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (showLanguage) {
            item { SectionTitle(stringResource(R.string.display_language)) }
            item {
                Segmented(
                    listOf(
                        Segment<AppLanguage?>(null, stringResource(R.string.display_language_system)),
                        Segment<AppLanguage?>(AppLanguage.AR, stringResource(R.string.display_language_ar)),
                        Segment<AppLanguage?>(AppLanguage.EN, stringResource(R.string.display_language_en)),
                    ),
                    prefs.language,
                    { lang -> prefs.language = lang; (context as? Activity)?.recreate() },
                    Modifier.fillMaxWidth(), size = ControlSize.Lg,
                )
            }
        }
        item { SectionTitle(term("theme")) }
        item {
            Segmented(
                listOf(
                    Segment(ThemeChoice.SYSTEM, stringResource(R.string.theme_system), Lucide.Contrast),
                    Segment(ThemeChoice.LIGHT, stringResource(R.string.theme_light), Lucide.Sun),
                    Segment(ThemeChoice.DARK, stringResource(R.string.theme_dark), Lucide.Moon),
                ),
                theme, { prefs.setTheme(it) }, Modifier.fillMaxWidth(), size = ControlSize.Lg,
            )
        }
    }
}

/** The notifications inbox: newest first, unread ones marked with a dot; a tap marks one read and opens what it is about. */
@Composable
private fun NotificationsPage(onOpen: (Route) -> Unit, profile: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    // The inbox, and the settings table beside it (which notice comes in the app and as a push).
    var settings by androidx.compose.runtime.saveable.rememberSaveable { androidx.compose.runtime.mutableStateOf(false) }
    val notices = rememberLoad { context.graph.apis(context.graph.store.current!!).notify.notifyListNotices(limit = 100).items }
    LazyColumn(Modifier.fillMaxSize().testTag("notices.list"), contentPadding = pagePadding, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Segmented(
                listOf(Segment(false, stringResource(R.string.notify_inbox), tag = "notices.tab.inbox"), Segment(true, stringResource(R.string.notify_settings), tag = "notices.tab.settings")),
                settings, { settings = it }, Modifier.fillMaxWidth(), size = ControlSize.Sm,
            )
        }
        if (settings) {
            item { NotificationSettings(profile) }
            return@LazyColumn
        }
        // Whether this phone can show them at all comes first.
        item { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { hub.core.android.phone.NotificationRows() } }
        item {
            SectionTitle(term("notifications")) {
                HubButton(
                    stringResource(R.string.notices_mark_all), {
                        scope.launch {
                            hubCall { context.graph.apis(context.graph.store.current!!).notify.notifyMarkAllRead(NotifyMarkAllReadRequest()) }
                            notices.reload()
                        }
                    },
                    kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.Check,
                )
            }
        }
        item {
            LoadView(notices) { list ->
                if (list.isEmpty()) EmptyState(stringResource(R.string.notices_empty), icon = Lucide.BellOff)
                else GroupedList {
                    list.forEach { notice ->
                        Item(
                            notice.title,
                            subtitle = listOfNotNull(notice.body, localTime(notice.createdAt)).joinToString(" · "),
                            tag = "notice.${notice.id}",
                            trailing = {
                                // Unread is a dot, not a word (its word is for TalkBack).
                                if (notice.readAt == null) StatusDot(t.accent, stringResource(R.string.notices_new))
                            },
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
    LazyColumn(contentPadding = pagePadding, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                hub.core.android.ui.components.BrandMark(48)
                Text(stringResource(R.string.app_name), fontSize = FontTokens.sizeXl.sp, fontWeight = FontWeight.SemiBold)
                Text(stringResource(R.string.about_app, BuildConfig.VERSION_NAME), fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted)
            }
        }
        item {
            LoadView(meta) { m ->
                GroupedList {
                    Item(m.name, subtitle = stringResource(R.string.about_hub, m.serverVersion, m.contractVersion), icon = Lucide.Server)
                    Item(stringResource(R.string.about_address), subtitle = context.graph.store.current?.hub, icon = Lucide.Link)
                }
            }
        }
        item { Text(stringResource(R.string.about_license, Product.NAME), fontSize = FontTokens.sizeXs.sp, color = LocalTokens.current.textMuted) }
    }
}

@Composable
private fun ProfilesPage() {
    val context = LocalContext.current
    val profiles = rememberLoad { context.graph.apis(context.graph.store.current!!).auth.authListProfiles().items }
    LoadView(profiles) { list ->
        LazyColumn(contentPadding = pagePadding) {
            item {
                GroupedList {
                    list.forEach { p -> Item(p.name, subtitle = stringResource(R.string.profiles_counts, p.slug, p.agentCount, p.sessionCount), icon = Lucide.LayoutGrid) }
                }
            }
        }
    }
}

@Composable
private fun UsersPage() {
    val context = LocalContext.current
    val users = rememberLoad { context.graph.apis(context.graph.store.current!!).auth.authListUsers(limit = 200).items }
    LoadView(users) { list ->
        LazyColumn(contentPadding = pagePadding) {
            item {
                GroupedList {
                    list.forEach { u -> Item(u.displayName, subtitle = "@${u.username}", icon = Lucide.CircleUserRound, trailing = { Badge(u.role.value) }) }
                }
            }
        }
    }
}

/** App tokens and paired devices that can act as this person, as the web's Privacy lists them. */
@Composable
private fun PrivacyPage() {
    val context = LocalContext.current
    val tokens = rememberLoad { context.graph.apis(context.graph.store.current!!).auth.authListAppTokens().items }
    LoadView(tokens) { list ->
        LazyColumn(contentPadding = pagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { NoticeBox(stringResource(R.string.privacy_tokens), BadgeTone.Info) }
            if (list.isEmpty()) item { EmptyState(stringResource(R.string.privacy_none), icon = Lucide.Shield) }
            else item {
                GroupedList {
                    list.forEach { token -> Item(token.name, subtitle = token.lastUsedAt?.let(::localTime), icon = Lucide.KeyRound) }
                }
            }
        }
    }
}

/** A page the phone does not draw: said plainly, with the same page on the web one tap away. */
@Composable
private fun OnTheWebPage(destination: String) {
    val context = LocalContext.current
    val hub = context.graph.store.current?.hub
    val url = hub?.let { AppPaths.webUrl(it, destination) }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        EmptyState(term(destination), body = stringResource(R.string.on_the_web_body), icon = settingsIcon(destination))
        if (url != null) {
            HubButton(
                stringResource(R.string.on_the_web_open), { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
                icon = Lucide.ExternalLink, fill = true, modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

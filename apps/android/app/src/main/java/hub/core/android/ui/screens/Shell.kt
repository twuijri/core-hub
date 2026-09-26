package hub.core.android.ui.screens

import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.AppLanguage
import hub.core.android.BuildConfig
import hub.core.android.R
import hub.core.android.generated.ControlTokens
import hub.core.android.generated.FontTokens
import hub.core.android.generated.LayoutTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.generated.Terms
import hub.core.android.graph
import hub.core.android.nav.Navigator
import hub.core.android.nav.Route
import hub.core.android.nav.Screens
import hub.core.android.ui.components.AgentAvatar
import hub.core.android.ui.components.AgentIdentity
import hub.core.android.ui.components.BrandMark
import hub.core.android.ui.components.DismissKeyboardWhenDrawerMoves
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.keyboardSink
import hub.core.android.ui.components.rememberAgents
import hub.core.android.ui.components.rememberKeyboardDismisser
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.Hairline
import hub.core.android.ui.kit.HubCheckbox
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.HubTopBar
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.ItemShape
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.MenuDivider
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.MenuLabel
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.kit.StatusDot
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.ThemeChoice
import hub.core.client.model.Session
import hub.core.client.model.SessionStatus
import kotlinx.coroutines.launch

/** What the destinations the shell can open draw, handed in so the shell stays one file. */
typealias DestinationContent = @Composable (route: Route, nav: Navigator, shell: ShellViewModel, openDrawer: () -> Unit) -> Unit

/**
 * The signed-in app: the drawer is the sidebar (NAVIGATION.md §1, identical on every surface,
 * with a close button on the phone), the page beside it takes the whole width. On a phone the
 * drawer is the iOS app's: 86% of the width, at most `sidebar-width` + 2rem, over the token scrim.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainShell(nav: Navigator, content: DestinationContent) {
    val context = LocalContext.current
    val shell: ShellViewModel = viewModel { ShellViewModel(context.graph) }
    val session by shell.session.collectAsState()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val closeDrawer: () -> Unit = { scope.launch { drawer.close() } }
    val openDrawer: () -> Unit = { scope.launch { drawer.open() } }
    val keyboard = rememberKeyboardDismisser()
    DismissKeyboardWhenDrawerMoves(drawer, keyboard)
    val t = LocalTokens.current

    BackHandler(enabled = drawer.isOpen || nav.stack.size > 1) {
        if (drawer.isOpen) closeDrawer() else nav.back()
    }
    if (session == null) return

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = min((LayoutTokens.sidebarWidth + 32f).dp, maxWidth * 0.86f)
        ModalNavigationDrawer(
            drawerState = drawer,
            scrimColor = t.scrim,
            drawerContent = {
                ModalDrawerSheet(
                    drawerContainerColor = t.bgRaised,
                    drawerContentColor = t.text,
                    drawerShape = RoundedCornerShape(0.dp),
                    drawerTonalElevation = 0.dp,
                    windowInsets = WindowInsets(0),
                    modifier = Modifier.width(width).fillMaxHeight(),
                ) {
                    // The drawer takes focus from the composer as it opens (and the keyboard goes).
                    Box(Modifier.keyboardSink(keyboard).testTag("shell.sidebar")) { Sidebar(shell, nav, onClose = closeDrawer) }
                }
            },
        ) {
            content(nav.current, nav, shell, openDrawer)
        }
    }
}

/**
 * The page's top bar ([HubTopBar]): the drawer button (or back), the title centred, and its
 * actions as round buttons at the end.
 */
@Composable
fun TopBar(
    title: String,
    onMenu: (() -> Unit)?,
    onBack: (() -> Unit)? = null,
    subtitle: String? = null,
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    HubTopBar(title, subtitle = subtitle, onMenu = onMenu, onBack = onBack, leading = leading, actions = actions)
}

/** A term from navigation.json, in the UI language (the entry's label equals the screen's title). */
@Composable
fun term(key: String): String = Terms.ids[key]?.let { stringResource(it) } ?: key

private enum class DrawerSegment { CHAT, ROOMS }

/** The rail's icons, the web's and iOS's (Lucide on every surface). */
fun railIcon(destination: String): Int = when (destination) {
    "new_chat" -> Lucide.SquarePen
    "search" -> Lucide.Search
    "agent_manager" -> Lucide.Cpu
    "tasks" -> Lucide.ListChecks
    "schedules" -> Lucide.CalendarClock
    "chat" -> Lucide.MessagesSquare
    "rooms" -> Lucide.Users
    "settings" -> Lucide.Settings
    else -> Lucide.Info
}

/**
 * The drawer, as on iOS: the brand, a compact rail, the Chat | Rooms segments, one search field
 * whose filter button holds the profile and archive choices, and the list — which takes the rest
 * of the height and scrolls with the rail — then the footer, where the profile selector sits
 * beside the account name and the connection dot (owner, 2026-09-26; NAVIGATION.md §1).
 */
@Composable
private fun Sidebar(shell: ShellViewModel, nav: Navigator, onClose: () -> Unit) {
    val session by shell.session.collectAsState()
    val s = session ?: return
    var segment by rememberSaveable { mutableStateOf(if (nav.current is Route.Room) DrawerSegment.ROOMS else DrawerSegment.CHAT) }
    // imePadding: while the drawer's search has the keyboard, the footer rides above it.
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            BrandMark(28)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.app_name), fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            HubIconButton(Lucide.X, stringResource(R.string.menu_close), onClose, size = ControlTokens.heightMd.dp, iconSize = 18.dp)
        }
        Spacer(Modifier.height(8.dp))
        val go: (Route) -> Unit = { route -> nav.go(route); onClose() }
        val rail: @Composable () -> Unit = {
            Column(Modifier.padding(horizontal = 8.dp)) {
                RailRow("new_chat", nav.current == Route.NewChat) { go(Route.NewChat) }
                RailRow("search", nav.current == Route.Search) { go(Route.Search) }
                if (Screens.visible("agent_manager", s.user.isAdmin)) {
                    RailRow("agent_manager", nav.current == Route.Agents) { go(Route.Agents) }
                }
                RailRow("tasks", nav.current == Route.Tasks) { go(Route.Tasks) }
                RailRow("schedules", nav.current == Route.Schedules) { go(Route.Schedules) }
            }
            Segmented(
                listOf(
                    Segment(DrawerSegment.CHAT, term("chat"), tag = "shell.segment.chat"),
                    Segment(DrawerSegment.ROOMS, term("rooms"), tag = "shell.segment.rooms"),
                ),
                segment, { segment = it },
                Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 12.dp, bottom = 8.dp).testTag("shell.segments"),
            )
        }
        Box(Modifier.weight(1f)) {
            when (segment) {
                DrawerSegment.CHAT -> ChatsPanel(shell, nav, header = rail, onOpen = onClose)
                DrawerSegment.ROOMS -> RoomsPanel(nav, header = rail, onOpen = onClose)
            }
        }
        Hairline(Modifier.fillMaxWidth())
        Footer(shell, nav, onClose)
    }
}

/** One rail row: an icon and the destination's name, the height of a large control. */
@Composable
private fun RailRow(destination: String, selected: Boolean, onClick: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().height(ControlTokens.heightLg.dp).clip(ItemShape)
            .background(if (selected) t.surface2 else Color.Transparent, ItemShape)
            .clickable(onClick = onClick).padding(horizontal = 8.dp).testTag("rail.$destination"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LucideIcon(railIcon(destination), null, size = 18.dp, tint = if (selected) t.text else t.textMuted)
        Text(term(destination), fontSize = FontTokens.sizeMd.sp, color = t.text, fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal)
    }
}

/**
 * The profile selector — always one concrete profile, never «all» (ADR 0016). On the phone it is
 * a small chip in the drawer's footer, beside the account name and the connection dot (owner,
 * 2026-09-26): no permanent top bar takes space from the chat or the board, and the new-chat
 * screen names the profile the chat will be made in.
 */
@Composable
fun ProfileSwitcher(shell: ShellViewModel, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    val session by shell.session.collectAsState()
    val profiles by shell.profiles.collectAsState()
    val s = session ?: return
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(RadiusTokens.full.dp)
    val current = shell.profileName(s.profile)
    val label = stringResource(R.string.profile_label)
    Box(modifier) {
        Row(
            Modifier.height(ControlTokens.heightSm.dp).clip(shape).background(t.surface2, shape)
                .clickable(enabled = profiles.size > 1) { open = true }
                .semantics { contentDescription = "$label: $current" }
                .padding(horizontal = 8.dp).testTag("shell.profile"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            LucideIcon(Lucide.LayoutGrid, null, size = 12.dp, tint = t.textMuted)
            Text(current, fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (profiles.size > 1) LucideIcon(Lucide.ChevronsUpDown, null, size = 11.dp, tint = t.textMuted)
        }
        HubMenu(open, { open = false }) {
            MenuLabel(label)
            profiles.forEach { p ->
                MenuItem(p.name, { shell.switchProfile(p.slug); open = false }, checked = p.slug == s.profile)
            }
        }
    }
}

@Composable
private fun ChatsPanel(shell: ShellViewModel, nav: Navigator, header: @Composable () -> Unit, onOpen: () -> Unit) {
    val t = LocalTokens.current
    val chats by shell.chats.collectAsState()
    val profiles by shell.profiles.collectAsState()
    val badges = ChatsList.showsProfiles(chats, profiles.size)
    val selected by shell.selected.collectAsState()
    LaunchedEffect(Unit) { if (chats.items.isEmpty()) shell.reloadChats() }
    val pinned = chats.items.filter { it.pinned }
    val recent = chats.items.filter { !it.pinned }
    LazyColumn(Modifier.fillMaxSize().testTag("chats.list"), contentPadding = PaddingValues(bottom = 8.dp)) {
        item(key = "header") { header() }
        item(key = "search") { ChatsSearch(shell) }
        if (selected.isNotEmpty()) item(key = "batch") { BatchBar(shell, selected.size) }
        chats.error?.let { error -> item(key = "error") { ErrorNotice(error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) } }
        if (pinned.isNotEmpty()) {
            item(key = "pinned") { SectionLabel(stringResource(R.string.chats_pinned)) }
            items(pinned, key = { "p" + it.id }) { ChatRow(it, badges, shell, nav, onOpen) }
        }
        if (recent.isNotEmpty()) {
            item(key = "recent") { SectionLabel(stringResource(R.string.chats_recent, recent.size)) }
            items(recent, key = { it.id }) { ChatRow(it, badges, shell, nav, onOpen) }
        }
        if (chats.nextCursor != null) {
            item(key = "more") {
                LaunchedEffect(chats.items.size) { shell.loadMore() }
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { Spinner(18.dp, t.textMuted) }
            }
        }
        if (!chats.loading && chats.items.isEmpty() && chats.error == null) {
            item(key = "empty") {
                Text(stringResource(R.string.chats_empty), fontSize = FontTokens.sizeSm.sp, color = t.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp))
            }
        }
    }
}

/**
 * One search field; its filter button holds the list's own profile filter («all profiles» by
 * default, never the selector's) and Active / Archived / All. A dot on the button says a filter
 * other than the default is on.
 */
@Composable
private fun ChatsSearch(shell: ShellViewModel) {
    val t = LocalTokens.current
    val chats by shell.chats.collectAsState()
    val profiles by shell.profiles.collectAsState()
    var query by rememberSaveable { mutableStateOf(chats.query) }
    var filters by remember { mutableStateOf(false) }
    val filtered = chats.profileFilter != null || chats.archive != ArchiveFilter.ACTIVE
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        HubTextField(
            query, { query = it; shell.setQuery(it) },
            placeholder = stringResource(R.string.chats_search), leadingIcon = Lucide.Search,
            size = ControlSize.Md, modifier = Modifier.weight(1f).testTag("chats.search"),
        )
        Box {
            HubIconButton(
                Lucide.ListFilter, stringResource(R.string.chats_filter), { filters = true },
                kind = if (filtered) IconKind.Soft else IconKind.Plain, size = ControlTokens.heightMd.dp, iconSize = 18.dp,
                tint = if (filtered) t.accent else null, shape = ItemShape, modifier = Modifier.testTag("chats.filter"),
            )
            if (filtered) StatusDot(t.accent, null, Modifier.align(Alignment.TopEnd).padding(4.dp), size = 6.dp)
            HubMenu(filters, { filters = false }) {
                if (profiles.size > 1) {
                    MenuLabel(stringResource(R.string.profile_label))
                    MenuItem(stringResource(R.string.chats_all_profiles), { shell.setProfileFilter(null); filters = false }, checked = chats.profileFilter == null)
                    profiles.forEach { p ->
                        MenuItem(p.name, { shell.setProfileFilter(p.slug); filters = false }, checked = chats.profileFilter == p.slug)
                    }
                    MenuDivider()
                }
                MenuLabel(stringResource(R.string.chats_filter_show))
                ArchiveFilter.entries.forEach { f ->
                    MenuItem(
                        stringResource(when (f) { ArchiveFilter.ACTIVE -> R.string.chats_active; ArchiveFilter.ARCHIVED -> R.string.chats_archived; ArchiveFilter.ALL -> R.string.chats_all }),
                        { shell.setArchive(f); filters = false },
                        icon = when (f) { ArchiveFilter.ACTIVE -> Lucide.MessagesSquare; ArchiveFilter.ARCHIVED -> Lucide.Archive; ArchiveFilter.ALL -> Lucide.Inbox },
                        checked = chats.archive == f,
                        modifier = Modifier.testTag("chats.filter.${f.name.lowercase()}"),
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text, fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = LocalTokens.current.textFaint,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 2.dp),
    )
}

/**
 * The chats list's batch mode (a long press on a chat): how many are selected, and archive,
 * bring back or delete them all as icons (their names on a long press) — deleting asks first.
 */
@Composable
private fun BatchBar(shell: ShellViewModel, count: Int) {
    val t = LocalTokens.current
    val busy by shell.batchBusy.collectAsState()
    val error by shell.batchError.collectAsState()
    var confirm by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("chats.batch")) {
        Row(
            Modifier.fillMaxWidth().background(t.accentSoft, ItemShape).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HubIconButton(Lucide.X, stringResource(R.string.chats_batch_done), shell::clearSelection, size = ControlTokens.heightMd.dp, iconSize = 16.dp, tint = t.accentSoftText)
            Text(
                stringResource(R.string.chats_batch_selected, count), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.SemiBold,
                color = t.accentSoftText, modifier = Modifier.weight(1f),
            )
            if (busy) Spinner(16.dp, t.accentSoftText)
            HubIconButton(Lucide.Archive, stringResource(R.string.chats_batch_archive), { shell.archiveSelected(true) }, enabled = !busy, size = ControlTokens.heightMd.dp, iconSize = 18.dp, tint = t.accentSoftText, modifier = Modifier.testTag("chats.batch.archive"))
            HubIconButton(Lucide.ArchiveRestore, stringResource(R.string.chats_batch_unarchive), { shell.archiveSelected(false) }, enabled = !busy, size = ControlTokens.heightMd.dp, iconSize = 18.dp, tint = t.accentSoftText, modifier = Modifier.testTag("chats.batch.unarchive"))
            HubIconButton(Lucide.Trash, stringResource(R.string.chats_batch_delete), { confirm = true }, enabled = !busy, size = ControlTokens.heightMd.dp, iconSize = 18.dp, tint = t.danger, modifier = Modifier.testTag("chats.batch.delete"))
        }
        error?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = t.danger, modifier = Modifier.padding(top = 4.dp)) }
    }
    if (confirm) {
        ConfirmDialog(
            title = stringResource(R.string.chats_batch_delete_title, count),
            body = stringResource(R.string.chats_batch_delete_body),
            confirm = stringResource(R.string.chats_batch_delete),
            onConfirm = { confirm = false; shell.deleteSelected() },
            onDismiss = { confirm = false },
            danger = true,
        )
    }
}

private val contentStyle = TextStyle(textDirection = TextDirection.Content)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(session: Session, badge: Boolean, shell: ShellViewModel, nav: Navigator, onOpen: () -> Unit) {
    val t = LocalTokens.current
    val picked by shell.selected.collectAsState()
    val selecting = picked.isNotEmpty()
    val chosen = session.id in picked
    val selected = chosen || (!selecting && (nav.current as? Route.Chat)?.sessionId == session.id)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(ItemShape)
            .background(if (selected) t.surface2 else Color.Transparent, ItemShape)
            .combinedClickable(
                onClick = {
                    if (selecting) shell.toggleSelected(session.id)
                    else { nav.go(Route.Chat(session.id, session.profile)); onOpen() }
                },
                onLongClick = { shell.toggleSelected(session.id) },
            )
            .padding(horizontal = 8.dp, vertical = 7.dp)
            .testTag("chat.row.${session.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (selecting) {
            HubCheckbox(chosen, { shell.toggleSelected(session.id) })
        } else {
            // The chat's agent, by its face (its picture, its mark, or its initial).
            val agents = rememberAgents(session.profile)
            val agent = agents.firstOrNull { it.id == session.agentId }
            if (agent != null) AgentAvatar(AgentIdentity.of(agent), session.profile, 24.dp)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                session.title ?: stringResource(R.string.term_new_chat), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium,
                maxLines = 1, overflow = TextOverflow.Ellipsis, style = contentStyle,
            )
            session.preview?.takeIf { it.isNotBlank() }?.let {
                Text(it, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, style = contentStyle)
            }
        }
        if (session.status != SessionStatus.IDLE) StatusDot(t.statusRunning, null, size = 6.dp)
        if (session.pinned) LucideIcon(Lucide.Pin, stringResource(R.string.chats_pinned), size = 12.dp, tint = t.textFaint)
        if (badge) Badge(shell.profileName(session.profile), tone = BadgeTone.Accent)
    }
}

/**
 * The footer, compact: who is signed in with a dot for the connection (its words for TalkBack),
 * Settings and sign-out as icons; then the language, the theme's three icons, and the version.
 */
@Composable
private fun Footer(shell: ShellViewModel, nav: Navigator, onClose: () -> Unit) {
    val t = LocalTokens.current
    val context = LocalContext.current
    val graph = context.graph
    val session by shell.session.collectAsState()
    val connected by graph.realtime.connected.collectAsState()
    val theme by graph.prefs.theme.collectAsState()
    val s = session ?: return
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // The person, the connection and the profile they are in, on one line; the name and
            // the profile share what the two buttons leave.
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    s.user.displayName.ifBlank { s.user.username }, fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                StatusDot(
                    if (connected) t.statusRunning else t.statusBlocked,
                    stringResource(if (connected) R.string.shell_connected else R.string.shell_offline),
                    Modifier.testTag("shell.connection"),
                )
                ProfileSwitcher(shell, Modifier.weight(1f, fill = false))
            }
            HubIconButton(Lucide.Settings, term("settings"), { nav.go(Route.Settings); onClose() }, size = ControlTokens.heightMd.dp, iconSize = 18.dp, modifier = Modifier.testTag("footer.settings"))
            HubIconButton(Lucide.LogOut, term("sign_out"), shell::signOut, size = ControlTokens.heightMd.dp, iconSize = 18.dp, tint = t.danger, modifier = Modifier.testTag("footer.sign_out"))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val lang = graph.prefs.effectiveLanguage
            Row(
                Modifier.clip(ItemShape).clickable {
                    graph.prefs.language = if (lang == AppLanguage.AR) AppLanguage.EN else AppLanguage.AR
                    (context as? Activity)?.recreate()
                }.padding(horizontal = 4.dp, vertical = 6.dp).testTag("footer.language"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LucideIcon(Lucide.Globe, stringResource(R.string.shell_language), size = 16.dp, tint = t.accent)
                Text(if (lang == AppLanguage.AR) "English" else "العربية", fontSize = FontTokens.sizeSm.sp, color = t.accent)
            }
            Spacer(Modifier.weight(1f))
            ThemeChips(theme) { graph.prefs.setTheme(it) }
            Text(BuildConfig.VERSION_NAME, fontSize = FontTokens.sizeXs.sp, color = t.textFaint, modifier = Modifier.padding(horizontal = 4.dp))
        }
    }
}

/** The footer's theme chip: three icons on one track, each named for TalkBack (NAVIGATION.md §1). */
@Composable
fun ThemeChips(theme: ThemeChoice, onChoose: (ThemeChoice) -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.background(t.surface2, RoundedCornerShape(ControlTokens.trackRadius.dp)).padding(ControlTokens.trackPad.dp),
        horizontalArrangement = Arrangement.spacedBy(ControlTokens.gap.dp),
    ) {
        listOf(ThemeChoice.SYSTEM, ThemeChoice.LIGHT, ThemeChoice.DARK).forEach { choice ->
            val (icon, label) = when (choice) {
                ThemeChoice.LIGHT -> Lucide.Sun to R.string.theme_light
                ThemeChoice.DARK -> Lucide.Moon to R.string.theme_dark
                ThemeChoice.SYSTEM -> Lucide.Contrast to R.string.theme_system
            }
            val on = theme == choice
            Box(
                Modifier.size(ControlTokens.heightSm.dp).clip(ItemShape).background(if (on) t.surface else Color.Transparent, ItemShape)
                    .clickable { onChoose(choice) }.testTag("footer.theme.${choice.name.lowercase()}"),
                contentAlignment = Alignment.Center,
            ) {
                LucideIcon(icon, stringResource(label), size = 15.dp, tint = if (on) t.text else t.textMuted)
            }
        }
    }
}

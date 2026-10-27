package hub.core.android.ui.screens

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.foundation.gestures.drag
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
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
import hub.core.android.generated.Product
import hub.core.android.generated.RadiusTokens
import hub.core.android.generated.Terms
import hub.core.android.graph
import hub.core.android.nav.Navigator
import hub.core.android.nav.Route
import hub.core.android.nav.Screens
import hub.core.android.nav.SidebarGroups
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
    "workflows" -> Lucide.Workflow
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
            // The brand row's entries (Search) as icons beside the close button (DECISIONS §128).
            Screens.brandRow.forEach { destination ->
                val route = Screens.routeOf(destination) ?: return@forEach
                HubIconButton(
                    railIcon(destination), term(destination), { nav.go(route); onClose() },
                    size = ControlTokens.heightMd.dp, iconSize = 18.dp,
                    kind = if (nav.current == route) IconKind.Soft else IconKind.Plain,
                    modifier = Modifier.testTag("rail.$destination"),
                )
            }
            HubIconButton(Lucide.X, stringResource(R.string.menu_close), onClose, size = ControlTokens.heightMd.dp, iconSize = 18.dp)
        }
        Spacer(Modifier.height(8.dp))
        val go: (Route) -> Unit = { route -> nav.go(route); onClose() }
        val graph = LocalContext.current.graph
        val closedGroups by graph.sidebarGroups.closed.collectAsState()
        val rail: @Composable () -> Unit = {
            Column(Modifier.padding(horizontal = 8.dp)) {
                Screens.railRows.forEach { destination ->
                    val route = Screens.routeOf(destination) ?: return@forEach
                    if (Screens.visible(destination, s.user.isAdmin)) RailRow(destination, nav.current == route) { go(route) }
                }
                Screens.groups.forEach { (group, items) ->
                    val shown = SidebarGroups.visibleItems(items, s.user.isAdmin)
                    if (shown.isEmpty()) return@forEach
                    val closed = group in closedGroups
                    GroupHeading(group, open = !closed, marked = SidebarGroups.headingMarked(closed, shown, nav.current.destination)) {
                        graph.sidebarGroups.toggle(group)
                    }
                    if (!closed) {
                        Column(Modifier.padding(start = 12.dp)) {
                            shown.forEach { destination ->
                                val route = Screens.routeOf(destination) ?: return@forEach
                                RailRow(destination, nav.current == route) { go(route) }
                            }
                        }
                    }
                }
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

/**
 * A group's heading («Tools»): its icon, its title, and a chevron at the end — down when open,
 * pointing to the reading end when closed. A tap opens or closes it; closed on one of its pages, it
 * is drawn as the current place (the selected row's background, «selected» for TalkBack).
 */
@Composable
private fun GroupHeading(group: String, open: Boolean, marked: Boolean, onToggle: () -> Unit) {
    val t = LocalTokens.current
    val rtl = androidx.compose.ui.platform.LocalLayoutDirection.current == androidx.compose.ui.unit.LayoutDirection.Rtl
    val state = stringResource(if (open) R.string.sidebar_group_expanded else R.string.sidebar_group_collapsed)
    Row(
        Modifier.fillMaxWidth().height(ControlTokens.heightLg.dp).clip(ItemShape)
            .background(if (marked) t.surface2 else Color.Transparent, ItemShape)
            .clickable(onClick = onToggle)
            .semantics {
                stateDescription = state
                selected = marked
                if (open) collapse { onToggle(); true } else expand { onToggle(); true }
            }
            .padding(horizontal = 8.dp).testTag("sidebar.group.$group"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LucideIcon(groupIcon(group), null, size = 18.dp, tint = if (marked) t.text else t.textMuted)
        Text(
            term(group), fontSize = FontTokens.sizeMd.sp, color = t.text,
            fontWeight = if (marked) FontWeight.Medium else FontWeight.Normal, modifier = Modifier.weight(1f),
        )
        LucideIcon(
            when {
                open -> Lucide.ChevronDown
                rtl -> Lucide.ChevronLeft
                else -> Lucide.ChevronRight
            },
            null, size = 16.dp, tint = t.textMuted,
        )
    }
}

/** A group heading's icon (Lucide, as the web's). */
fun groupIcon(group: String): Int = when (group) {
    "tools" -> Lucide.Wrench
    else -> Lucide.Info
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
    val chatError by shell.chatError.collectAsState()
    LaunchedEffect(Unit) { if (chats.items.isEmpty()) shell.reloadChats() }
    // Categories and the channels' conversations (ChatGroups.kt); read again while the list is open.
    val extras by shell.extras.state.collectAsState()
    val dialogs = rememberChatGroupsDialogs()
    val session by shell.session.collectAsState()
    androidx.compose.runtime.DisposableEffect(Unit) {
        shell.extras.watch(true)
        onDispose { shell.extras.watch(false) }
    }
    // The order the person dragged the chats into, for this view (ChatOrder.kt), over the hub's.
    val graph = LocalContext.current.graph
    val manual by graph.chatOrder.order.collectAsState()
    LaunchedEffect(chats.profileFilter) { graph.chatOrder.use(ChatOrder.scope(chats.profileFilter)) }
    val arranged = ChatOrder.arrange(chats.items, manual)
    val pinned = arranged.filter { it.pinned }
    val conversations = ChatGroupsRules.visible(extras.conversations, extras.showHidden, chats.archive, chats.query)
    val groups = ChatGroupsRules.group(
        arranged.filter { !it.pinned }, extras.categories, conversations,
        keepEmpty = chats.query.isBlank() && chats.archive != ArchiveFilter.ARCHIVED,
    )
    val move: (Session) -> Unit = { dialogs.moving = it }
    // Dragging a chat (a long press, then move): where it lands decides what happens.
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    val drag = remember { ChatDrag() }
    val groupOfKey: Map<Any, String> = buildMap {
        put("pinned", "pinned")
        pinned.forEach { put("p" + it.id, "pinned") }
        groups.forEach { g ->
            put(g.key, g.key)
            g.items.forEach { s -> put(if (g is ChatGroup.Rest) s.id else g.key + ":" + s.id, g.key) }
        }
    }
    val sessionOfKey: Map<Any, String> = buildMap {
        pinned.forEach { put("p" + it.id, it.id) }
        groups.forEach { g -> g.items.forEach { s -> put(if (g is ChatGroup.Rest) s.id else g.key + ":" + s.id, s.id) } }
    }
    val categoryProfiles = extras.categories.associate { it.id to it.profile }
    val onDrop: (Session, String, Any, List<String>, Float) -> Unit = { session, group, key, shown, dy ->
        val placed = listState.layoutInfo.visibleItemsInfo.map { ChatOrder.Placed(it.key, it.offset, it.size) }
        val target = ChatOrder.landing(placed, key, dy)
        when (val outcome = ChatOrder.outcome(session, group, target?.let(groupOfKey::get), categoryProfiles)) {
            is ChatOrder.Outcome.Move -> shell.extras.write({ it.move(session, outcome.categoryId) }, after = shell::reloadChats)
            ChatOrder.Outcome.Reorder -> sessionOfKey[target]?.let { other -> ChatOrder.drop(session.id, other, shown)?.let(graph.chatOrder::save) }
            ChatOrder.Outcome.None -> Unit
        }
    }
    val rowOf: @Composable (Session, String, Any, List<String>) -> Unit = { session, group, key, shown ->
        ChatRow(session, badges, shell, nav, onOpen, move, drag = drag, dragKey = key, shown = shown, onDrop = { dy -> onDrop(session, group, key, shown, dy) },
            onStep = { offset -> ChatOrder.step(session.id, offset, shown)?.let(graph.chatOrder::save) })
    }
    LazyColumn(Modifier.fillMaxSize().testTag("chats.list"), state = listState, contentPadding = PaddingValues(bottom = 8.dp)) {
        item(key = "header") { header() }
        item(key = "search") { ChatsSearch(shell) }
        if (selected.isNotEmpty()) item(key = "batch") { BatchBar(shell, selected.size) }
        chats.error?.let { error -> item(key = "error") { ErrorNotice(error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) } }
        chatError?.let { error ->
            item(key = "chat-error") {
                ErrorNotice(error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp).clickable(onClick = shell::dismissChatError))
            }
        }
        extras.error?.let { error ->
            item(key = "groups-error") {
                ErrorNotice(error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp).clickable(onClick = shell.extras::dismissError))
            }
        }
        if (pinned.isNotEmpty()) {
            item(key = "pinned") { SectionLabel(stringResource(R.string.chats_pinned)) }
            val shownPinned = pinned.map { it.id }
            items(pinned, key = { "p" + it.id }) { rowOf(it, "pinned", "p" + it.id, shownPinned) }
        }
        chatGroups(
            groups, extras, extras.categories, shell, nav, dialogs, badges, isAdmin = session?.user?.isAdmin == true,
            folded = chats.query.isBlank(), onOpen = onOpen, row = rowOf,
        )
        if (chats.nextCursor != null) {
            item(key = "more") {
                LaunchedEffect(chats.items.size) { shell.loadMore() }
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { Spinner(18.dp, t.textMuted) }
            }
        }
        if (!chats.loading && chats.items.isEmpty() && conversations.isEmpty() && chats.error == null) {
            item(key = "empty") {
                Text(stringResource(R.string.chats_empty), fontSize = FontTokens.sizeSm.sp, color = t.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp))
            }
        }
        chatGroupsFooter(extras, chats.archive, shell, dialogs, newCategoryProfile = chats.profileFilter ?: session?.profile.orEmpty())
    }
    ChatGroupsDialogsView(dialogs, extras.categories, shell, nav)
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
private fun ChatRow(
    session: Session,
    badge: Boolean,
    shell: ShellViewModel,
    nav: Navigator,
    onOpen: () -> Unit,
    onMove: ((Session) -> Unit)? = null,
    drag: ChatDrag? = null,
    dragKey: Any = session.id,
    shown: List<String> = emptyList(),
    onDrop: (Float) -> Unit = {},
    onStep: (Int) -> Unit = {},
) {
    val t = LocalTokens.current
    val picked by shell.selected.collectAsState()
    val selecting = picked.isNotEmpty()
    val chosen = session.id in picked
    val selected = chosen || (!selecting && (nav.current as? Route.Chat)?.sessionId == session.id)
    // A long press offers the chat's own actions, and Select, which starts batch mode (apps batch 1).
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    val deleting = hub.core.android.ui.components.rememberConfirmDelete<Session>()
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val lifted = drag?.key == dragKey
    val tap = {
        if (selecting) shell.toggleSelected(session.id)
        else { nav.go(Route.Chat(session.id, session.profile)); onOpen() }
    }
    val longPress = { if (selecting) shell.toggleSelected(session.id) else menu = true }
    // The gesture outlives a recomposition: it always calls the latest of these (the group's order moves).
    val onTap by androidx.compose.runtime.rememberUpdatedState(tap)
    val onLong by androidx.compose.runtime.rememberUpdatedState(longPress)
    val dropped by androidx.compose.runtime.rememberUpdatedState(onDrop)
    Box(
        Modifier.zIndex(if (lifted) 1f else 0f)
            .graphicsLayer { translationY = if (lifted) drag?.dy ?: 0f else 0f; shadowElevation = if (lifted) 8f else 0f },
    ) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(ItemShape)
            .background(if (selected || lifted) t.surface2 else Color.Transparent, ItemShape)
            // A tap opens; a long press opens the menu, or — moved before letting go — drags the chat (ChatOrder.kt).
            .pointerInput(session.id, selecting, dragKey) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val long = awaitLongPressOrCancellation(down.id)
                    if (long == null) {
                        val ev = currentEvent
                        if (ev.changes.all { it.changedToUp() } && ev.changes.none { it.isConsumed }) onTap()
                        return@awaitEachGesture
                    }
                    if (selecting || drag == null) {
                        onLong()
                        return@awaitEachGesture
                    }
                    haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                    drag.key = dragKey
                    drag.dy = 0f
                    var moved = 0f
                    val finished = drag(long.id) { change ->
                        val step = change.positionChange().y
                        moved += kotlin.math.abs(step)
                        drag.dy += step
                        change.consume()
                    }
                    val dy = drag.dy
                    drag.key = null
                    drag.dy = 0f
                    if (moved < ChatOrder.DRAG_SLOP_PX) onLong() else if (finished) dropped(dy)
                }
            }
            .semantics {
                onClick { tap(); true }
                onLongClick { longPress(); true }
            }
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
    HubMenu(menu, { menu = false }) {
        MenuItem(stringResource(R.string.chat_controls_select), { menu = false; shell.toggleSelected(session.id) }, Modifier.testTag("chat.row.select"), icon = Lucide.CircleCheck)
        if (session.source != hub.core.client.model.SessionSource.GLOBAL_AGENT) {
            MenuItem(stringResource(R.string.chat_controls_rename), { menu = false; renaming = true }, Modifier.testTag("chat.row.rename"), icon = Lucide.Pencil)
            MenuItem(
                stringResource(if (session.pinned) R.string.chat_controls_unpin else R.string.chat_controls_pin),
                { menu = false; shell.changeChat(session, hub.core.client.model.SessionPatch(pinned = !session.pinned)) },
                Modifier.testTag("chat.row.pin"), icon = if (session.pinned) Lucide.PinOff else Lucide.Pin,
            )
            MenuItem(
                stringResource(if (session.archived) R.string.chat_controls_unarchive else R.string.chat_controls_archive),
                { menu = false; shell.changeChat(session, hub.core.client.model.SessionPatch(archived = !session.archived)) },
                Modifier.testTag("chat.row.archive"), icon = if (session.archived) Lucide.ArchiveRestore else Lucide.Archive,
            )
            if (onMove != null) {
                MenuItem(stringResource(R.string.cat_move_to), { menu = false; onMove(session) }, Modifier.testTag("chat.row.move"), icon = Lucide.Tag)
            }
            // The same order a drag makes, without dragging (and for TalkBack).
            if (ChatOrder.step(session.id, -1, shown) != null) {
                MenuItem(stringResource(R.string.order_move_up), { menu = false; onStep(-1) }, Modifier.testTag("chat.row.up"), icon = Lucide.ChevronUp)
            }
            if (ChatOrder.step(session.id, 1, shown) != null) {
                MenuItem(stringResource(R.string.order_move_down), { menu = false; onStep(1) }, Modifier.testTag("chat.row.down"), icon = Lucide.ChevronDown)
            }
            MenuDivider()
            MenuItem(
                stringResource(R.string.chat_controls_delete), { menu = false; deleting.ask(session) },
                Modifier.testTag("chat.row.delete"), icon = Lucide.Trash, danger = true,
            )
        }
    }
    }
    if (renaming) {
        hub.core.android.ui.components.RenameDialog(session.title.orEmpty(), onDismiss = { renaming = false }) { title ->
            renaming = false
            shell.changeChat(session, hub.core.client.model.SessionPatch(title = title))
        }
    }
    hub.core.android.ui.components.ConfirmDeleteDialog(
        deleting, { hub.core.android.ui.components.deleteTitle(it.title ?: stringResource(R.string.term_new_chat)) },
        onDelete = { shell.deleteChat(it) },
        onDeleted = { gone -> if ((nav.current as? Route.Chat)?.sessionId == gone.id) nav.go(Route.NewChat) },
        body = stringResource(R.string.chat_controls_delete_body),
    )
}

/** The chat being dragged, and how far. */
class ChatDrag {
    var key by mutableStateOf<Any?>(null)
    var dy by androidx.compose.runtime.mutableFloatStateOf(0f)
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
            // The repository, beside Settings (owner, 2026-10-27), as on the web and iOS.
            val uri = LocalUriHandler.current
            HubIconButton(R.drawable.github_mark, stringResource(R.string.shell_repository), { uri.openUri(Product.REPOSITORY_URL) }, size = ControlTokens.heightMd.dp, iconSize = 18.dp, modifier = Modifier.testTag("footer.repository"))
            HubIconButton(Lucide.LogOut, term("sign_out"), shell::signOut, size = ControlTokens.heightMd.dp, iconSize = 18.dp, tint = t.danger, modifier = Modifier.testTag("footer.sign_out"))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val lang = graph.prefs.effectiveLanguage
            Row(
                Modifier.clip(ItemShape).clickable {
                    graph.prefs.language = AppLanguage.next(lang)
                    (context as? Activity)?.recreate()
                }.padding(horizontal = 4.dp, vertical = 6.dp).testTag("footer.language"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LucideIcon(Lucide.Globe, stringResource(R.string.shell_language), size = 16.dp, tint = t.accent)
                Text(AppLanguage.next(lang).info.nativeName, fontSize = FontTokens.sizeSm.sp, color = t.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
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

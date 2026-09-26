package hub.core.android.ui.screens

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.AppLanguage
import hub.core.android.BuildConfig
import hub.core.android.R
import hub.core.android.generated.Terms
import hub.core.android.graph
import hub.core.android.nav.Navigator
import hub.core.android.nav.Route
import hub.core.android.nav.Screens
import hub.core.android.ui.components.BrandName
import hub.core.android.ui.components.DismissKeyboardWhenDrawerMoves
import hub.core.android.ui.components.keyboardSink
import hub.core.android.ui.components.rememberKeyboardDismisser
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.Glyphs
import hub.core.android.ui.components.ProfileBadge
import hub.core.android.ui.theme.LocalGlassLevel
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.ThemeChoice
import hub.core.android.ui.theme.glass
import hub.core.client.model.Session
import kotlinx.coroutines.launch

/** What the destinations the shell can open draw, handed in so the shell stays one file. */
typealias DestinationContent = @Composable (route: Route, nav: Navigator, shell: ShellViewModel, openDrawer: () -> Unit) -> Unit

/**
 * The signed-in app: the drawer is the sidebar (NAVIGATION.md §1, identical on every surface,
 * with a close button on the phone), the page beside it takes the whole width.
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

    BackHandler(enabled = drawer.isOpen || nav.stack.size > 1) {
        if (drawer.isOpen) closeDrawer() else nav.back()
    }
    if (session == null) return

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = LocalTokens.current.bgRaised,
                drawerShape = RoundedCornerShape(topEnd = 16.dp, bottomEnd = 16.dp),
            ) {
                // The drawer takes focus from the composer as it opens (and the keyboard goes).
                Box(Modifier.keyboardSink(keyboard)) { Sidebar(shell, nav, onClose = closeDrawer) }
            }
        },
    ) {
        content(nav.current, nav, shell, openDrawer)
    }
}

/** The floating top bar (glass): the drawer button, the page's title, and room for actions. */
@Composable
fun TopBar(title: String, onMenu: (() -> Unit)?, onBack: (() -> Unit)? = null, subtitle: String? = null, actions: @Composable () -> Unit = {}) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 8.dp, vertical = 4.dp)
            .glass(t, LocalGlassLevel.current, RoundedCornerShape(16.dp)).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            onBack != null -> IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back))
            }
            onMenu != null -> IconButton(onClick = onMenu) { Icon(Icons.Default.Menu, stringResource(R.string.menu_open)) }
        }
        Column(Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 8.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.labelSmall, color = t.textMuted, maxLines = 1)
        }
        actions()
    }
}

/** A term from navigation.json, in the UI language (the entry's label equals the screen's title). */
@Composable
fun term(key: String): String = Terms.ids[key]?.let { stringResource(it) } ?: key

private enum class Segment { CHAT, ROOMS }

@Composable
private fun Sidebar(shell: ShellViewModel, nav: Navigator, onClose: () -> Unit) {
    val t = LocalTokens.current
    val session by shell.session.collectAsState()
    val s = session ?: return
    var segment by rememberSaveable { mutableStateOf(if (nav.current is Route.Room) Segment.ROOMS else Segment.CHAT) }
    // imePadding: while the drawer's search has the keyboard, the footer (account, language,
    // theme, sign out, version) rides above it instead of under it.
    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            BrandName(Modifier.weight(1f))
            IconButton(onClick = onClose) { Icon(Icons.Default.Close, stringResource(R.string.menu_close)) }
        }
        ProfileSwitcher(shell, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        val go: (Route) -> Unit = { route -> nav.go(route); onClose() }
        RailRow("new_chat", Icons.Default.Add, nav.current == Route.NewChat) { go(Route.NewChat) }
        RailRow("search", Icons.Default.Search, nav.current == Route.Search) { go(Route.Search) }
        if (Screens.visible("agent_manager", s.user.isAdmin)) {
            RailRow("agent_manager", Icons.Default.Person, nav.current == Route.Agents) { go(Route.Agents) }
        }
        RailRow("tasks", Icons.Default.CheckCircle, nav.current == Route.Tasks) { go(Route.Tasks) }
        RailRow("schedules", Icons.Default.DateRange, nav.current == Route.Schedules) { go(Route.Schedules) }
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Segment.entries.forEachIndexed { i, seg ->
                SegmentedButton(
                    selected = segment == seg,
                    onClick = { segment = seg },
                    shape = SegmentedButtonDefaults.itemShape(i, Segment.entries.size),
                ) { Text(term(if (seg == Segment.CHAT) "chat" else "rooms")) }
            }
        }
        Box(Modifier.weight(1f)) {
            when (segment) {
                Segment.CHAT -> ChatsPanel(shell, nav, onOpen = onClose)
                Segment.ROOMS -> RoomsPanel(nav, onOpen = onClose)
            }
        }
        HorizontalDivider(color = t.border)
        Footer(shell, nav, onClose)
    }
}

@Composable
private fun RailRow(destination: String, icon: ImageVector, selected: Boolean, onClick: () -> Unit) {
    NavigationDrawerItem(
        label = { Text(term(destination)) },
        icon = { Icon(icon, null) },
        selected = selected,
        onClick = onClick,
        modifier = Modifier.padding(horizontal = 12.dp),
    )
}

/**
 * The top selector — always one concrete profile, never «all» (ADR 0016). On the phone it lives
 * here at the top of the drawer instead of a permanent top bar (proposed — owner to confirm):
 * it takes no space from the chat or the board, and the new-chat screen names the profile the
 * chat will be made in.
 */
@Composable
fun ProfileSwitcher(shell: ShellViewModel, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    val session by shell.session.collectAsState()
    val profiles by shell.profiles.collectAsState()
    val s = session ?: return
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Surface(
            color = t.surface2, shape = CircleShape,
            modifier = Modifier.clickable(enabled = profiles.size > 1) { open = true },
        ) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.profile_label), style = MaterialTheme.typography.labelSmall, color = t.textMuted)
                Spacer(Modifier.size(6.dp))
                Text(shell.profileName(s.profile), style = MaterialTheme.typography.labelLarge)
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            profiles.forEach { p ->
                DropdownMenuItem(
                    text = { Text(p.name) },
                    onClick = { shell.switchProfile(p.slug); open = false },
                    trailingIcon = if (p.slug == s.profile) ({ Icon(Icons.Default.CheckCircle, null) }) else null,
                )
            }
        }
    }
}

@Composable
private fun ChatsPanel(shell: ShellViewModel, nav: Navigator, onOpen: () -> Unit) {
    val t = LocalTokens.current
    val chats by shell.chats.collectAsState()
    val profiles by shell.profiles.collectAsState()
    val badges = ChatsList.showsProfiles(chats, profiles.size)
    LaunchedEffect(Unit) { if (chats.items.isEmpty()) shell.reloadChats() }
    Column {
        if (profiles.size > 1) {
            // The chats list's own filter: «all profiles» by default; it never moves the selector.
            LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                item {
                    FilterChip(chats.profileFilter == null, { shell.setProfileFilter(null) }, label = { Text(stringResource(R.string.chats_all_profiles)) })
                }
                items(profiles, key = { it.slug }) { p ->
                    FilterChip(chats.profileFilter == p.slug, { shell.setProfileFilter(p.slug) }, label = { Text(p.name) })
                }
            }
        }
        var query by rememberSaveable { mutableStateOf(chats.query) }
        OutlinedTextField(
            value = query,
            onValueChange = { query = it; shell.setQuery(it) },
            placeholder = { Text(stringResource(R.string.chats_search)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        )
        LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(ArchiveFilter.entries) { f ->
                FilterChip(
                    chats.archive == f, { shell.setArchive(f) },
                    label = {
                        Text(stringResource(when (f) { ArchiveFilter.ACTIVE -> R.string.chats_active; ArchiveFilter.ARCHIVED -> R.string.chats_archived; ArchiveFilter.ALL -> R.string.chats_all }))
                    },
                )
            }
        }
        chats.error?.let { ErrorNotice(it, Modifier.padding(16.dp)) }
        val selected by shell.selected.collectAsState()
        if (selected.isNotEmpty()) BatchBar(shell, selected.size)
        val pinned = chats.items.filter { it.pinned }
        val recent = chats.items.filter { !it.pinned }
        LazyColumn(Modifier.fillMaxSize()) {
            if (pinned.isNotEmpty()) {
                item { SectionLabel(stringResource(R.string.chats_pinned)) }
                items(pinned, key = { "p" + it.id }) { ChatRow(it, badges, shell, nav, onOpen) }
            }
            item { SectionLabel(stringResource(R.string.chats_recent, recent.size)) }
            items(recent, key = { it.id }) { ChatRow(it, badges, shell, nav, onOpen) }
            if (chats.nextCursor != null) {
                item {
                    LaunchedEffect(chats.items.size) { shell.loadMore() }
                    Text(stringResource(R.string.loading), color = t.textMuted, modifier = Modifier.padding(16.dp))
                }
            }
            if (!chats.loading && chats.items.isEmpty() && chats.error == null) {
                item { Text(stringResource(R.string.chats_empty), color = t.textMuted, modifier = Modifier.padding(16.dp)) }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = LocalTokens.current.textMuted, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
}

/**
 * The chats list's batch mode (a long press on a chat): how many are selected, and archive,
 * bring back or delete them all — deleting asks first.
 */
@Composable
private fun BatchBar(shell: ShellViewModel, count: Int) {
    val t = LocalTokens.current
    val busy by shell.batchBusy.collectAsState()
    val error by shell.batchError.collectAsState()
    var confirm by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("chats.batch")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = shell::clearSelection) { Icon(Icons.Default.Close, stringResource(R.string.chats_batch_done)) }
            Text(stringResource(R.string.chats_batch_selected, count), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { shell.archiveSelected(true) }, enabled = !busy, modifier = Modifier.testTag("chats.batch.archive")) { Text(stringResource(R.string.chats_batch_archive)) }
            TextButton(onClick = { shell.archiveSelected(false) }, enabled = !busy, modifier = Modifier.testTag("chats.batch.unarchive")) { Text(stringResource(R.string.chats_batch_unarchive)) }
            TextButton(onClick = { confirm = true }, enabled = !busy, modifier = Modifier.testTag("chats.batch.delete")) { Text(stringResource(R.string.chats_batch_delete), color = t.danger) }
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = t.danger) }
    }
    if (confirm) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.chats_batch_delete_title, count)) },
            text = { Text(stringResource(R.string.chats_batch_delete_body)) },
            confirmButton = {
                TextButton(onClick = { confirm = false; shell.deleteSelected() }) { Text(stringResource(R.string.chats_batch_delete), color = t.danger) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(session: Session, badge: Boolean, shell: ShellViewModel, nav: Navigator, onOpen: () -> Unit) {
    val t = LocalTokens.current
    val picked by shell.selected.collectAsState()
    val selecting = picked.isNotEmpty()
    val chosen = session.id in picked
    val selected = chosen || (!selecting && (nav.current as? Route.Chat)?.sessionId == session.id)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp)
            .background(if (selected) t.accentSoft else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(12.dp))
            .combinedClickable(
                onClick = {
                    if (selecting) shell.toggleSelected(session.id)
                    else { nav.go(Route.Chat(session.id, session.profile)); onOpen() }
                },
                onLongClick = { shell.toggleSelected(session.id) },
            )
            .padding(horizontal = 8.dp, vertical = 8.dp)
            .testTag("chat.row.${session.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selecting) {
            androidx.compose.material3.Checkbox(checked = chosen, onCheckedChange = { shell.toggleSelected(session.id) })
        }
        Column(Modifier.weight(1f)) {
            Text(session.title ?: stringResource(R.string.term_new_chat), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            session.preview?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = t.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (session.pinned) Icon(Icons.Default.Star, stringResource(R.string.chats_pinned), tint = t.textFaint, modifier = Modifier.size(14.dp))
        if (badge) ProfileBadge(shell.profileName(session.profile), Modifier.padding(start = 6.dp))
    }
}

@Composable
private fun Footer(shell: ShellViewModel, nav: Navigator, onClose: () -> Unit) {
    val t = LocalTokens.current
    val context = LocalContext.current
    val graph = context.graph
    val session by shell.session.collectAsState()
    val connected by graph.realtime.connected.collectAsState()
    val theme by graph.prefs.theme.collectAsState()
    val s = session ?: return
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(if (connected) t.statusRunning else t.textFaint, CircleShape))
            Spacer(Modifier.size(8.dp))
            Text(s.user.displayName, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f), maxLines = 1)
            IconButton(onClick = { nav.go(Route.Settings); onClose() }) { Icon(Icons.Default.Settings, term("settings")) }
            IconButton(onClick = shell::signOut) { Icon(Icons.AutoMirrored.Filled.ExitToApp, term("sign_out")) }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            val lang = graph.prefs.effectiveLanguage
            TextButton(onClick = {
                graph.prefs.language = if (lang == AppLanguage.AR) AppLanguage.EN else AppLanguage.AR
                (context as? Activity)?.recreate()
            }) { Text(if (lang == AppLanguage.AR) "English" else "العربية") }
            ThemeChoice.entries.forEach { choice ->
                val (icon, label) = when (choice) {
                    ThemeChoice.LIGHT -> Glyphs.Sun to R.string.theme_light
                    ThemeChoice.DARK -> Glyphs.Moon to R.string.theme_dark
                    ThemeChoice.SYSTEM -> Glyphs.Screen to R.string.theme_system
                }
                IconButton(onClick = { graph.prefs.setTheme(choice) }) {
                    Icon(icon, stringResource(label), tint = if (theme == choice) t.accent else t.textMuted, modifier = Modifier.size(20.dp))
                }
            }
            Spacer(Modifier.weight(1f))
            Text(BuildConfig.VERSION_NAME, style = MaterialTheme.typography.labelSmall, color = t.textFaint)
        }
    }
}

package us.i3u.hermesstudio.ui.sessions

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.AvatarSpec
import us.i3u.hermesstudio.ConfirmDialog
import us.i3u.hermesstudio.ProfileAvatar
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.SessionCategory
import us.i3u.hermesstudio.SessionSummary
import us.i3u.hermesstudio.TextPromptDialog
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * The web's session list: RECENT / Pinned / categories / Uncategorized groups
 * with collapsible 10/600 uppercase headers, two-line rows, a 500 ms long-press
 * context menu and the ✕ delete affordance. Lives in the drawer and, with a
 * search field, on the History page.
 */
@Composable
fun SessionListPane(
    state: UiState,
    viewModel: AppViewModel,
    modifier: Modifier = Modifier,
    showSearch: Boolean = false,
    focusSearch: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
    /** History only: long-press starts a batch selection and the archived list is shown. */
    selectable: Boolean = false,
    /** Items rendered above the groups inside the same scroll (the drawer's rail and switch). */
    header: (LazyListScope.() -> Unit)? = null,
    onOpen: (SessionSummary) -> Unit,
) {
    val palette = CoreHub.palette
    var query by rememberSaveable { mutableStateOf("") }
    var rename by remember { mutableStateOf<SessionSummary?>(null) }
    var confirmDelete by remember { mutableStateOf<SessionSummary?>(null) }
    var categoryFor by remember { mutableStateOf<SessionSummary?>(null) }
    var newCategory by remember { mutableStateOf(false) }
    var editCategory by remember { mutableStateOf<SessionCategory?>(null) }
    var deleteCategory by remember { mutableStateOf<SessionCategory?>(null) }
    var recentCountDialog by remember { mutableStateOf(false) }
    var moveCategory by remember { mutableStateOf<SessionCategory?>(null) }
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    val selecting = selectable && state.sessionSelectionMode

    LaunchedEffect(query) { if (showSearch) viewModel.searchSessions(query) }
    LaunchedEffect(Unit) { if (state.sessionCategories.isEmpty()) viewModel.loadSessionCategories() }

    val searching = showSearch && query.isNotBlank()
    val archived = selectable && state.showArchived
    val visible = when {
        archived -> state.archivedSessions
        searching -> state.sessionSearchResults.orEmpty()
        else -> state.sessions
    }
    val recentLabel = stringResource(R.string.sessions_recent)
    val pinnedLabel = stringResource(R.string.sessions_pinned)
    val uncategorizedLabel = stringResource(R.string.sessions_uncategorized)
    val groups = remember(visible, state.sessionCategories, state.pinnedSessionIds, state.recentCount, searching, archived) {
        if (searching || archived) {
            listOf(SessionGroup("search", "", SessionGroupKind.Uncategorized, visible))
        } else {
            buildSessionGroups(
                visible, state.sessionCategories, state.pinnedSessionIds, state.recentCount,
                recentLabel, pinnedLabel, uncategorizedLabel,
            )
        }
    }
    val streamingId = state.openSession?.id?.takeIf { state.sending }

    rename?.let { session ->
        TextPromptDialog(
            title = stringResource(R.string.chats_rename_title),
            initial = session.title,
            hint = session.title,
            action = stringResource(R.string.action_rename),
            onConfirm = { viewModel.renameSession(session, it); rename = null },
            onDismiss = { rename = null },
        )
    }
    confirmDelete?.let { session ->
        ConfirmDialog(
            title = stringResource(R.string.chats_delete_title),
            body = stringResource(R.string.chats_delete_body),
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.deleteSession(session); confirmDelete = null },
            onDismiss = { confirmDelete = null },
        )
    }
    categoryFor?.let { session ->
        CategoryPickerDialog(
            categories = state.sessionCategories,
            current = session.categoryId,
            onPick = { id -> viewModel.setSessionCategory(session, id); categoryFor = null },
            onNew = { categoryFor = null; newCategory = true },
            onDismiss = { categoryFor = null },
        )
    }
    if (newCategory) TextPromptDialog(
        title = stringResource(R.string.session_new_category),
        initial = "",
        hint = stringResource(R.string.session_category_name),
        action = stringResource(R.string.action_create),
        onConfirm = { viewModel.createSessionCategory(it); newCategory = false },
        onDismiss = { newCategory = false },
    )
    editCategory?.let { category ->
        TextPromptDialog(
            title = stringResource(R.string.session_category_edit),
            initial = category.name,
            hint = category.name,
            action = stringResource(R.string.action_save),
            onConfirm = { viewModel.renameSessionCategory(category, it); editCategory = null },
            onDismiss = { editCategory = null },
        )
    }
    deleteCategory?.let { category ->
        ConfirmDialog(
            title = stringResource(R.string.action_delete),
            body = category.name,
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.deleteSessionCategory(category); deleteCategory = null },
            onDismiss = { deleteCategory = null },
        )
    }
    moveCategory?.let { category ->
        CategoryPickerDialog(
            categories = state.sessionCategories.filterNot { it.id == category.id },
            current = category.id,
            onPick = { id -> viewModel.moveCategorySessions(category, id); moveCategory = null },
            onNew = { moveCategory = null; newCategory = true },
            onDismiss = { moveCategory = null },
        )
    }
    if (recentCountDialog) {
        RecentCountDialog(
            current = state.recentCount,
            onSave = { viewModel.setRecentCount(it); recentCountDialog = false },
            onDismiss = { recentCountDialog = false },
        )
    }

    LazyColumn(modifier = modifier, contentPadding = contentPadding) {
        header?.invoke(this)
        if (showSearch) {
            item {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(stringResource(R.string.nav_search)) },
                    leadingIcon = { Icon(CoreHubIcons.Search, contentDescription = null, modifier = Modifier.size(18.dp)) },
                    singleLine = true,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                    shape = RoundedCornerShape(CoreHubTokens.Radius.medium),
                    modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                )
            }
        }
        if (state.busy && visible.isEmpty()) item { Text(stringResource(R.string.intro_restoring), style = CoreHubTextStyles.meta, color = palette.textMuted, modifier = Modifier.padding(10.dp)) }
        if (state.loadingArchived && archived) item { Text(stringResource(R.string.intro_restoring), style = CoreHubTextStyles.meta, color = palette.textMuted, modifier = Modifier.padding(10.dp)) }
        if (!state.busy && !state.loadingArchived && visible.isEmpty()) {
            item {
                Text(
                    stringResource(if (archived) R.string.sessions_archived_empty else R.string.chats_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.textMuted,
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                )
            }
        }
        groups.forEach { group ->
            val isCollapsed = collapsed[group.key] == true
            if (group.label.isNotBlank()) {
                item(key = "header-${group.key}") {
                    SessionGroupHeader(
                        group = group,
                        expanded = !isCollapsed,
                        onToggle = { collapsed[group.key] = !isCollapsed },
                        onRecentCount = { recentCountDialog = true },
                        onRenameCategory = { editCategory = it },
                        onDeleteCategory = { deleteCategory = it },
                        onMoveCategory = { moveCategory = it },
                    )
                }
            }
            if (!isCollapsed) {
                items(group.sessions, key = { "${group.key}-${it.id}" }) { session ->
                    SessionRow(
                        session = session,
                        selected = state.openSession?.id == session.id,
                        pinned = session.id in state.pinnedSessionIds,
                        unread = session.id in state.unreadSessionIds,
                        streaming = streamingId == session.id,
                        profileAvatar = state.profiles.firstOrNull { it.name == session.profile }?.avatar,
                        categoryLabel = if (group.kind == SessionGroupKind.Recent) {
                            state.sessionCategories.firstOrNull { it.id == session.categoryId }?.name
                        } else null,
                        selectionMode = selecting,
                        checked = session.id in state.sessionSelection,
                        onClick = { if (selecting) viewModel.toggleSessionSelected(session) else onOpen(session) },
                        onDelete = { confirmDelete = session },
                        onRename = { rename = session },
                        onCategory = { categoryFor = session },
                        onArchive = { if (archived) viewModel.unarchiveSession(session) else viewModel.archiveSession(session) },
                        onPin = { viewModel.togglePinnedSession(session) },
                        onExport = { viewModel.exportSession(session) },
                        onSelect = if (selectable) ({ viewModel.toggleSessionSelected(session) }) else null,
                    )
                }
            }
        }
        if (showSearch && !searching && !archived && visible.isNotEmpty()) {
            item { TextButton(onClick = viewModel::loadMoreSessions, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.load_more)) } }
        }
    }
}

/** Chevron 10 px (rotated 90° when expanded), label 10/600 uppercase, count 10 muted. */
@Composable
private fun SessionGroupHeader(
    group: SessionGroup,
    expanded: Boolean,
    onToggle: () -> Unit,
    onRecentCount: () -> Unit,
    onRenameCategory: (SessionCategory) -> Unit,
    onDeleteCategory: (SessionCategory) -> Unit,
    onMoveCategory: (SessionCategory) -> Unit,
) {
    val palette = CoreHub.palette
    val rotation by animateFloatAsState(if (expanded) 90f else 0f, tween(CoreHubTokens.Metrics.transitionFastMs), label = "chevron")
    var menu by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(CoreHubTokens.Radius.small))
            .clickable(onClick = onToggle)
            .padding(start = 6.dp, end = 2.dp, top = 6.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            CoreHubIcons.ChevronRight,
            contentDescription = null,
            tint = palette.textMuted,
            modifier = Modifier.size(CoreHubTokens.Metrics.groupChevron).rotate(rotation),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            group.label.uppercase(),
            style = CoreHubTextStyles.groupHeader,
            color = palette.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(6.dp))
        Text(group.sessions.size.toString(), style = CoreHubTextStyles.groupHeader.copy(fontWeight = null), color = palette.textMuted)
        Spacer(Modifier.weight(1f))
        when (group.kind) {
            SessionGroupKind.Recent -> IconButton(onClick = onRecentCount, modifier = Modifier.size(24.dp)) {
                Icon(CoreHubIcons.Settings, contentDescription = stringResource(R.string.sessions_recent_count), tint = palette.textMuted, modifier = Modifier.size(12.dp))
            }
            SessionGroupKind.Category -> Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(24.dp)) {
                    Icon(CoreHubIcons.More, contentDescription = stringResource(R.string.message_actions), tint = palette.textMuted, modifier = Modifier.size(14.dp))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.action_rename)) }, onClick = { menu = false; group.category?.let(onRenameCategory) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.session_category_move)) }, onClick = { menu = false; group.category?.let(onMoveCategory) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.action_delete)) }, onClick = { menu = false; group.category?.let(onDeleteCategory) })
                }
            }
            else -> Unit
        }
    }
}

/**
 * Row: padding 8×10, radius 6. Line 1: pin · unread dot · title (dir=auto) … time.
 * Line 2: agent avatar 18 px · profile chip · category tag. ✕ at 50 % at the end.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionRow(
    session: SessionSummary,
    selected: Boolean,
    pinned: Boolean,
    unread: Boolean,
    streaming: Boolean,
    profileAvatar: AvatarSpec?,
    categoryLabel: String?,
    onClick: () -> Unit,
    onDelete: () -> Unit,
    onRename: () -> Unit,
    onCategory: () -> Unit,
    onArchive: () -> Unit,
    onPin: () -> Unit,
    onExport: () -> Unit = {},
    /** Non-null on the History page: long-press also offers "Select". */
    onSelect: (() -> Unit)? = null,
    selectionMode: Boolean = false,
    checked: Boolean = false,
) {
    val palette = CoreHub.palette
    var menu by remember { mutableStateOf(false) }
    val base = LocalViewConfiguration.current
    val longPress = remember(base) {
        object : ViewConfiguration by base {
            override val longPressTimeoutMillis: Long get() = CoreHubTokens.Metrics.longPressMs
        }
    }
    CompositionLocalProvider(LocalViewConfiguration provides longPress) {
        Box {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(CoreHubTokens.Radius.small))
                    .background(if (selected) palette.selected else Color.Transparent)
                    .combinedClickable(onClick = onClick, onLongClick = { menu = true })
                    .padding(horizontal = CoreHubTokens.Metrics.sessionRowPaddingH, vertical = CoreHubTokens.Metrics.sessionRowPaddingV),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (selectionMode) {
                    Checkbox(checked = checked, onCheckedChange = { onSelect?.invoke() }, modifier = Modifier.size(28.dp))
                    Spacer(Modifier.width(6.dp))
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (pinned) {
                            Icon(CoreHubIcons.Pin, contentDescription = stringResource(R.string.session_pin), tint = palette.accent, modifier = Modifier.size(CoreHubTokens.Metrics.pinSize))
                            Spacer(Modifier.width(4.dp))
                        }
                        if (unread) {
                            Box(
                                Modifier
                                    .size(CoreHubTokens.Metrics.unreadDot + 6.dp)
                                    .background(palette.accent.copy(alpha = CoreHubTokens.Alpha.UNREAD_HALO), CircleShape)
                                    .padding(3.dp)
                                    .background(palette.accent, CircleShape),
                            )
                            Spacer(Modifier.width(4.dp))
                        }
                        Text(
                            session.title,
                            style = CoreHubTextStyles.sessionTitle.copy(
                                textDirection = TextDirection.Content,
                                fontWeight = if (selected) CoreHubTokens.Type.selectedWeight else null,
                            ),
                            color = palette.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(formatStamp(session.updatedAt), style = CoreHubTextStyles.meta, color = palette.textMuted, maxLines = 1)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        AgentAvatar(ChatAgentAvatars.forSession(session), streaming = streaming)
                        session.profile?.takeIf { it.isNotBlank() }?.let { profile ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                ProfileAvatar(profile, profileAvatar, size = CoreHubTokens.Metrics.profileChipAvatar)
                                Text(profile, style = CoreHubTextStyles.meta, color = palette.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        categoryLabel?.let { label ->
                            Text(
                                label,
                                style = CoreHubTextStyles.categoryTag,
                                color = palette.textSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                // ≈ 45 % of a drawer-width row, the web's max-width for the tag.
                                modifier = Modifier
                                    .widthIn(max = 120.dp)
                                    .background(palette.tagBackground, RoundedCornerShape(CoreHubTokens.Radius.tag))
                                    .padding(horizontal = 6.dp, vertical = 1.dp),
                            )
                        }
                    }
                }
                if (!selectionMode) {
                    IconButton(onClick = onDelete, modifier = Modifier.size(24.dp).alpha(CoreHubTokens.Alpha.DELETE_AFFORDANCE)) {
                        Icon(CoreHubIcons.Close, contentDescription = stringResource(R.string.action_delete), tint = palette.textSecondary, modifier = Modifier.size(14.dp))
                    }
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                onSelect?.let { select ->
                    DropdownMenuItem(text = { Text(stringResource(R.string.session_select)) }, onClick = { menu = false; select() })
                }
                DropdownMenuItem(text = { Text(stringResource(R.string.action_rename)) }, onClick = { menu = false; onRename() })
                DropdownMenuItem(text = { Text(stringResource(if (pinned) R.string.session_unpin else R.string.session_pin)) }, onClick = { menu = false; onPin() })
                DropdownMenuItem(text = { Text(stringResource(R.string.session_category)) }, onClick = { menu = false; onCategory() })
                DropdownMenuItem(text = { Text(stringResource(if (session.archived) R.string.session_unarchive else R.string.session_archive)) }, onClick = { menu = false; onArchive() })
                DropdownMenuItem(text = { Text(stringResource(R.string.session_export)) }, onClick = { menu = false; onExport() })
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.action_delete), color = palette.error) },
                    onClick = { menu = false; onDelete() },
                )
            }
        }
    }
}

@Composable
private fun CategoryPickerDialog(
    categories: List<SessionCategory>,
    current: Int?,
    onPick: (Int?) -> Unit,
    onNew: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.session_category)) },
        text = {
            Column {
                CategoryChoice(stringResource(R.string.sessions_uncategorized), current == null) { onPick(null) }
                categories.forEach { category -> CategoryChoice(category.name, current == category.id) { onPick(category.id) } }
            }
        },
        confirmButton = { TextButton(onClick = onNew) { Text(stringResource(R.string.session_new_category)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun CategoryChoice(label: String, selected: Boolean, onClick: () -> Unit) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(CoreHubTokens.Radius.small))
            .background(if (selected) palette.selected else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (selected) Text("✓", color = palette.accent)
    }
}

/** The RECENT gear: how many sessions the group shows (1–100). */
@Composable
private fun RecentCountDialog(current: Int, onSave: (Int) -> Unit, onDismiss: () -> Unit) {
    var value by rememberSaveable { mutableStateOf(current.toString()) }
    val parsed = value.toIntOrNull()?.takeIf { it in CoreHubTokens.Metrics.recentMin..CoreHubTokens.Metrics.recentMax }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sessions_recent_count)) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it.filter(Char::isDigit).take(3) },
                singleLine = true,
                supportingText = { Text(stringResource(R.string.sessions_recent_count_hint)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                textStyle = CoreHubTextStyles.input.copy(color = LocalContentColor.current),
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = { TextButton(enabled = parsed != null, onClick = { parsed?.let(onSave) }) { Text(stringResource(R.string.action_save)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

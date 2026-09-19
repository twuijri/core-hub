package us.i3u.hermesstudio.ui.groups

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.automirrored.filled.Login
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.AvatarSpec
import us.i3u.hermesstudio.ConfirmDialog
import us.i3u.hermesstudio.ErrorNote
import us.i3u.hermesstudio.LoadingRow
import us.i3u.hermesstudio.NoticeNote
import us.i3u.hermesstudio.ProfileAvatar
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.RoomAgent
import us.i3u.hermesstudio.RoomInfo
import us.i3u.hermesstudio.StudioHorizontalPadding
import us.i3u.hermesstudio.TextPromptDialog
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.ui.navigation.MenuButton
import us.i3u.hermesstudio.ui.sessions.AgentAvatar
import us.i3u.hermesstudio.ui.sessions.ChatAgentAvatars
import us.i3u.hermesstudio.ui.sessions.formatStamp
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * The Group Chat section (the web's GroupChatView room list): one row per
 * room with its agent avatars and activity time, "New room", "Join by code",
 * and a long-press menu (open, clone, delete).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupsScreen(state: UiState, viewModel: AppViewModel, onMenu: () -> Unit) {
    val palette = CoreHub.palette
    var creating by remember { mutableStateOf(false) }
    var joining by remember { mutableStateOf(false) }
    var cloning by remember { mutableStateOf<RoomInfo?>(null) }
    var confirmDelete by remember { mutableStateOf<RoomInfo?>(null) }

    LaunchedEffect(Unit) { if (state.rooms.isEmpty() && !state.loadingRooms) viewModel.refreshRooms() }

    if (creating) {
        NewRoomDialog(state, viewModel, onDismiss = { creating = false })
    }
    if (joining) {
        TextPromptDialog(
            title = stringResource(R.string.room_join_title),
            initial = "",
            hint = stringResource(R.string.room_join_hint),
            action = stringResource(R.string.room_join),
            onConfirm = { viewModel.joinRoomByCode(it); joining = false },
            onDismiss = { joining = false },
        )
    }
    cloning?.let { room ->
        TextPromptDialog(
            title = stringResource(R.string.room_clone),
            initial = stringResource(R.string.room_clone_name, room.name),
            hint = room.name,
            action = stringResource(R.string.room_clone),
            onConfirm = { viewModel.cloneRoom(room, it); cloning = null },
            onDismiss = { cloning = null },
        )
    }
    confirmDelete?.let { room ->
        ConfirmDialog(
            title = stringResource(R.string.groups_delete_title),
            body = stringResource(R.string.groups_delete_body),
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.deleteRoom(room); confirmDelete = null },
            onDismiss = { confirmDelete = null },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.segment_group_chat), style = MaterialTheme.typography.titleLarge) },
                navigationIcon = { MenuButton(onMenu) },
                actions = {
                    IconButton(onClick = { joining = true }) { Icon(Icons.AutoMirrored.Filled.Login, contentDescription = stringResource(R.string.room_join_title), tint = palette.textSecondary) }
                    IconButton(onClick = { viewModel.refreshRooms() }, enabled = !state.loadingRooms) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.textSecondary) }
                    IconButton(onClick = { creating = true }) { Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.groups_new), tint = palette.textPrimary) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.bgPrimary, scrolledContainerColor = palette.bgPrimary),
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = StudioHorizontalPadding, end = StudioHorizontalPadding, top = 8.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (state.loadingRooms && state.rooms.isEmpty()) item { LoadingRow() }
            state.error?.let { message -> item { ErrorNote(message) { viewModel.dismissError() } } }
            state.notice?.let { message -> item { NoticeNote(message) { viewModel.dismissNotice() } } }
            if (!state.loadingRooms && state.rooms.isEmpty()) {
                item {
                    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(CoreHubIcons.Group, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(32.dp))
                        Text(stringResource(R.string.groups_empty), style = MaterialTheme.typography.bodyMedium, color = palette.textMuted)
                        TextButton(onClick = { creating = true }) { Text(stringResource(R.string.groups_new)) }
                    }
                }
            }
            items(state.rooms, key = { it.id }) { room ->
                RoomRow(
                    room = room,
                    selected = state.openRoom?.room?.id == room.id,
                    onClick = { viewModel.openRoom(room) },
                    onClone = { cloning = room },
                    onDelete = { confirmDelete = room },
                )
            }
        }
    }
}

/**
 * Row: name (dir=auto) … activity time; then the agent avatar stack and the
 * seat count, like the web's room list item. Long-press → menu.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoomRow(room: RoomInfo, selected: Boolean, onClick: () -> Unit, onClone: () -> Unit, onDelete: () -> Unit) {
    val palette = CoreHub.palette
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(CoreHubTokens.Radius.medium))
                .background(if (selected) palette.selected else palette.bgCard)
                .combinedClickable(onClick = onClick, onLongClick = { menu = true })
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(40.dp).clip(RoundedCornerShape(CoreHubTokens.Radius.bubble)).background(palette.selected),
                contentAlignment = Alignment.Center,
            ) { Icon(CoreHubIcons.Group, contentDescription = null, tint = palette.textSecondary, modifier = Modifier.size(20.dp)) }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        room.name,
                        style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content, fontWeight = FontWeight.Medium),
                        color = palette.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(formatStamp(room.lastActiveAt?.toString() ?: room.createdAt?.toString()), style = CoreHubTextStyles.meta, color = palette.textMuted)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AgentAvatarStack(room.agents)
                    Text(
                        if (room.agents.isEmpty()) stringResource(R.string.room_no_agents) else stringResource(R.string.room_agent_count, room.agents.size),
                        style = CoreHubTextStyles.meta,
                        color = palette.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (room.workspace.isNotBlank()) {
                        Text(room.workspace.substringAfterLast('/').ifBlank { room.workspace }, style = CoreHubTextStyles.categoryTag.copy(textDirection = TextDirection.Ltr), color = palette.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.background(palette.tagBackground, RoundedCornerShape(CoreHubTokens.Radius.tag)).padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                }
            }
            Icon(CoreHubIcons.ChevronRight, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(14.dp))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.action_open)) }, onClick = { menu = false; onClick() })
            DropdownMenuItem(text = { Text(stringResource(R.string.room_clone)) }, onClick = { menu = false; onClone() })
            DropdownMenuItem(text = { Text(stringResource(R.string.action_delete), color = palette.error) }, onClick = { menu = false; onDelete() })
        }
    }
}

/** Up to four overlapping 18 px agent avatars, "+N" for the rest. */
@Composable
fun AgentAvatarStack(agents: List<RoomAgent>, size: Dp = CoreHubTokens.Metrics.agentAvatar, max: Int = 4) {
    val palette = CoreHub.palette
    val shown = agents.take(max)
    Row(verticalAlignment = Alignment.CenterVertically) {
        shown.forEachIndexed { index, agent ->
            Box(modifier = Modifier.offset(x = (-(size / 3) * index)).size(size)) { RoomAgentAvatar(agent, size) }
        }
        if (agents.size > max) {
            Text(
                "+${agents.size - max}",
                style = CoreHubTextStyles.categoryTag,
                color = palette.textSecondary,
                modifier = Modifier.offset(x = -(size / 3) * (shown.size - 1)).background(palette.tagBackground, CircleShape).padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
    }
}

/** A seat's own picture when it has one, otherwise the agent-family mark (hermes/ekko/claude…). */
@Composable
fun RoomAgentAvatar(agent: RoomAgent, size: Dp = CoreHubTokens.Metrics.agentAvatar, streaming: Boolean = false) {
    val spec = remember(agent.avatar) { agent.avatar.takeIf { it.startsWith("{") }?.let { raw -> runCatching { AvatarSpec.from(JSONObject(raw)) }.getOrNull() } }
    if (spec != null) ProfileAvatar(agent.name, spec, size = size)
    else AgentAvatar(ChatAgentAvatars.forRuntime(agent.agent), size = size, streaming = streaming)
}

/** Name the room, pick its seats (presets or profiles) and an optional workspace. */
@Composable
private fun NewRoomDialog(state: UiState, viewModel: AppViewModel, onDismiss: () -> Unit) {
    val palette = CoreHub.palette
    var name by remember { mutableStateOf("") }
    var workspace by remember { mutableStateOf("") }
    val seats = remember { mutableStateOf(listOf<us.i3u.hermesstudio.RoomAgentDraft>()) }
    var addingSeat by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (state.agentPresets.isEmpty()) viewModel.loadAgentPresets() }

    if (addingSeat) {
        AgentSeatDialog(
            state = state,
            initial = null,
            presets = state.agentPresets,
            title = stringResource(R.string.room_add_agent),
            onSave = { draft -> seats.value = seats.value + draft; addingSeat = false },
            onDismiss = { addingSeat = false },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.groups_new)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    placeholder = { Text(stringResource(R.string.groups_new_hint)) },
                    label = { Text(stringResource(R.string.room_name)) },
                    singleLine = true,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = workspace,
                    onValueChange = { workspace = it },
                    label = { Text(stringResource(R.string.workflow_workspace)) },
                    placeholder = { Text(stringResource(R.string.room_workspace_hint)) },
                    singleLine = true,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Ltr),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(stringResource(R.string.groups_pick_agents), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
                seats.value.forEachIndexed { index, seat ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        AgentAvatar(ChatAgentAvatars.forRuntime(seat.agent))
                        Spacer(Modifier.width(8.dp))
                        Text(seat.name.ifBlank { seat.profile }, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(seat.model.ifBlank { seat.profile }, style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        IconButton(onClick = { seats.value = seats.value.filterIndexed { i, _ -> i != index } }, modifier = Modifier.size(24.dp)) { Icon(CoreHubIcons.Close, contentDescription = stringResource(R.string.action_delete), tint = palette.textMuted, modifier = Modifier.size(14.dp)) }
                    }
                }
                TextButton(onClick = { addingSeat = true }) { Text(stringResource(R.string.room_add_agent)) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && !state.busy,
                onClick = { viewModel.createRoom(name.trim(), seats.value, workspace.trim().ifBlank { null }); onDismiss() },
            ) { Text(stringResource(R.string.action_create)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

package us.i3u.hermesstudio.ui.groups

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import us.i3u.hermesstudio.AgentActivity
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.ChatFileLink
import us.i3u.hermesstudio.ErrorNote
import us.i3u.hermesstudio.GroupAttachment
import us.i3u.hermesstudio.LoadingRow
import us.i3u.hermesstudio.NoticeNote
import us.i3u.hermesstudio.PendingRunAction
import us.i3u.hermesstudio.QueueItem
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.RoomInteraction
import us.i3u.hermesstudio.RoomState
import us.i3u.hermesstudio.StudioTopBar
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.roomTranscript
import us.i3u.hermesstudio.ui.chat.ChatFileCard
import us.i3u.hermesstudio.ui.chat.MessageBubble
import us.i3u.hermesstudio.ui.chat.RunActionCard
import us.i3u.hermesstudio.ui.chat.SpeechState
import us.i3u.hermesstudio.ui.chat.avatarOf
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * A room, like the web's GroupChatPanel: the streamed transcript (agent rows
 * reuse the M3 message row with its tool card and thinking block), the
 * per-agent activity strip with interrupt, typing, the execution queue,
 * approval/clarification cards, and a composer with attachments and @all.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun RoomScreen(state: UiState, viewModel: AppViewModel) {
    val palette = CoreHub.palette
    val room = state.openRoom
    var draft by rememberSaveable { mutableStateOf("") }
    var mentionAll by rememberSaveable { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        val name = uri.lastPathSegment?.substringAfterLast('/') ?: "attachment"
        val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
        if (bytes == null) viewModel.reportAttachmentUnreadable(name)
        else viewModel.attachToRoom(bytes, name, context.contentResolver.getType(uri) ?: "application/octet-stream")
    }
    val lines = remember(room?.messages) { room?.let { roomTranscript(it, null, state.account) }.orEmpty() }
    val attachmentsById = remember(room?.messages) { room?.messages?.associate { it.id to it.attachments }.orEmpty() }

    // Newest at the bottom; a new row scrolls the list down unless the reader is browsing older ones.
    LaunchedEffect(lines.size, lines.lastOrNull()?.text?.length) {
        if (lines.isNotEmpty()) {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            if (last >= lines.size - 3 || last < 0) listState.animateScrollToItem(lines.size - 1)
        }
    }
    // Infinite scroll towards older history.
    val atTop by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0 } }
    LaunchedEffect(atTop, room?.hasMore) { if (atTop && room?.hasMore == true && lines.isNotEmpty()) viewModel.loadOlderRoomMessages() }
    // Typing indicator for the others: sent while the draft changes, cleared after a pause.
    LaunchedEffect(draft) {
        if (draft.isBlank()) { viewModel.roomTyping(false); return@LaunchedEffect }
        viewModel.roomTyping(true)
        delay(2_500)
        viewModel.roomTyping(false)
    }

    if (settings && room != null) RoomSettingsSheet(state, viewModel, onDismiss = { settings = false })

    Scaffold(
        topBar = {
            StudioTopBar(
                title = room?.room?.name ?: stringResource(R.string.room_title),
                subtitle = listOfNotNull(
                    room?.agents?.takeIf { it.isNotEmpty() }?.joinToString(", ") { it.name },
                    stringResource(if (state.roomLive) R.string.room_live else R.string.room_offline),
                ).joinToString(" · "),
                onBack = { viewModel.back() },
                actions = {
                    IconButton(onClick = { room?.let { viewModel.openRoom(it.room) } }) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.textSecondary) }
                    IconButton(onClick = { settings = true }, enabled = room != null) { Icon(CoreHubIcons.Settings, contentDescription = stringResource(R.string.room_settings), tint = palette.textPrimary) }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).imePadding()) {
            if (state.loadingHistory) LoadingRow()
            state.error?.let { ErrorNote(it) { viewModel.dismissError() } }
            state.notice?.let { NoticeNote(it) { viewModel.dismissNotice() } }
            if (room?.kicked == true) {
                Text(stringResource(R.string.room_kicked), color = palette.error, modifier = Modifier.padding(12.dp))
            }
            if (room != null) ActivityStrip(room, onInterrupt = { viewModel.interruptRoomAgent(it.agentName) })

            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (state.loadingOlderRoom) item("older") { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp) } }
                if (!state.loadingHistory && lines.isEmpty()) {
                    item("empty") { Text(stringResource(R.string.room_empty), color = palette.textMuted, modifier = Modifier.fillMaxWidth().padding(24.dp)) }
                }
                items(lines.size, key = { lines[it].key }) { index ->
                    val line = lines[index]
                    val agent = room?.agents?.firstOrNull { it.name == line.sender }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        MessageBubble(
                            line = line,
                            profile = if (line.fromUser) null else (agent?.profile ?: line.sender),
                            avatar = state.avatarOf(agent?.profile),
                            showToolCalls = state.showToolCalls,
                            speech = SpeechState(state.speakingKey, state.speechPaused, state.speechLoadingKey),
                            actions = null,
                        )
                        attachmentsById[line.messageId].orEmpty().forEach { attachment ->
                            AttachmentCard(attachment, viewModel)
                        }
                    }
                }
                room?.queue?.takeIf { it.isNotEmpty() }?.let { queue ->
                    item("queue") { QueueCard(queue, onCancel = viewModel::cancelRoomQueueItem) }
                }
                room?.interactions.orEmpty().forEach { interaction ->
                    item("interaction-${interaction.kind}-${interaction.id}") {
                        RunActionCard(
                            action = PendingRunAction(
                                kind = interaction.kind,
                                id = interaction.id,
                                prompt = listOf(interaction.agentName, interaction.prompt).filter { it.isNotBlank() }.joinToString(": "),
                                options = interaction.choices,
                                sessionId = room?.room?.id.orEmpty(),
                            ),
                            onRespond = { viewModel.respondRoomInteraction(interaction, it) },
                        )
                    }
                }
                room?.typing?.takeIf { it.isNotEmpty() }?.let { typing ->
                    item("typing") { Text(stringResource(R.string.room_typing, typing.values.joinToString(", ")), style = CoreHubTextStyles.meta, color = palette.textMuted) }
                }
            }

            // Composer: attachments, @all, text, send — the room has no REST posting endpoint.
            Surface(color = palette.bgComposer, shape = RoundedCornerShape(topStart = CoreHubTokens.Radius.composer, topEnd = CoreHubTokens.Radius.composer), shadowElevation = CoreHubTokens.Shadow.composer) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (state.roomAttachments.isNotEmpty() || state.roomUploads.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            state.roomUploads.forEach { upload ->
                                Chip(text = "${upload.name} · ${upload.percent}%", onRemove = { viewModel.cancelRoomUpload(upload.id) })
                            }
                            state.roomAttachments.forEach { upload ->
                                Chip(text = upload.name, onRemove = { viewModel.removeRoomAttachment(upload) })
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        IconButton(onClick = { picker.launch("*/*") }, modifier = Modifier.size(CoreHubTokens.Metrics.composerButton)) {
                            Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.composer_attach), tint = palette.textSecondary)
                        }
                        OutlinedTextField(
                            value = draft,
                            onValueChange = { draft = it },
                            placeholder = { Text(stringResource(R.string.room_hint), color = palette.textMuted) },
                            modifier = Modifier.weight(1f),
                            maxLines = 5,
                            textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                            shape = RoundedCornerShape(CoreHubTokens.Radius.card),
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.accent, unfocusedBorderColor = palette.inputBorder, cursorColor = palette.accent),
                        )
                        val canSend = (draft.isNotBlank() || state.roomAttachments.isNotEmpty()) && state.roomUploads.isEmpty()
                        Box(
                            modifier = Modifier.padding(bottom = 4.dp).size(CoreHubTokens.Metrics.composerButton).clip(CircleShape)
                                .background(if (canSend) palette.accent else palette.selected)
                                .clickable(enabled = canSend) { if (viewModel.postToRoom(draft, mentionAll)) { draft = ""; mentionAll = false } },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.composer_send), tint = if (canSend) palette.textOnAccent else palette.textMuted, modifier = Modifier.size(16.dp))
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "@all",
                            style = CoreHubTextStyles.meta.copy(fontWeight = FontWeight.Medium),
                            color = if (mentionAll) palette.textOnAccent else palette.textSecondary,
                            modifier = Modifier.clip(RoundedCornerShape(CoreHubTokens.Radius.pill)).background(if (mentionAll) palette.accent else palette.selected).clickable { mentionAll = !mentionAll }.padding(horizontal = 10.dp, vertical = 4.dp),
                        )
                        Text(stringResource(if (mentionAll) R.string.room_mention_all_on else R.string.room_mention_all_off), style = CoreHubTextStyles.meta, color = palette.textMuted)
                        Spacer(Modifier.weight(1f))
                        room?.room?.totalTokens?.takeIf { it > 0 }?.let { Text(stringResource(R.string.room_tokens, it), style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textMuted) }
                    }
                }
            }
        }
    }
}

/** Busy agents (replying / compressing) with a pulsing dot and an interrupt button, like the web's activity strip. */
@Composable
private fun ActivityStrip(room: RoomState, onInterrupt: (AgentActivity) -> Unit) {
    val palette = CoreHub.palette
    val busy = room.busyAgents
    val compressing = room.contextStatuses.filterValues { it != "ready" }.keys - busy.map { it.agentName }.toSet()
    if (busy.isEmpty() && compressing.isEmpty()) return
    val pulse by rememberInfiniteTransition(label = "activity").animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "activity-alpha")
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        busy.forEach { activity ->
            val agent = room.agents.firstOrNull { it.agentId == activity.agentId || it.name == activity.agentName }
            Row(
                modifier = Modifier.clip(RoundedCornerShape(CoreHubTokens.Radius.pill)).background(palette.selected).padding(start = 6.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (agent != null) RoomAgentAvatar(agent, streaming = true)
                Box(Modifier.size(6.dp).background(palette.accent.copy(alpha = pulse), CircleShape))
                Text(
                    stringResource(if (activity.status == "compressing") R.string.room_agent_compressing else R.string.room_agent_replying, activity.agentName),
                    style = CoreHubTextStyles.meta, color = palette.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                IconButton(onClick = { onInterrupt(activity) }, modifier = Modifier.size(22.dp)) {
                    Icon(Icons.Filled.Stop, contentDescription = stringResource(R.string.room_interrupt), tint = palette.error, modifier = Modifier.size(14.dp))
                }
            }
        }
        compressing.forEach { name ->
            Text(
                stringResource(R.string.room_agent_compressing, name),
                style = CoreHubTextStyles.meta, color = palette.textSecondary,
                modifier = Modifier.clip(RoundedCornerShape(CoreHubTokens.Radius.pill)).background(palette.selected).padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

/** The execution queue: messages waiting for a busy agent, each cancellable. */
@Composable
private fun QueueCard(queue: List<QueueItem>, onCancel: (QueueItem) -> Unit) {
    val palette = CoreHub.palette
    Surface(shape = RoundedCornerShape(CoreHubTokens.Radius.medium), color = palette.bgCard, border = BorderStroke(1.dp, palette.borderLight), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.room_queue_title, queue.size), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
            queue.forEach { item ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${item.position + 1}.", style = CoreHubTextStyles.meta, color = palette.textMuted)
                    Column(Modifier.weight(1f)) {
                        Text(item.targetAgentName, style = CoreHubTextStyles.meta.copy(fontWeight = FontWeight.Medium), color = palette.textPrimary)
                        Text(item.textSummary, style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content), color = palette.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(onClick = { onCancel(item) }) { Text(stringResource(R.string.action_cancel), color = palette.error) }
                }
            }
        }
    }
}

/** A message attachment as a download card (served through the room attachment route with the bearer header). */
@Composable
private fun AttachmentCard(attachment: GroupAttachment, viewModel: AppViewModel) {
    val (url, _) = remember(attachment) { viewModel.roomAttachmentSource(attachment) }
    val link = remember(attachment, url) { ChatFileLink(label = attachment.name, path = url, fileName = attachment.name) }
    ChatFileCard(link, onDownload = { viewModel.downloadRoomAttachment(attachment) })
}

@Composable
private fun Chip(text: String, onRemove: () -> Unit) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier.clip(RoundedCornerShape(CoreHubTokens.Radius.pill)).background(palette.selected).padding(start = 10.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr), color = palette.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        IconButton(onClick = onRemove, modifier = Modifier.size(20.dp)) { Icon(CoreHubIcons.Close, contentDescription = stringResource(R.string.action_delete), tint = palette.textMuted, modifier = Modifier.size(12.dp)) }
    }
}

/** Exposed for the settings sheet (agent rows show the same busy state). */
internal fun RoomState.isBusy(agentName: String): Boolean = busyAgents.any { it.agentName == agentName }

/** Interactions of one kind, for tests and the sheet's counters. */
internal fun RoomState.pending(kind: us.i3u.hermesstudio.RequiredAction): List<RoomInteraction> = interactions.filter { it.kind == kind }

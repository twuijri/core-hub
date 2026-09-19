package us.i3u.hermesstudio.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.pullrefresh.PullRefreshIndicator
import androidx.compose.material.pullrefresh.pullRefresh
import androidx.compose.material.pullrefresh.rememberPullRefreshState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.AvatarSpec
import us.i3u.hermesstudio.ChatFileLink
import us.i3u.hermesstudio.ChatLine
import us.i3u.hermesstudio.ErrorNote
import us.i3u.hermesstudio.MobileLocation
import us.i3u.hermesstudio.NoticeNote
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.TextPromptDialog
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.UpdateNote
import us.i3u.hermesstudio.chatProfile
import us.i3u.hermesstudio.ui.navigation.MenuButton
import us.i3u.hermesstudio.ui.sessions.workspaceChipLabel
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/** The avatar Studio shows for a profile, or null when it is not loaded yet. */
internal fun UiState.avatarOf(profile: String?): AvatarSpec? {
    val name = profile?.ifBlank { null } ?: activeProfile
    return profiles.firstOrNull { it.name == name }?.avatar
}

// ── conversation ─────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterialApi::class, ExperimentalFoundationApi::class)
@Composable
fun ConversationScreen(state: UiState, viewModel: AppViewModel, onMenu: () -> Unit) {
    var draft by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var replyingTo by remember { mutableStateOf<ChatLine?>(null) }
    val conversationKey = state.openSession?.id ?: "new"
    var reachedInitialBottom by remember(conversationKey) { mutableStateOf(false) }
    val lifecycleOwner = LocalLifecycleOwner.current
    val palette = CoreHub.palette

    // Location consent: the dialog first, then the runtime permission, then the fix.
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) viewModel.respondToLocation(granted = true) else viewModel.reportLocationPermissionDenied()
    }
    state.locationRequest?.let { request ->
        LocationConsentDialog(
            request = request,
            onAllow = {
                val precise = request.accuracy == "precise"
                if (MobileLocation.hasPermission(context, precise)) viewModel.respondToLocation(granted = true)
                else askLocation.launch(MobileLocation.permissionsFor(precise))
            },
            onDeny = { viewModel.respondToLocation(granted = false) },
        )
    }

    // A run continues in Studio after the mobile stream is detached. Reload
    // the server history whenever the app returns to the foreground so a reply
    // completed while the user was away is shown immediately.
    DisposableEffect(lifecycleOwner, conversationKey) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && state.openSession != null) {
                viewModel.refreshConversation()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val itemCount = state.lines.size + (if (state.pendingRunAction != null) 1 else 0)
    LaunchedEffect(conversationKey, state.loadingHistory, itemCount) {
        if (!state.loadingHistory && itemCount > 0) {
            val last = itemCount - 1
            if (!reachedInitialBottom) {
                // A huge offset is intentionally clamped by LazyColumn to the
                // real end, including when the final message is taller than the
                // viewport. Animation from the first message made old chats
                // appear to open at the top.
                listState.scrollToItem(last, Int.MAX_VALUE / 2)
                reachedInitialBottom = true
            } else {
                listState.animateScrollToItem(last, Int.MAX_VALUE / 2)
            }
        }
    }

    // The one rule, so the speak button asks Core Hub for the voice of the
    // profile this conversation is actually running under. A blank profile on
    // the session used to fall straight to "default" here and skip the active
    // profile the rest of the app was using.
    val profileName = state.chatProfile
    val avatar = state.avatarOf(profileName)
    val pullRefreshState = rememberPullRefreshState(
        refreshing = state.loadingHistory,
        onRefresh = { viewModel.refreshConversation() },
    )
    val actions = remember(state.sending, profileName) {
        MessageActions(
            onCopy = { line ->
                clipboard.setText(AnnotatedString(line.text))
                viewModel.showNotice(R.string.message_copied)
            },
            onReference = { line -> replyingTo = line },
            onFork = { viewModel.send("/fork") },
            onSpeak = { line -> viewModel.toggleSpeech(line, profileName) },
            onDownload = { file -> viewModel.downloadChatFile(file, profileName) },
            mediaSource = { file -> viewModel.mediaSource(file, profileName) },
            forkEnabled = !state.sending,
        )
    }
    val speech = SpeechState(state.speakingKey, state.speechPaused, state.speechLoadingKey)

    Scaffold(
        // The composer applies the IME inset itself. Scaffold's default system
        // bottom inset would otherwise be added above the keyboard as a second,
        // empty navigation-bar-sized strip.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { ChatHeader(state, viewModel, onMenu) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
        ) {
            Box(
                modifier = Modifier.weight(1f).fillMaxWidth().pullRefresh(pullRefreshState),
            ) {
                if (state.lines.isEmpty() && state.pendingRunAction == null && !state.loadingHistory) {
                    Text(
                        stringResource(
                            R.string.conversation_empty,
                            profileName.ifBlank { stringResource(R.string.conversation_your_agent) },
                        ),
                        color = palette.textSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )
                } else {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(12.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(state.lines, key = { it.key }) { line ->
                            MessageBubble(
                                line = line,
                                profile = profileName,
                                avatar = avatar,
                                showToolCalls = state.showToolCalls,
                                speech = speech,
                                actions = actions,
                            )
                        }
                        state.pendingRunAction?.let { action ->
                            item(key = "action:${action.id}") {
                                RunActionCard(action) { response -> viewModel.resolveRunAction(response) }
                            }
                        }
                    }
                }
                PullRefreshIndicator(
                    refreshing = state.loadingHistory,
                    state = pullRefreshState,
                    modifier = Modifier.align(Alignment.TopCenter),
                    backgroundColor = palette.bgCard,
                    contentColor = palette.accent,
                )
                if (reachedInitialBottom && listState.canScrollForward && itemCount > 0) {
                    Surface(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(14.dp)
                            .size(46.dp)
                            .clickable {
                                scope.launch { listState.animateScrollToItem(itemCount - 1, Int.MAX_VALUE / 2) }
                            },
                        shape = CircleShape,
                        color = palette.bgCard,
                        contentColor = palette.textPrimary,
                        tonalElevation = 0.dp,
                        shadowElevation = 5.dp,
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.conversation_jump_latest))
                        }
                    }
                }
            }

            if (state.sending && state.lines.none { it.streaming } && state.pendingRunAction == null) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = palette.textMuted)
                    Text(
                        state.activity?.let { stringResource(R.string.conversation_tool, it) }
                            ?: stringResource(R.string.conversation_thinking),
                        style = CoreHubTextStyles.meta,
                        color = palette.textMuted,
                    )
                }
            }

            if (state.queuedRuns.isNotEmpty()) {
                Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                    QueuedRunsList(
                        runs = state.queuedRuns,
                        insertionActive = state.queueInsertionActive,
                        onInsert = { viewModel.insertQueuedRun(it) },
                        onSteer = { viewModel.steerQueuedRun(it) },
                        onCancel = { viewModel.cancelQueuedRun(it) },
                    )
                }
            }
            if (state.backgroundAgentRuns.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    state.backgroundAgentRuns.forEach { agent ->
                        Surface(shape = RoundedCornerShape(CoreHubTokens.Radius.pill), color = palette.segmentTrack) {
                            Text(
                                stringResource(R.string.background_agent_summary, agent.label, agent.status),
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                maxLines = 1,
                                style = CoreHubTextStyles.meta,
                                color = palette.textSecondary,
                            )
                        }
                    }
                }
            }

            state.compression?.let { CompressionBanner(it) { viewModel.dismissCompression() } }
            state.abortPhase?.let { AbortBanner(it) }
            state.error?.let { ErrorNote(it) { viewModel.dismissError() } }
            state.notice?.let { NoticeNote(it) { viewModel.dismissNotice() } }
            // A new test build joins the same quiet stack as every other
            // notice, rather than opening a dialog over the conversation.
            if (state.update.showNotice) UpdateNote(state.update, viewModel)

            replyingTo?.let { quoted ->
                Surface(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
                    color = palette.bgSecondary,
                    shape = RoundedCornerShape(CoreHubTokens.Radius.card),
                ) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.message_replying), style = CoreHubTextStyles.meta, color = palette.textSecondary)
                            Text(
                                quoted.text,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content),
                                color = palette.textPrimary,
                            )
                        }
                        IconButton(onClick = { replyingTo = null }) { Icon(Icons.Filled.Close, stringResource(R.string.action_cancel), tint = palette.textMuted) }
                    }
                }
            }
            Composer(
                state = state,
                draft = draft,
                onDraftChange = { draft = it },
                onSend = {
                    viewModel.send(replyingTo?.let { quoteForReply(it.text, draft) } ?: draft)
                    draft = ""
                    replyingTo = null
                },
                viewModel = viewModel,
            )
        }
    }
}

/**
 * The chat header, per DESIGN-SPEC: hamburger, title 16/600 (dir=auto) in the
 * app bar, the workspace chip (folder icon 12, 11 sp muted, last path segment)
 * and the runtime chip under it, and the ⋯ actions menu.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatHeader(state: UiState, viewModel: AppViewModel, onMenu: () -> Unit) {
    val palette = CoreHub.palette
    var menuOpen by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    var workspace by remember { mutableStateOf(false) }
    val session = state.openSession
    session?.let { open ->
        if (rename) TextPromptDialog(
            title = stringResource(R.string.chats_rename_title),
            initial = open.title,
            hint = open.title,
            action = stringResource(R.string.action_rename),
            onConfirm = { viewModel.renameSession(open, it); rename = false },
            onDismiss = { rename = false },
        )
        if (workspace) TextPromptDialog(
            title = stringResource(R.string.session_workspace),
            initial = open.workspace.orEmpty(),
            hint = "/workspace",
            action = stringResource(R.string.action_save),
            onConfirm = { viewModel.setSessionWorkspace(open, it); workspace = false },
            onDismiss = { workspace = false },
        )
    }
    TopAppBar(
        title = {
            Column {
                Text(
                    session?.title ?: stringResource(R.string.action_new_chat),
                    style = MaterialTheme.typography.titleLarge.copy(textDirection = TextDirection.Content),
                    color = palette.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    workspaceChipLabel(session?.workspace)?.let { label -> HeaderChip(label, CoreHubIcons.Folder) }
                    HeaderChip(state.selectedRuntime.name, null)
                }
            }
        },
        navigationIcon = { MenuButton(onMenu) },
        actions = {
            Box {
                IconButton(onClick = { menuOpen = true }) { Icon(CoreHubIcons.More, stringResource(R.string.message_actions), tint = palette.textSecondary) }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.action_refresh)) }, onClick = { menuOpen = false; viewModel.refreshConversation() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.action_new_chat)) }, onClick = { menuOpen = false; viewModel.startNewConversation() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.message_fork)) }, enabled = !state.sending, onClick = { menuOpen = false; viewModel.send("/fork") })
                    if (session != null) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.action_rename)) }, onClick = { menuOpen = false; rename = true })
                        DropdownMenuItem(text = { Text(stringResource(R.string.session_workspace)) }, onClick = { menuOpen = false; workspace = true })
                        DropdownMenuItem(text = { Text(stringResource(R.string.session_export)) }, onClick = { menuOpen = false; viewModel.exportSession(session) })
                        DropdownMenuItem(text = { Text(stringResource(if (session.archived) R.string.session_unarchive else R.string.session_archive)) }, onClick = { menuOpen = false; viewModel.archiveSession(session) })
                    }
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.bgPrimary, scrolledContainerColor = palette.bgPrimary),
    )
}

/** Workspace chip: folder icon 12, 11/16 muted, bg text @ 5 %, padding 2×8, radius 4. */
@Composable
private fun HeaderChip(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector?) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier
            .background(palette.textPrimary.copy(alpha = 0.05f), RoundedCornerShape(CoreHubTokens.Radius.tag))
            .padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(CoreHubTokens.Metrics.workspaceIcon))
        Text(
            label,
            style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Content),
            color = palette.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * One message in the transcript. The bubble colours and radius come from the
 * tokens (msg.user / msg.assistant, radius 10); the row layout, tool card,
 * thinking block, media and action row live in [MessageRow]. Group rooms call
 * this without [actions].
 */
@Composable
internal fun MessageBubble(
    line: ChatLine,
    profile: String? = null,
    avatar: AvatarSpec? = null,
    showToolCalls: Boolean = true,
    speech: SpeechState = SpeechState(null, false, null),
    actions: MessageActions? = null,
) {
    val palette = CoreHub.palette
    val bubbleColor = when {
        line.isError -> palette.errorSurface
        line.fromUser -> palette.msgUser
        else -> palette.msgAssistant
    }
    val bubbleShape: Shape = RoundedCornerShape(CoreHubTokens.Radius.bubble)
    MessageRow(
        line = line,
        profile = profile,
        avatar = avatar,
        bubbleColor = bubbleColor,
        bubbleShape = bubbleShape,
        showToolCalls = showToolCalls,
        speech = speech,
        actions = actions,
    )
}

internal fun quoteForReply(quoted: String, reply: String): String {
    val excerpt = quoted.trim().lineSequence().take(8).joinToString("\n") { "> $it" }
    return listOf(excerpt, reply.trim()).filter { it.isNotBlank() }.joinToString("\n\n")
}

@Composable
internal fun timelineNow(line: ChatLine): Long {
    var now by remember(line.startedAtMillis, line.finishedAtMillis) {
        mutableLongStateOf(line.finishedAtMillis ?: System.currentTimeMillis())
    }
    LaunchedEffect(line.streaming, line.finishedAtMillis) {
        if (!line.streaming) {
            now = line.finishedAtMillis ?: System.currentTimeMillis()
            return@LaunchedEffect
        }
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    return line.finishedAtMillis ?: now
}

internal fun formatElapsed(milliseconds: Long): String {
    val totalSeconds = (milliseconds.coerceAtLeast(0) / 1000).toInt()
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return if (minutes == 0) "${seconds}s" else "${minutes}m${seconds.toString().padStart(2, '0')}s"
}

internal fun formatToolDuration(seconds: Double): String = when {
    seconds < 10 -> String.format(Locale.US, "%.1fs", seconds)
    seconds < 60 -> "${seconds.toInt()}s"
    else -> "${(seconds / 60).toInt()}m${(seconds.toInt() % 60).toString().padStart(2, '0')}s"
}

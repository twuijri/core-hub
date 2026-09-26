package hub.core.android.ui.screens

import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.R
import hub.core.android.chat.Turns
import hub.core.android.graph
import hub.core.android.phone.DictationStrip
import hub.core.android.phone.MicButton
import hub.core.android.phone.rememberDictation
import hub.core.android.chat.AttachmentTray
import hub.core.android.ui.components.ApprovalCard
import hub.core.android.ui.components.AttachButton
import hub.core.android.ui.components.AttachmentChips
import hub.core.android.ui.components.Composer
import hub.core.android.ui.components.EmptyState
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.Loading
import hub.core.android.ui.components.Notice
import hub.core.android.ui.components.QuestionCard
import hub.core.android.ui.components.dismissKeyboardOnTap
import hub.core.android.ui.components.keyboardSink
import hub.core.android.ui.components.rememberDismissKeyboardOnScroll
import hub.core.android.ui.components.rememberKeyboardDismisser
import hub.core.android.ui.components.ThinkingIndicator
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.TurnView
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.RunStatus

/**
 * A conversation, or the new-chat draft when [sessionId] is null: the agent row above the
 * composer, and the profile the chat will be made in named on the screen (NAVIGATION.md rule 4).
 */
@Composable
fun ChatScreen(
    sessionId: String?,
    profile: String,
    profileName: String,
    onCreated: (String, String) -> Unit,
) {
    val context = LocalContext.current
    val vm: ChatViewModel = viewModel(key = "chat:${sessionId ?: "draft"}:$profile") {
        ChatViewModel(context.graph, sessionId, profile)
    }
    val ui by vm.ui.collectAsState()
    var draft by rememberSaveable(sessionId) { mutableStateOf("") }
    if (sessionId == null) {
        // Text shared from another app lands in the new chat's draft, once.
        val shared by context.graph.sharedText.collectAsState()
        LaunchedEffect(shared) {
            shared?.let { draft = if (draft.isBlank()) it else "$draft\n$it" }
            context.graph.sharedText.value = null
        }
    }
    val chat = ui.chat
    val turns = remember(chat.messages) { Turns.group(chat.messages) }
    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
    val youLabel = stringResource(R.string.chat_you)
    val agents = hub.core.android.ui.components.rememberAgents(profile)
    val agentFallback = agents.firstOrNull { it.id == chat.session?.agentId }?.name ?: stringResource(R.string.agent_fallback)

    // Follow the reply while the reader is at the bottom; leave them where they are otherwise.
    LaunchedEffect(turns.size, turns.lastOrNull()?.messages?.lastOrNull()?.text?.length) {
        if (turns.isNotEmpty() && (atBottom || listState.firstVisibleItemIndex == 0)) listState.scrollToItem(turns.lastIndex + 1)
    }
    // The keyboard opening shrinks the list from below: a reader at the latest message stays
    // there, above the composer. `following` is where the reader left the list after their own
    // scroll (or ours), so the shrink itself never turns it off.
    var following by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { if (!it) following = !listState.canScrollForward }
    }
    LaunchedEffect(listState) {
        var previous = 0
        snapshotFlow { listState.layoutInfo.viewportSize.height }.collect { height ->
            val shrunk = previous - height
            previous = height
            if (shrunk > 0 && following) listState.scrollBy(shrunk.toFloat())
        }
    }
    val dismissKeyboard = rememberKeyboardDismisser()
    val dismissOnScroll = rememberDismissKeyboardOnScroll(dismissKeyboard)
    // Reaching the top reads the page before.
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { if (it == 0 && ui.hasOlder) vm.loadOlder() }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        // A tap on the conversation, or a drag of it, puts the keyboard away.
        Box(
            Modifier.weight(1f).fillMaxWidth()
                .nestedScroll(dismissOnScroll)
                .dismissKeyboardOnTap(dismissKeyboard)
                .keyboardSink(dismissKeyboard)
                .testTag("chat.transcript"),
        ) {
            when {
                ui.loading -> Loading()
                sessionId == null -> DraftIntro(profileName, profile, ui, vm::selectAgent)
                else -> LazyColumn(
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(hub.core.android.generated.LayoutTokens.turnGap.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    item(key = "older") {
                        if (ui.loadingOlder) Text(stringResource(R.string.chat_loading_older), color = LocalTokens.current.textMuted)
                    }
                    items(turns, key = { it.messages.first().id }) { turn ->
                        val agent = if (turn.fromPerson) null else hub.core.android.ui.components.AgentIdentity.of(
                            turn.messages.first().authorId, turn.authorName, agents, agentFallback,
                        )
                        TurnView(turn, youLabel, profile, agent = agent)
                    }
                }
            }
        }
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ui.error?.let { ErrorNotice(it) }
            chat.failure?.let { Notice(it.ifBlank { stringResource(R.string.chat_run_failed) }, Tone.DANGER) }
            chat.decisions.forEach { approval -> ApprovalCard(approval) { vm.respond(approval, it, null) } }
            chat.question?.let { q ->
                QuestionCard(q, onAnswer = { vm.respond(q, null, it) }, onSkip = { vm.respond(q, ApprovalDecision.DENY, null) })
            }
        }
        if (chat.running) {
            ThinkingIndicator(chat.runStartedAt, chat.currentStep, queued = chat.activeRun?.status == RunStatus.QUEUED)
        }
        val agentName = ui.agents.firstOrNull { it.id == ui.agentId }?.name
        val files by vm.tray.items.collectAsState()
        AttachmentChips(files, onRemove = vm.tray::remove)
        val uploading = files.any { it.state == AttachmentTray.State.Uploading }
        val ready = files.any { it.state is AttachmentTray.State.Ready }
        val send = {
            val text = draft
            draft = ""
            vm.send(text, onCreated)
        }
        // The words appear in the draft while they are spoken; with Auto and no keyboard to go
        // by, the conversation's own language is the one listened in.
        val dictation = rememberDictation(
            profile = profile,
            recent = remember(chat.messages) { chat.messages.takeLast(8).map { it.text } },
            draft = { draft },
            onDraft = { draft = it },
            onSend = send,
        )
        DictationStrip(dictation)
        Composer(
            text = draft,
            onText = { draft = it },
            placeholder = if (agentName != null) stringResource(R.string.chat_placeholder_agent, agentName) else stringResource(R.string.chat_placeholder),
            running = chat.running,
            sending = ui.sending || uploading || (sessionId == null && ui.agentId == null),
            onSend = { if (dictation.active) dictation.send() else send() },
            onStop = vm::stop,
            leading = { AttachButton(vm.tray) },
            trailing = { MicButton(dictation) },
            hasAttachments = ready,
        )
    }
}

/**
 * The new chat's empty state, as on iOS: the mark, the profile the chat will be made in, one line
 * of help; the agents as chips just above the composer (the draft is made on the first message).
 */
@Composable
private fun DraftIntro(profileName: String, profile: String, ui: ChatUi, onSelect: (String) -> Unit) {
    val t = LocalTokens.current
    Column(Modifier.fillMaxSize().padding(bottom = 4.dp).testTag("screen.new_chat"), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            hub.core.android.ui.components.BrandMark(48)
            Text(
                stringResource(R.string.chat_new_in_profile, profileName), textAlign = TextAlign.Center,
                fontSize = hub.core.android.generated.FontTokens.sizeXl.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = t.text,
                modifier = Modifier.testTag("chat.greeting"),
            )
            Text(stringResource(R.string.chat_start_hint), textAlign = TextAlign.Center, fontSize = hub.core.android.generated.FontTokens.sizeSm.sp, color = t.textMuted)
        }
        if (ui.agents.isEmpty() && ui.error == null) {
            hub.core.android.ui.kit.NoticeBox(
                stringResource(R.string.chat_no_agents) + " — " + stringResource(R.string.chat_no_agents_body),
                hub.core.android.ui.kit.BadgeTone.Warning, Modifier.padding(horizontal = 12.dp),
            )
        }
        LazyRow(
            Modifier.fillMaxWidth().testTag("chat.agents"),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            items(ui.agents, key = { it.id }) { agent ->
                hub.core.android.ui.kit.Chip(
                    agent.name, selected = agent.id == ui.agentId, onClick = { onSelect(agent.id) },
                    leading = { hub.core.android.ui.components.AgentAvatar(hub.core.android.ui.components.AgentIdentity.of(agent), profile, 20.dp) },
                    modifier = Modifier.testTag("chat.agent.${agent.slug}"),
                )
            }
        }
    }
}

@Composable
fun PlaceholderScreen(title: String, body: String, onBack: (() -> Unit)? = null) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        hub.core.android.ui.kit.EmptyState(title, body = body, icon = hub.core.android.ui.kit.Lucide.Wrench)
        if (onBack != null) hub.core.android.ui.kit.HubButton(stringResource(R.string.back), onBack, kind = hub.core.android.ui.kit.ButtonKind.Secondary, icon = hub.core.android.ui.kit.Lucide.ArrowLeft)
    }
}

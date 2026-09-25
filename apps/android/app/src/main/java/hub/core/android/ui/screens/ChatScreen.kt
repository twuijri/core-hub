package hub.core.android.ui.screens

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.R
import hub.core.android.chat.Turns
import hub.core.android.graph
import hub.core.android.phone.VoiceButton
import hub.core.android.ui.components.ApprovalCard
import hub.core.android.ui.components.Composer
import hub.core.android.ui.components.EmptyState
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.Loading
import hub.core.android.ui.components.Notice
import hub.core.android.ui.components.QuestionCard
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

    // Follow the reply while the reader is at the bottom; leave them where they are otherwise.
    LaunchedEffect(turns.size, turns.lastOrNull()?.messages?.lastOrNull()?.text?.length) {
        if (turns.isNotEmpty() && (atBottom || listState.firstVisibleItemIndex == 0)) listState.scrollToItem(turns.lastIndex + 1)
    }
    // Reaching the top reads the page before.
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { if (it == 0 && ui.hasOlder) vm.loadOlder() }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                ui.loading -> Loading()
                sessionId == null -> DraftIntro(profileName, ui, vm::selectAgent)
                else -> LazyColumn(
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    item(key = "older") {
                        if (ui.loadingOlder) Text(stringResource(R.string.chat_loading_older), color = LocalTokens.current.textMuted)
                    }
                    items(turns, key = { it.messages.first().id }) { turn -> TurnView(turn, youLabel) }
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
        Composer(
            text = draft,
            onText = { draft = it },
            placeholder = if (agentName != null) stringResource(R.string.chat_placeholder_agent, agentName) else stringResource(R.string.chat_placeholder),
            running = chat.running,
            sending = ui.sending || (sessionId == null && ui.agentId == null),
            onSend = {
                val text = draft
                draft = ""
                vm.send(text, onCreated)
            },
            onStop = vm::stop,
            extra = { VoiceButton { spoken -> draft = if (draft.isBlank()) spoken else "$draft $spoken" } },
        )
    }
}

@Composable
private fun DraftIntro(profileName: String, ui: ChatUi, onSelect: (String) -> Unit) {
    val t = LocalTokens.current
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.Bottom, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(R.string.chat_greeting), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
        Text(stringResource(R.string.chat_in_profile, profileName), style = MaterialTheme.typography.bodyMedium, color = t.textMuted)
        if (ui.agents.isEmpty() && ui.error == null) {
            EmptyState(stringResource(R.string.chat_no_agents), stringResource(R.string.chat_no_agents_body))
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
            items(ui.agents, key = { it.id }) { agent ->
                FilterChip(selected = agent.id == ui.agentId, onClick = { onSelect(agent.id) }, label = { Text(agent.name) })
            }
        }
    }
}

@Composable
fun PlaceholderScreen(title: String, body: String, onBack: (() -> Unit)? = null) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        EmptyState(title, body)
        if (onBack != null) TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
    }
}

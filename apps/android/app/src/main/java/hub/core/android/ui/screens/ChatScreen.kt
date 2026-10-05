package hub.core.android.ui.screens

import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.foundation.clickable
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
import androidx.lifecycle.repeatOnLifecycle
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
    /** Opens another chat (a fork from a message); `null` offers no fork. */
    onOpenChat: ((String, String) -> Unit)? = null,
    /** `/new` and `/archive` leave this chat for the new-chat draft; null keeps the commands to what stays here. */
    onNewChat: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val vm = rememberChatViewModel(sessionId, profile)
    val ui by vm.ui.collectAsState()
    val signedIn by context.graph.store.session.collectAsState()
    var replyTo by remember(sessionId) { mutableStateOf<hub.core.android.chat.ChatMessage?>(null) }
    // The message whose time shows under it after a light tap; one at a time (tester feedback).
    var timeShown by remember(sessionId) { mutableStateOf<String?>(null) }
    var draft by rememberSaveable(sessionId) { mutableStateOf("") }
    if (sessionId == null) {
        // Text shared from another app lands in the new chat's draft, once.
        val shared by context.graph.sharedText.collectAsState()
        LaunchedEffect(shared) {
            shared?.takeIf { it.isNotBlank() }?.let { draft = if (draft.isBlank()) it else "$draft\n$it" }
            context.graph.sharedText.value = null
        }
        // Pictures and files shared from another app go into the tray and upload, once.
        val sharedFiles by context.graph.sharedFiles.collectAsState()
        LaunchedEffect(sharedFiles) {
            if (sharedFiles.isEmpty()) return@LaunchedEffect
            sharedFiles.forEach { vm.tray.add(it.file, isImage = it.isImage, preview = it.preview) }
            context.graph.sharedFiles.value = emptyList()
        }
    }
    // A profile file the Files page made an attachment of lands in this chat's tray, ready (any chat).
    val handedOff by context.graph.handOff.version.collectAsState()
    LaunchedEffect(handedOff, profile) { context.graph.handOff.take(profile).forEach(vm.tray::addReady) }
    val chat = ui.chat
    // `/clear-screen` hides what was on the screen until «Show them» (nothing is deleted).
    val turns = remember(chat.messages, ui.hiddenThrough) {
        Turns.group(hub.core.android.chat.SlashCommands.afterClear(chat.messages, { it.seq }, ui.hiddenThrough))
    }
    // Leaving the conversation drops the messages still waiting on the phone (MessageQueue.kt).
    androidx.compose.runtime.DisposableEffect(sessionId) { onDispose { vm.dropQueue() } }
    // The person is looking at this conversation while it is on screen and the app is resumed:
    // the hub skips the phone push for a reply here (DECISIONS §149).
    if (sessionId != null) {
        val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
        val realtime = context.graph.realtime
        LaunchedEffect(sessionId, lifecycle) {
            lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.RESUMED) {
                try {
                    while (true) {
                        realtime.viewing(sessionId)
                        kotlinx.coroutines.delay(20_000)
                    }
                } finally {
                    realtime.viewing(null)
                }
            }
        }
    }
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
    // Copy, read aloud, reply and fork under each message of this chat (apps batch 1).
    val chatAgent = agents.firstOrNull { it.id == chat.session?.agentId }
    val globalAgent = chat.session?.globalAgent == true
    // A reply chosen from a message (its menu, or a swipe, §150) puts the cursor in the composer
    // and brings the keyboard up.
    val composerFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val messageActions = remember(sessionId, onOpenChat, globalAgent) {
        hub.core.android.ui.components.MessageActions(
            speak = { vm.speak(it.text) },
            reply = {
                replyTo = it
                runCatching { composerFocus.requestFocus() }
                keyboard?.show()
            },
            fork = if (onOpenChat == null || globalAgent) null else { message -> vm.fork(message.id) { onOpenChat(it.id, it.profile) } },
        )
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
                    verticalArrangement = Arrangement.spacedBy(
                        if (LocalChatDisplay.current.compact) (hub.core.android.generated.LayoutTokens.turnGap / 2).dp else hub.core.android.generated.LayoutTokens.turnGap.dp,
                    ),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    item(key = "older") {
                        if (ui.loadingOlder) Text(stringResource(R.string.chat_loading_older), color = LocalTokens.current.textMuted)
                    }
                    if (ui.hiddenThrough != null) {
                        item(key = "cleared") {
                            Notice(stringResource(R.string.slash_cleared) + " " + stringResource(R.string.slash_show_cleared), Tone.INFO,
                                Modifier.clickable(onClick = vm::showCleared).testTag("chat.cleared"))
                        }
                    }
                    items(turns, key = { it.messages.first().id }) { turn ->
                        val agent = if (turn.fromPerson) null else hub.core.android.ui.components.AgentIdentity.of(
                            turn.messages.first().authorId, turn.authorName, agents, agentFallback,
                        )
                        androidx.compose.runtime.CompositionLocalProvider(
                            hub.core.android.ui.components.LocalChatSession provides sessionId,
                            hub.core.android.ui.components.LocalMessageActions provides messageActions,
                        ) {
                            TurnView(
                                turn, youLabel, profile, agent = agent, timeShown = timeShown,
                                onTapMessage = { message -> timeShown = if (timeShown == message.id) null else message.id },
                            )
                        }
                    }
                }
            }
        }
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ui.error?.let { ErrorNotice(it) }
            ui.notice?.let { hub.core.android.ui.components.ChatNoticeLine(it, vm::dismissNotice) }
            chat.failure?.let { Notice(it.ifBlank { stringResource(R.string.chat_run_failed) }, Tone.DANGER) }
            chat.decisions.forEach { approval -> ApprovalCard(approval) { vm.respond(approval, it, null) } }
            chat.question?.let { q ->
                QuestionCard(q, onAnswer = { vm.respond(q, null, it) }, onSkip = { vm.respond(q, ApprovalDecision.DENY, null) })
            }
        }
        if (chat.running) {
            ThinkingIndicator(chat.runStartedAt, chat.currentStep, queued = chat.activeRun?.status == RunStatus.QUEUED)
        }
        // The chat's agent by name, as on iOS («Message Hermes»): the draft's choice, else the chat's own.
        val agentName = ui.agents.firstOrNull { it.id == ui.agentId }?.name ?: agents.firstOrNull { it.id == chat.session?.agentId }?.name
        val files by vm.tray.items.collectAsState()
        AttachmentChips(files, onRemove = vm.tray::remove)
        val uploading = files.any { it.state == AttachmentTray.State.Uploading }
        val ready = files.any { it.state is AttachmentTray.State.Ready }
        // The `/` commands this agent takes (SlashCommands.kt); a new chat's draft sends everything as typed.
        val offered = if (sessionId == null) emptyList() else hub.core.android.chat.SlashCommands.available(chatAgent?.capabilities.orEmpty())
            // A command this screen cannot carry out is not offered (the global agent's page has no fork, no new chat).
            .filter { (it.name != "new" && it.name != "archive") || onNewChat != null }
            .filter { it.name != "fork" || (onOpenChat != null && !globalAgent) }
        var pickingModel by remember(sessionId) { mutableStateOf(false) }
        val runCommand: (hub.core.android.chat.SlashCommands.Command, String) -> Boolean = run@{ command, arg ->
            if (command.argument == hub.core.android.chat.SlashCommands.Argument.REQUIRED && arg.isBlank()) {
                vm.say(ChatNotice.NeedsWords(command.name))
                return@run false
            }
            when (command.name) {
                "compress" -> vm.compress(arg)
                "steer" -> vm.steer(arg)
                "new" -> onNewChat?.invoke()
                "fork" -> onOpenChat?.let { open -> vm.fork(null) { open(it.id, it.profile) } }
                "archive" -> vm.change(hub.core.client.model.SessionPatch(archived = true)) { onNewChat?.invoke() }
                "model" -> if (arg.isBlank()) pickingModel = true else {
                    val value = hub.core.android.chat.SlashCommands.model(arg, ui.models)
                    if (value == null) { vm.say(ChatNotice.UnknownModel(arg.trim())); return@run false }
                    vm.setModel(value)
                }
                "clear-screen" -> vm.clearScreen()
            }
            true
        }
        val send = send@{
            val text = draft
            val parsed = hub.core.android.chat.SlashCommands.parse(text, offered)
            if (parsed != null && parsed.first.kind != hub.core.android.chat.SlashCommands.Kind.MESSAGE) {
                if (runCommand(parsed.first, parsed.second)) draft = ""
                return@send
            }
            if (parsed != null && parsed.first.argument == hub.core.android.chat.SlashCommands.Argument.REQUIRED && parsed.second.isBlank()) {
                vm.say(ChatNotice.NeedsWords(parsed.first.name))
                return@send
            }
            val reply = replyTo?.id
            draft = ""
            replyTo = null
            vm.send(text, onCreated, reply)
        }
        if (pickingModel) {
            hub.core.android.ui.components.ModelPickerSheet(
                ui.models, ui.modelsLoaded, chat.session?.model, allowDefault = true,
                onChoose = { value -> pickingModel = false; vm.setModel(value) }, onDismiss = { pickingModel = false },
                defaultLabel = ui.defaultModelName?.let { stringResource(R.string.chat_controls_model_default_named, it) },
            )
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
        // What waits for the live turn to end (MessageQueue.kt), and the `/` menu while one is typed.
        MessageQueueStrip(ui.queue, onSendNow = vm::sendNow, onSteer = vm::steerWith, onRemove = vm::unqueue)
        val typingSkill = hub.core.android.chat.SlashCommands.skillQuery(draft) != null
        LaunchedEffect(typingSkill, chat.session?.agentId) { if (typingSkill) vm.loadSkills(chat.session?.agentId) }
        if (sessionId != null) {
            SlashMenu(
                draft, offered, ui.skills,
                onCommand = { command ->
                    val next = hub.core.android.chat.SlashCommands.picked(command)
                    if (next != null) draft = next else if (runCommand(command, "")) draft = ""
                },
                onSkill = { draft = hub.core.android.chat.SlashCommands.pickSkill(it) },
            )
        }
        replyTo?.let { hub.core.android.ui.components.ReplyStrip(it) { replyTo = null } }
        // The composer's chips (apps batch 1): a new chat's folder and model, a chat's model, the
        // agent's approvals, and Steer while a reply runs.
        val chipAgent = if (sessionId == null) ui.agentId else chat.session?.agentId
        LaunchedEffect(chipAgent) { if (sessionId == null || chipAgent != null) vm.loadControls(chipAgent) }
        val steerable = sessionId != null && chat.running && hub.core.client.model.AgentCapability.STEER in chatAgent?.capabilities.orEmpty()
        hub.core.android.ui.components.ComposerChips(
            models = ui.models,
            modelsLoaded = ui.modelsLoaded,
            model = if (sessionId == null) ui.draftModel else chat.session?.model,
            onModel = vm::setModel,
            approval = ui.approval,
            isAdmin = signedIn?.user?.isAdmin == true,
            onApproval = { value -> chipAgent?.let { vm.setApproval(it, value) } },
            allowDefault = true,
            defaultModelName = ui.defaultModelName,
            folder = ui.draftFolder,
            dirs = ui.dirs,
            dirsError = ui.dirsError?.let { hub.core.android.ui.components.errorText(it) },
            onFolder = if (sessionId == null) vm::setFolder else null,
            onSteer = if (steerable) {
                {
                    val text = draft.trim()
                    if (text.isNotEmpty()) {
                        draft = ""
                        vm.steer(text)
                    }
                }
            } else null,
            steerReady = hub.core.android.chat.ChatControls.canSteer(chat.running, draft, chatAgent?.capabilities.orEmpty()),
        )
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
            focus = composerFocus,
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
        if (ui.agentsLoaded && ui.agents.isEmpty() && ui.error == null) {
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

/** The chat's view model, shared by its screen and its top bar's menu (the same key, the same instance). */
@Composable
fun rememberChatViewModel(sessionId: String?, profile: String): ChatViewModel {
    val context = LocalContext.current
    return viewModel(key = "chat:${sessionId ?: "draft"}:$profile") { ChatViewModel(context.graph, sessionId, profile) }
}

@Composable
fun PlaceholderScreen(title: String, body: String, onBack: (() -> Unit)? = null) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        hub.core.android.ui.kit.EmptyState(title, body = body, icon = hub.core.android.ui.kit.Lucide.Wrench)
        if (onBack != null) hub.core.android.ui.kit.HubButton(stringResource(R.string.back), onBack, kind = hub.core.android.ui.kit.ButtonKind.Secondary, icon = hub.core.android.ui.kit.Lucide.ArrowLeft)
    }
}

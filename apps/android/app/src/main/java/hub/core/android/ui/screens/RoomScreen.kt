package hub.core.android.ui.screens

import hub.core.android.generated.ControlTokens
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Chip
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.Custom
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.StatusDot
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.R
import hub.core.android.chat.AttachmentTray
import hub.core.android.graph
import hub.core.android.phone.DictationStrip
import hub.core.android.phone.MicButton
import hub.core.android.phone.rememberDictation
import hub.core.android.rooms.RoomMentions
import hub.core.android.rooms.RoomTurns
import hub.core.android.ui.components.ApprovalCard
import hub.core.android.ui.components.AttachButton
import hub.core.android.ui.components.AttachmentChips
import hub.core.android.ui.components.Composer
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.Loading
import hub.core.android.ui.components.Notice
import hub.core.android.ui.components.QuestionCard
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.TurnView
import hub.core.android.ui.components.dismissKeyboardOnTap
import hub.core.android.ui.components.keyboardSink
import hub.core.android.ui.components.rememberDismissKeyboardOnScroll
import hub.core.android.ui.components.rememberKeyboardDismisser
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalKind
import hub.core.client.model.Member
import hub.core.client.model.Seat
import hub.core.client.model.SeatStatus

/**
 * One room (destination `rooms`): the transcript — your messages on the right, everyone else,
 * people and agents, on the left under their names — each seat's reply streaming in, what the
 * seats are doing now, what they wait for you to answer, and the chat's own composer (mic,
 * files, and `@` offering the room's seats). The members sheet opens from the top bar.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomScreen(roomId: String, profile: String, subtitle: String?, onMenu: () -> Unit, onGone: () -> Unit, actions: @Composable () -> Unit = {}) {
    val context = LocalContext.current
    val vm: RoomViewModel = viewModel(key = "room:$roomId:$profile") { RoomViewModel(context.graph, roomId, profile) }
    val ui by vm.ui.collectAsState()
    val state = ui.state
    var draft by rememberSaveable(roomId) { mutableStateOf("") }
    var members by remember { mutableStateOf(false) }
    val t = LocalTokens.current

    // Present in the room while it is on screen; typing and presence stop when it is not.
    DisposableEffect(roomId) {
        vm.enter()
        onDispose { vm.exit() }
    }
    LaunchedEffect(ui.gone) { if (ui.gone) onGone() }
    LaunchedEffect(draft) { if (draft.isNotBlank()) vm.typing(true) }

    TopBar(
        state.room?.name ?: stringResource(R.string.room_untitled),
        onMenu = onMenu,
        subtitle = subtitle,
    ) {
        actions()
        HubIconButton(Lucide.Users, stringResource(R.string.room_members), { members = true }, kind = IconKind.Glass, modifier = Modifier.testTag("room.members"))
    }

    val me = vm.me
    val turns = remember(state.messages, me) { RoomTurns.group(state.messages, me) }
    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
    val youLabel = stringResource(R.string.chat_you)
    val agents = hub.core.android.ui.components.rememberAgents(profile)
    val agentFallback = stringResource(R.string.agent_fallback)
    LaunchedEffect(turns.size, turns.lastOrNull()?.turn?.messages?.lastOrNull()?.text?.length) {
        if (turns.isNotEmpty() && (atBottom || listState.firstVisibleItemIndex == 0)) listState.scrollToItem(turns.lastIndex + 1)
    }
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { if (it == 0 && ui.hasOlder) vm.loadOlder() }
    }
    val dismissKeyboard = rememberKeyboardDismisser()
    val dismissOnScroll = rememberDismissKeyboardOnScroll(dismissKeyboard)

    Column(Modifier.fillMaxSize().imePadding()) {
        Box(
            Modifier.weight(1f).fillMaxWidth()
                .nestedScroll(dismissOnScroll)
                .dismissKeyboardOnTap(dismissKeyboard)
                .keyboardSink(dismissKeyboard)
                .testTag("room.transcript"),
        ) {
            if (ui.loading) {
                Loading()
            } else {
                LazyColumn(
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(hub.core.android.generated.LayoutTokens.turnGap.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    item(key = "older") {
                        if (ui.loadingOlder) Text(stringResource(R.string.chat_loading_older), color = t.textMuted)
                    }
                    items(turns, key = { it.turn.messages.first().id }) { turn ->
                        // A seat keeps its own name in the room, and wears its agent's face.
                        val agent = if (turn.turn.role != hub.core.client.model.MessageRole.ASSISTANT) null
                        else hub.core.android.ui.components.AgentIdentity.of(turn.turn.messages.first().authorId, turn.turn.authorName, agents, agentFallback)
                        TurnView(turn.turn, youLabel, profile, mine = turn.mine, agent = agent)
                    }
                }
            }
        }
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ui.error?.let { ErrorNotice(it) }
            if (state.room?.archived == true) Notice(stringResource(R.string.room_archived), Tone.INFO)
            state.approvals.values.sortedBy { it.createdAt }.forEach { approval ->
                if (approval.kind == ApprovalKind.QUESTION) {
                    QuestionCard(approval, onAnswer = { vm.respond(approval, null, it) }, onSkip = { vm.respond(approval, ApprovalDecision.DENY, null) })
                } else {
                    ApprovalCard(approval) { vm.respond(approval, it, null) }
                }
            }
            state.busySeats.forEach { seat -> SeatActivity(seat, state.stepOf(seat)) { vm.stopSeat(seat) } }
            val typing = state.typing.filterKeys { id -> state.members.none { it.id == id && it.userId == me } }.values
            if (typing.isNotEmpty()) {
                Text(stringResource(R.string.room_typing, typing.joinToString("، ")), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
        }
        // `@` offers the room's seats (and «everyone» where the room allows it).
        val query = RoomMentions.query(draft)
        if (query != null) {
            val options = RoomMentions.suggest(state.mentionSeats, query.query)
            val all = state.room?.canMentionAll == true && "all".startsWith(query.query.lowercase())
            if (options.isNotEmpty() || all) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.testTag("room.mentions"),
                ) {
                    if (all) item { Chip(stringResource(R.string.room_mention_all), false, { draft = RoomMentions.insert(draft, query.start, draft.length, "all").first }, size = ControlSize.Sm) }
                    items(options, key = { it.id }) { seat ->
                        Chip("@${seat.name}", false, { draft = RoomMentions.insert(draft, query.start, draft.length, seat.name).first }, size = ControlSize.Sm)
                    }
                }
            }
        }
        val files by vm.tray.items.collectAsState()
        AttachmentChips(files, onRemove = vm.tray::remove)
        val uploading = files.any { it.state == AttachmentTray.State.Uploading }
        val ready = files.any { it.state is AttachmentTray.State.Ready }
        val send = {
            val text = draft
            draft = ""
            vm.send(text) { failed -> if (draft.isBlank()) draft = failed }
        }
        val dictation = rememberDictation(
            profile = profile,
            recent = remember(state.messages) { state.messages.takeLast(8).map { it.text } },
            draft = { draft },
            onDraft = { draft = it },
            onSend = send,
        )
        if (state.room?.archived != true) {
            DictationStrip(dictation)
            Composer(
                text = draft,
                onText = { draft = it },
                placeholder = stringResource(R.string.room_placeholder),
                running = false,
                sending = ui.sending || uploading,
                onSend = { if (dictation.active) dictation.send() else send() },
                onStop = {},
                leading = { AttachButton(vm.tray) },
                trailing = { MicButton(dictation) },
                hasAttachments = ready,
            )
        }
    }

    if (members) {
        HubSheet(onDismiss = { members = false }, title = stringResource(R.string.room_members)) {
            MembersSheet(vm, ui, onClose = { members = false })
        }
    }
}

/** A seat at work: who, what it is doing, the tool it is in, and Stop. */
@Composable
private fun SeatActivity(seat: Seat, step: String?, onStop: () -> Unit) {
    val t = LocalTokens.current
    val label = when (seat.status) {
        SeatStatus.QUEUED -> R.string.room_seat_queued
        SeatStatus.THINKING -> R.string.room_seat_thinking
        SeatStatus.WAITING_APPROVAL -> R.string.room_seat_waiting
        else -> R.string.room_seat_running
    }
    Row(Modifier.fillMaxWidth().testTag("room.seat.${seat.id}"), verticalAlignment = Alignment.CenterVertically) {
        StatusDot(t.statusRunning, null)
        Spacer(Modifier.size(8.dp))
        Text(
            stringResource(label, seat.name) + (step?.let { " · $it" } ?: ""),
            fontSize = FontTokens.sizeSm.sp,
            color = t.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        hub.core.android.ui.components.StopButton(stringResource(R.string.room_seat_stop, seat.name), onStop, size = ControlTokens.heightSm.dp)
    }
}

/**
 * The members sheet: the room's agents (with what each is doing, and the lead), its people (who
 * is here now), the invite for the manager, and Leave for everyone but the maker.
 */
@Composable
private fun MembersSheet(vm: RoomViewModel, ui: RoomUi, onClose: () -> Unit) {
    val t = LocalTokens.current
    val agents = hub.core.android.ui.components.rememberAgents(vm.profile)
    val context = LocalContext.current
    val state = ui.state
    val room = state.room
    val me = vm.me
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp).testTag("room.members.sheet"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            GroupedList(title = stringResource(R.string.room_seats)) {
                state.seats.forEach { seat ->
                    Custom {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            hub.core.android.ui.components.AgentAvatar(
                                hub.core.android.ui.components.AgentIdentity.of(seat.agentId, seat.name, agents, seat.name), vm.profile, 28.dp,
                            )
                            Column(Modifier.weight(1f)) {
                                Text("@${seat.name}", fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.Medium)
                                seat.description?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 2) }
                            }
                            if (seat.id == room?.leadSeatId) Badge(stringResource(R.string.room_lead), tone = BadgeTone.Info)
                            if (seat.status != SeatStatus.IDLE) Badge(stringResource(seatStatusLabel(seat.status)), tone = BadgeTone.Success, dot = true)
                        }
                    }
                }
            }
        }
        item {
            GroupedList(title = stringResource(R.string.room_people)) {
                state.members.forEach { member ->
                    Item(
                        if (member.userId == me) stringResource(R.string.room_you_name, member.name) else member.name,
                        subtitle = stringResource(roleLabel(member.role)),
                        trailing = {
                            StatusDot(if (member.online) t.statusRunning else t.textFaint, null)
                            if (room?.canManage == true && member.userId != me && member.role != Member.Role.OWNER) {
                                HubIconButton(Lucide.Trash, stringResource(R.string.room_remove), { vm.removeMember(member) }, size = ControlTokens.heightMd.dp, iconSize = 16.dp, tint = t.danger)
                            }
                        },
                    )
                }
            }
        }
        if (room?.canManage == true) {
            item {
                val code = room.inviteCode
                val link = ui.inviteLink ?: code?.let { c -> context.graph.store.current?.hub?.let { RoomLinks.join(it, c) } }
                GroupedList(title = stringResource(R.string.room_invite)) {
                    Custom {
                        if (code != null) {
                            Text(
                                code, fontFamily = hub.core.android.ui.theme.Mono, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.testTag("room.invite.code"),
                            )
                        }
                        Text(stringResource(R.string.room_invite_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (link != null) {
                                HubButton(stringResource(R.string.room_invite_share), {
                                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
                                    context.startActivity(Intent.createChooser(send, room.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                }, size = ControlSize.Md, icon = Lucide.Share2)
                            }
                            HubButton(stringResource(R.string.room_invite_rotate), vm::rotateInvite, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.RotateCcw)
                        }
                    }
                }
            }
        }
        val mine = state.members.firstOrNull { it.userId == me }
        if (mine != null && mine.role != Member.Role.OWNER) {
            item {
                HubButton(
                    stringResource(R.string.room_leave), { vm.leave(); onClose() }, kind = ButtonKind.Danger, icon = Lucide.LogOut, fill = true,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp).testTag("room.leave"),
                )
            }
        }
    }
}

private fun seatStatusLabel(status: SeatStatus): Int = when (status) {
    SeatStatus.QUEUED -> R.string.room_status_queued
    SeatStatus.THINKING -> R.string.room_status_thinking
    SeatStatus.RUNNING -> R.string.room_status_running
    SeatStatus.WAITING_APPROVAL -> R.string.room_status_waiting
    SeatStatus.OFFLINE -> R.string.room_status_offline
    SeatStatus.IDLE -> R.string.room_status_idle
}

private fun roleLabel(role: Member.Role): Int = when (role) {
    Member.Role.OWNER -> R.string.room_role_owner
    Member.Role.MANAGER -> R.string.room_role_manager
    Member.Role.MEMBER -> R.string.room_role_member
}

/** A room's invite as a link, and an invite code read out of whatever was pasted. */
object RoomLinks {
    /** `<hub>/join/<code>`: the one join address web and phones share (contract decision §23). */
    fun join(hub: String, code: String): String = hub.trimEnd('/') + "/join/" + code

    /** The code in a pasted code or link (`…/join/AB12CD34`), upper-cased; null when none. */
    fun codeOf(input: String): String? {
        val text = input.trim()
        val tail = text.substringAfterLast("/join/", text).substringBefore('?').substringBefore('#').trim('/', ' ')
        val code = tail.uppercase()
        return code.takeIf { it.length in 6..32 && it.all { c -> c.isLetterOrDigit() } }
    }
}

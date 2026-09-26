package hub.core.android.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import hub.core.android.AppGraph
import hub.core.android.chat.AttachmentTray
import hub.core.android.chat.AttachmentUploader
import hub.core.android.chat.HubAttachmentBackend
import hub.core.android.chat.mimeOf
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.rooms.RoomMentions
import hub.core.android.rooms.RoomReducer
import hub.core.android.rooms.RoomState
import hub.core.client.model.Approval
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalResponse
import hub.core.client.model.Member
import hub.core.client.model.RoomMessageCreate
import hub.core.client.model.Seat
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class RoomUi(
    val state: RoomState = RoomState(),
    val loading: Boolean = true,
    val hasOlder: Boolean = false,
    val loadingOlder: Boolean = false,
    val sending: Boolean = false,
    val error: HubError? = null,
    /** The invite link the manager just made (`rotateInviteCode`). */
    val inviteLink: String? = null,
    /** You left the room, or were removed: the screen goes back to the draft. */
    val gone: Boolean = false,
)

/**
 * One open room (DECISIONS §69): HTTP for the room and its messages, `/rt/rooms` for everything
 * after (joined while the screen shows it), and the reply of each seat streaming into its
 * message. What is sent carries its mentions as structured ids and its files as blocks
 * (contract decision §99).
 */
class RoomViewModel(
    private val graph: AppGraph,
    val roomId: String,
    val profile: String,
) : ViewModel() {
    private val _ui = MutableStateFlow(RoomUi())
    val ui: StateFlow<RoomUi> = _ui.asStateFlow()
    private val apis get() = graph.store.current?.let(graph::apis)

    /** The signed-in person: their own messages are on the right. */
    val me: String? get() = graph.store.current?.user?.id

    /** Files for the next message, uploaded into the room's profile as soon as they are picked. */
    val tray = AttachmentTray(
        viewModelScope,
        upload = { file ->
            val api = apis ?: throw HubError(401, "unauthorized", null)
            AttachmentUploader(HubAttachmentBackend(api, profile)).upload(file, mimeOf(file))
        },
        discard = { attachment -> hubCall { apis?.sessions?.sessionsDeleteAttachment(attachment.profile, attachment.id) } },
    )

    private var typingSentAt = 0L

    init {
        viewModelScope.launch {
            graph.realtime.events.collect { envelope ->
                _ui.update { it.copy(state = RoomReducer.apply(it.state, envelope)) }
                if (_ui.value.state.deleted) _ui.update { it.copy(gone = true) }
            }
        }
        // Rooms have no replay: after a reconnect the room is read again.
        viewModelScope.launch { graph.realtime.roomReconnects.drop(1).collect { load() } }
        load()
    }

    /** The screen is showing: become present in the room and hear it. */
    fun enter() = graph.realtime.joinRoom(roomId)

    fun exit() {
        typing(false)
        graph.realtime.leaveRoom(roomId)
    }

    fun load() {
        val api = apis ?: return
        viewModelScope.launch {
            val detail = hubCall { api.rooms.roomsGet(profile, roomId) }
            val page = hubCall { api.rooms.roomsListMessages(profile, roomId, limit = 50) }
            val d = detail.getOrNull()
            val p = page.getOrNull()
            if (d == null || p == null) {
                val error = (detail.exceptionOrNull() ?: page.exceptionOrNull()) as? HubError
                _ui.update { it.copy(loading = false, error = error, gone = error?.status == 404) }
                return@launch
            }
            _ui.update { it.copy(loading = false, hasOlder = p.hasMore, state = RoomReducer.loaded(it.state, d, p.items)) }
        }
    }

    fun loadOlder() {
        val api = apis ?: return
        val first = _ui.value.state.messages.firstOrNull()?.id ?: return
        if (_ui.value.loadingOlder || !_ui.value.hasOlder) return
        _ui.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            hubCall { api.rooms.roomsListMessages(profile, roomId, before = first, limit = 50) }
                .onSuccess { page -> _ui.update { it.copy(loadingOlder = false, hasOlder = page.hasMore, state = RoomReducer.olderLoaded(it.state, page.items)) } }
                .onFailure { e -> _ui.update { it.copy(loadingOlder = false, error = e as HubError) } }
        }
    }

    /** Words and files as one message; the seats it names are its mentions (or the lead answers). */
    fun send(text: String, onFailed: (String) -> Unit = {}) {
        if (tray.uploading) return
        val picked = tray.message(text)
        if (picked.isEmpty) return
        // A room takes words, pictures and files (§99): a recording goes as a file.
        val outgoing = picked.copy(
            asFiles = picked.asFiles + picked.attachments.filter { it.kind == hub.core.client.model.Attachment.Kind.AUDIO }.map { it.id },
        )
        val api = apis ?: return
        val state = _ui.value.state
        val mentions = RoomMentions.mentionsIn(text, state.mentionSeats, state.room?.canMentionAll == true)
        tray.clear()
        typing(false)
        _ui.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            hubCall {
                api.rooms.roomsPostMessage(
                    profile, roomId,
                    RoomMessageCreate(content = outgoing.blocks(), mentions = mentions.ifEmpty { null }),
                    UUID.randomUUID().toString(),
                )
            }.onSuccess { _ui.update { it.copy(sending = false) } }
                .onFailure { e ->
                    _ui.update { it.copy(sending = false, error = e as HubError) }
                    onFailed(text)
                }
        }
    }

    /** Tells the others you are writing; at most once every two seconds while you type. */
    fun typing(on: Boolean) {
        val now = System.currentTimeMillis()
        if (on && now - typingSentAt < 2_000) return
        typingSentAt = if (on) now else 0L
        graph.realtime.typing(roomId, on)
    }

    fun respond(approval: Approval, decision: ApprovalDecision?, answer: String?) {
        val api = apis ?: return
        viewModelScope.launch {
            hubCall { api.sessions.sessionsRespondApproval(approval.profile, approval.id, ApprovalResponse(decision, answer)) }
                .onSuccess { drop(approval) }
                .onFailure { e -> if ((e as HubError).status == 409) drop(approval) else _ui.update { it.copy(error = e) } }
        }
    }

    private fun drop(approval: Approval) =
        _ui.update { it.copy(state = it.state.copy(approvals = it.state.approvals - approval.id)) }

    fun stopSeat(seat: Seat) = act { api -> api.rooms.roomsStopSeat(profile, roomId, seat.id) }

    fun removeMember(member: Member) = act { api -> api.rooms.roomsRemoveMember(profile, roomId, member.id); load() }

    /** Leaving is removing yourself (the maker stays, DECISIONS §69). */
    fun leave() {
        val mine = _ui.value.state.members.firstOrNull { it.userId == me } ?: return
        act { api ->
            api.rooms.roomsRemoveMember(profile, roomId, mine.id)
            _ui.update { it.copy(gone = true) }
        }
    }

    /** A new invite code (the old one stops working) and its link, for the manager to share. */
    fun rotateInvite() = act { api ->
        val invite = api.rooms.roomsRotateInviteCode(profile, roomId)
        _ui.update { ui ->
            ui.copy(
                inviteLink = invite.joinUrl.toString(),
                state = ui.state.copy(room = ui.state.room?.copy(inviteCode = invite.inviteCode)),
            )
        }
    }

    private fun act(block: suspend (hub.core.android.data.HubApis) -> Unit) {
        val api = apis ?: return
        viewModelScope.launch { hubCall { block(api) }.onFailure { e -> _ui.update { it.copy(error = e as HubError) } } }
    }

    fun dismissError() = _ui.update { it.copy(error = null) }

    override fun onCleared() {
        exit()
    }
}

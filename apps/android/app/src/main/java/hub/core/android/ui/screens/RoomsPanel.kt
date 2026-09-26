package hub.core.android.ui.screens

import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.AgentAvatar
import hub.core.android.ui.components.AgentIdentity
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Chip
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.ItemShape
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.AppGraph
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.nav.Navigator
import hub.core.android.nav.Route
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Agent
import hub.core.client.model.Room
import hub.core.client.model.RoomCreate
import hub.core.client.model.RoomInvitePreview
import hub.core.client.model.SeatConfig
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class RoomsUi(
    val rooms: List<Room>? = null,
    val error: HubError? = null,
    /** The agents a new room's seats can be (the selector's profile). */
    val agents: List<Agent> = emptyList(),
    val busy: Boolean = false,
    val preview: RoomInvitePreview? = null,
    val dialogError: HubError? = null,
)

/** Pure rules of making a room, tested without a hub. */
object NewRoom {
    /**
     * One seat per chosen agent, named after it; a second seat of the same agent gets a number,
     * because seat names are unique in a room (contract decision §23).
     */
    fun seats(chosen: List<Agent>): List<SeatConfig> {
        val used = mutableSetOf<String>()
        return chosen.map { agent ->
            var name = agent.name.trim().ifEmpty { agent.slug }
            var n = 2
            while (name.lowercase() in used || name.lowercase() == "all") name = "${agent.name.trim()} ${n++}"
            used += name.lowercase()
            SeatConfig(agentId = agent.id, name = name)
        }
    }
}

/**
 * The drawer's Rooms list (the selector's profile, like the web's) with its two actions,
 * New room and Join by code (navigation.json `rooms.actions`).
 */
class RoomsViewModel(private val graph: AppGraph) : ViewModel() {
    private val _ui = MutableStateFlow(RoomsUi())
    val ui: StateFlow<RoomsUi> = _ui.asStateFlow()
    private val session get() = graph.store.current

    fun load() {
        val s = session ?: return
        viewModelScope.launch {
            hubCall { graph.apis(s).rooms.roomsList(s.profile, archived = false, limit = 100) }
                .onSuccess { page -> _ui.update { it.copy(rooms = page.items, error = null) } }
                .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
            hubCall { graph.apis(s).agents.agentsList(s.profile) }
                .onSuccess { page -> _ui.update { it.copy(agents = ChatAgents.startable(page.items)) } }
        }
    }

    fun create(name: String, agents: List<Agent>, onMade: (Room) -> Unit) {
        val s = session ?: return
        _ui.update { it.copy(busy = true, dialogError = null) }
        viewModelScope.launch {
            hubCall {
                graph.apis(s).rooms.roomsCreate(s.profile, RoomCreate(name = name.trim(), seats = NewRoom.seats(agents)), UUID.randomUUID().toString())
            }.onSuccess { made ->
                _ui.update { it.copy(busy = false) }
                load()
                onMade(made.room)
            }.onFailure { e -> _ui.update { it.copy(busy = false, dialogError = e as HubError) } }
        }
    }

    /** What a code opens, before joining: its name, and how many agents and people are in it. */
    fun preview(code: String) {
        val s = session ?: return
        _ui.update { it.copy(busy = true, dialogError = null, preview = null) }
        viewModelScope.launch {
            hubCall { graph.apis(s).rooms.roomsPreviewInvite(code) }
                .onSuccess { p -> _ui.update { it.copy(busy = false, preview = p) } }
                .onFailure { e -> _ui.update { it.copy(busy = false, dialogError = e as HubError) } }
        }
    }

    fun join(code: String, onJoined: (Room) -> Unit) {
        val s = session ?: return
        _ui.update { it.copy(busy = true, dialogError = null) }
        viewModelScope.launch {
            hubCall { graph.apis(s).rooms.roomsJoin(code) }
                .onSuccess { room ->
                    _ui.update { it.copy(busy = false, preview = null) }
                    load()
                    onJoined(room)
                }
                .onFailure { e -> _ui.update { it.copy(busy = false, dialogError = e as HubError) } }
        }
    }

    fun resetDialog() = _ui.update { it.copy(preview = null, dialogError = null, busy = false) }
}

@Composable
fun RoomsPanel(nav: Navigator, header: @Composable () -> Unit = {}, onOpen: () -> Unit) {
    val context = LocalContext.current
    val vm: RoomsViewModel = viewModel { RoomsViewModel(context.graph) }
    val ui by vm.ui.collectAsState()
    val session by context.graph.store.session.collectAsState()
    val t = LocalTokens.current
    var making by remember { mutableStateOf(false) }
    var joining by remember { mutableStateOf(false) }
    LaunchedEffect(session?.profile) { vm.load() }
    val open: (Room) -> Unit = { room -> nav.go(Route.Room(room.id, room.profile)); onOpen() }
    LazyColumn(Modifier.fillMaxSize().testTag("rooms.list"), contentPadding = PaddingValues(bottom = 8.dp)) {
        item(key = "header") { header() }
        item(key = "actions") {
            // The two actions of the Rooms segment (navigation.json `rooms.actions`): the first is
            // the one to take, the second sits beside it quieter.
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HubButton(
                    term("new_room"), { vm.resetDialog(); making = true }, kind = ButtonKind.Subtle, size = ControlSize.Md,
                    icon = Lucide.Plus, fill = true, modifier = Modifier.weight(1f).testTag("rooms.new"),
                )
                HubButton(
                    term("join_by_code"), { vm.resetDialog(); joining = true }, kind = ButtonKind.Secondary, size = ControlSize.Md,
                    icon = Lucide.Hash, fill = true, modifier = Modifier.weight(1f).testTag("rooms.join"),
                )
            }
        }
        ui.error?.let { error -> item(key = "error") { ErrorNotice(error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) } }
        items(ui.rooms.orEmpty(), key = { it.id }) { room ->
            val selected = (nav.current as? Route.Room)?.roomId == room.id
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(ItemShape)
                    .background(if (selected) t.surface2 else Color.Transparent, ItemShape)
                    .clickable { open(room) }
                    .padding(horizontal = 8.dp, vertical = 7.dp)
                    .testTag("room.row.${room.id}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(24.dp).background(t.accentSoft, CircleShape), contentAlignment = Alignment.Center) {
                    LucideIcon(Lucide.Users, null, size = 14.dp, tint = t.accentSoftText)
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        room.name, fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = TextStyle(textDirection = TextDirection.Content),
                    )
                    Text(stringResource(R.string.rooms_counts, room.seats.size, room.memberCount), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                }
            }
        }
        if (ui.rooms?.isEmpty() == true) {
            item(key = "empty") {
                Text(stringResource(R.string.rooms_empty), fontSize = FontTokens.sizeSm.sp, color = t.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp))
            }
        }
    }
    if (making) NewRoomDialog(ui, onCancel = { making = false }) { name, agents -> vm.create(name, agents) { making = false; open(it) } }
    if (joining) JoinRoomDialog(ui, vm::preview, onCancel = { joining = false }) { code -> vm.join(code) { joining = false; open(it) } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NewRoomDialog(ui: RoomsUi, onCancel: () -> Unit, onMake: (String, List<Agent>) -> Unit) {
    val t = LocalTokens.current
    var name by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf(listOf<String>()) }
    HubDialog(onCancel, term("new_room")) {
        HubTextField(
            name, { name = it.take(120) }, label = stringResource(R.string.room_name),
            modifier = Modifier.fillMaxWidth().testTag("rooms.new.name"),
        )
        Text(stringResource(R.string.room_pick_agents), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        if (ui.agents.isEmpty()) Text(stringResource(R.string.chat_no_agents_body), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.agents.forEach { agent ->
                Chip(
                    agent.name, selected = agent.id in chosen,
                    onClick = { chosen = if (agent.id in chosen) chosen - agent.id else chosen + agent.id },
                    leading = { AgentAvatar(AgentIdentity.of(agent), agent.profile, 20.dp) },
                )
            }
        }
        Text(stringResource(R.string.room_lead_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        ErrorNotice(ui.dialogError)
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HubButton(stringResource(R.string.cancel), onCancel, kind = ButtonKind.Secondary, size = ControlSize.Md)
            HubButton(
                stringResource(R.string.room_make), { onMake(name, chosen.mapNotNull { id -> ui.agents.firstOrNull { it.id == id } }) },
                size = ControlSize.Md, enabled = name.isNotBlank() && !ui.busy, loading = ui.busy, modifier = Modifier.testTag("rooms.new.make"),
            )
        }
    }
}

@Composable
private fun JoinRoomDialog(ui: RoomsUi, onPreview: (String) -> Unit, onCancel: () -> Unit, onJoin: (String) -> Unit) {
    val t = LocalTokens.current
    var input by remember { mutableStateOf("") }
    val code = RoomLinks.codeOf(input)
    HubDialog(onCancel, term("join_by_code")) {
        HubTextField(
            input, { input = it }, label = stringResource(R.string.room_code), placeholder = stringResource(R.string.room_code_hint),
            mono = true, modifier = Modifier.fillMaxWidth().testTag("rooms.join.code"),
        )
        ui.preview?.let { p ->
            HubCard(padding = 12.dp) {
                Text(p.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold)
                Text(stringResource(R.string.rooms_counts, p.seatCount, p.memberCount), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                if (p.alreadyMember) Badge(stringResource(R.string.room_already_member), tone = BadgeTone.Info)
            }
        }
        ErrorNotice(ui.dialogError)
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HubButton(stringResource(R.string.cancel), onCancel, kind = ButtonKind.Secondary, size = ControlSize.Md)
            if (ui.preview == null) {
                HubButton(
                    stringResource(R.string.room_find), { code?.let(onPreview) }, size = ControlSize.Md,
                    enabled = code != null && !ui.busy, loading = ui.busy, modifier = Modifier.testTag("rooms.join.preview"),
                )
            } else {
                HubButton(
                    stringResource(if (ui.preview.alreadyMember) R.string.room_open else R.string.room_join), { code?.let(onJoin) }, size = ControlSize.Md,
                    enabled = code != null && !ui.busy, loading = ui.busy, modifier = Modifier.testTag("rooms.join.go"),
                )
            }
        }
    }
}

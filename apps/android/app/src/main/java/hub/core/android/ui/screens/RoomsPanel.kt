package hub.core.android.ui.screens

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
fun RoomsPanel(nav: Navigator, onOpen: () -> Unit) {
    val context = LocalContext.current
    val vm: RoomsViewModel = viewModel { RoomsViewModel(context.graph) }
    val ui by vm.ui.collectAsState()
    val session by context.graph.store.session.collectAsState()
    val t = LocalTokens.current
    var making by remember { mutableStateOf(false) }
    var joining by remember { mutableStateOf(false) }
    LaunchedEffect(session?.profile) { vm.load() }
    val open: (Room) -> Unit = { room -> nav.go(Route.Room(room.id, room.profile)); onOpen() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { vm.resetDialog(); making = true }, modifier = Modifier.testTag("rooms.new")) { Text(term("new_room")) }
            TextButton(onClick = { vm.resetDialog(); joining = true }, modifier = Modifier.testTag("rooms.join")) { Text(term("join_by_code")) }
        }
        ErrorNotice(ui.error, Modifier.padding(horizontal = 16.dp))
        LazyColumn(Modifier.fillMaxSize()) {
            items(ui.rooms.orEmpty(), key = { it.id }) { room ->
                val selected = (nav.current as? Route.Room)?.roomId == room.id
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp)
                        .clickable { open(room) }
                        .padding(horizontal = 8.dp, vertical = 10.dp)
                        .testTag("room.row.${room.id}"),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(room.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (selected) t.accent else t.text)
                        Text(
                            stringResource(R.string.rooms_counts, room.seats.size, room.memberCount),
                            style = MaterialTheme.typography.bodySmall, color = t.textMuted,
                        )
                    }
                }
            }
            if (ui.rooms?.isEmpty() == true) {
                item { Text(stringResource(R.string.rooms_empty), color = t.textMuted, modifier = Modifier.padding(16.dp)) }
            }
        }
    }
    if (making) NewRoomDialog(ui, onCancel = { making = false }) { name, agents -> vm.create(name, agents) { making = false; open(it) } }
    if (joining) JoinRoomDialog(ui, vm::preview, onCancel = { joining = false }) { code -> vm.join(code) { joining = false; open(it) } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NewRoomDialog(ui: RoomsUi, onCancel: () -> Unit, onMake: (String, List<Agent>) -> Unit) {
    var name by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf(listOf<String>()) }
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(term("new_room")) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it.take(120) }, singleLine = true,
                    label = { Text(stringResource(R.string.room_name)) },
                    modifier = Modifier.fillMaxWidth().testTag("rooms.new.name"),
                )
                Text(stringResource(R.string.room_pick_agents), style = MaterialTheme.typography.labelMedium)
                if (ui.agents.isEmpty()) Text(stringResource(R.string.chat_no_agents_body), style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ui.agents.forEach { agent ->
                        FilterChip(
                            selected = agent.id in chosen,
                            onClick = { chosen = if (agent.id in chosen) chosen - agent.id else chosen + agent.id },
                            label = { Text(agent.name) },
                        )
                    }
                }
                Text(stringResource(R.string.room_lead_hint), style = MaterialTheme.typography.bodySmall, color = LocalTokens.current.textMuted)
                ErrorNotice(ui.dialogError)
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onMake(name, chosen.mapNotNull { id -> ui.agents.firstOrNull { it.id == id } }) },
                enabled = name.isNotBlank() && !ui.busy,
                modifier = Modifier.testTag("rooms.new.make"),
            ) { Text(stringResource(R.string.room_make)) }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) } },
        shape = RoundedCornerShape(20.dp),
    )
}

@Composable
private fun JoinRoomDialog(ui: RoomsUi, onPreview: (String) -> Unit, onCancel: () -> Unit, onJoin: (String) -> Unit) {
    var input by remember { mutableStateOf("") }
    val code = RoomLinks.codeOf(input)
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(term("join_by_code")) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = input, onValueChange = { input = it }, singleLine = true,
                    label = { Text(stringResource(R.string.room_code)) },
                    placeholder = { Text(stringResource(R.string.room_code_hint)) },
                    modifier = Modifier.fillMaxWidth().testTag("rooms.join.code"),
                )
                ui.preview?.let { p ->
                    Text(p.name, style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.rooms_counts, p.seatCount, p.memberCount), style = MaterialTheme.typography.bodySmall)
                    if (p.alreadyMember) Text(stringResource(R.string.room_already_member), style = MaterialTheme.typography.bodySmall)
                }
                ErrorNotice(ui.dialogError)
            }
        },
        confirmButton = {
            if (ui.preview == null) {
                TextButton(onClick = { code?.let(onPreview) }, enabled = code != null && !ui.busy, modifier = Modifier.testTag("rooms.join.preview")) {
                    Text(stringResource(R.string.room_find))
                }
            } else {
                TextButton(onClick = { code?.let(onJoin) }, enabled = code != null && !ui.busy, modifier = Modifier.testTag("rooms.join.go")) {
                    Text(stringResource(if (ui.preview.alreadyMember) R.string.room_open else R.string.room_join))
                }
            }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) } },
    )
}

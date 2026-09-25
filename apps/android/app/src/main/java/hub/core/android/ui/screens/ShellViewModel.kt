package hub.core.android.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import hub.core.android.AppGraph
import hub.core.android.data.HubError
import hub.core.android.data.StoredSession
import hub.core.android.data.hubCall
import hub.core.android.realtime.SESSIONS_NAMESPACE
import hub.core.client.api.SessionsApi
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Profile
import hub.core.client.model.Session
import hub.core.client.model.SessionSource
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The chats list's own archive filter (carried in the web's URL as `?sessions=`). */
enum class ArchiveFilter { ACTIVE, ARCHIVED, ALL }

data class ChatsState(
    val items: List<Session> = emptyList(),
    val loading: Boolean = false,
    val error: HubError? = null,
    val nextCursor: String? = null,
    /** Null is «all profiles», the default on every entry into the app (ADR 0016). */
    val profileFilter: String? = null,
    val archive: ArchiveFilter = ArchiveFilter.ACTIVE,
    val query: String = "",
)

/** Pure rules of the chats list, kept apart from the view model so they are unit-tested. */
object ChatsList {
    /** The global agent's conversation never appears in the list (DECISIONS §46). */
    fun visible(session: Session): Boolean = session.source != SessionSource.GLOBAL_AGENT

    /** Pinned first, then the most recent activity first. */
    fun order(items: List<Session>): List<Session> =
        items.sortedWith(compareByDescending<Session> { it.pinned }.thenByDescending { it.lastMessageAt ?: it.updatedAt })

    /** Whether a session belongs to the list as filtered right now. */
    fun matches(state: ChatsState, session: Session): Boolean {
        if (!visible(session)) return false
        if (state.profileFilter != null && session.profile != state.profileFilter) return false
        if (state.query.isNotBlank()) return false // a search result set is not updated live
        return when (state.archive) {
            ArchiveFilter.ACTIVE -> !session.archived
            ArchiveFilter.ARCHIVED -> session.archived
            ArchiveFilter.ALL -> true
        }
    }

    /** A `session.created` or `session.updated`: in the list, out of it, or moved. */
    fun upsert(state: ChatsState, session: Session): ChatsState {
        val rest = state.items.filter { it.id != session.id }
        return state.copy(items = order(if (matches(state, session)) rest + session else rest))
    }

    fun remove(state: ChatsState, sessionId: String): ChatsState = state.copy(items = state.items.filter { it.id != sessionId })

    /** Badges are drawn when the list may hold more than one profile. */
    fun showsProfiles(state: ChatsState, profileCount: Int): Boolean = state.profileFilter == null && profileCount > 1
}

/** The signed-in shell: profiles, the drawer's chats list, and the realtime connection. */
class ShellViewModel(private val graph: AppGraph) : ViewModel() {
    val session: StateFlow<StoredSession?> = graph.store.session
    private val _profiles = MutableStateFlow<List<Profile>>(emptyList())
    val profiles: StateFlow<List<Profile>> = _profiles.asStateFlow()
    private val _chats = MutableStateFlow(ChatsState())
    val chats: StateFlow<ChatsState> = _chats.asStateFlow()
    private var loadJob: Job? = null

    init {
        viewModelScope.launch {
            graph.store.session.filterNotNull().distinctUntilChangedBy { it.hub + "|" + it.user.id + "|" + it.profile }.collect { s ->
                graph.realtime.connect(s)
                loadProfiles()
                reloadChats()
            }
        }
        viewModelScope.launch {
            graph.realtime.refused.collect {
                // A refused handshake is not retried by Socket.IO: renew the token over HTTP, then reconnect.
                val s = graph.store.current ?: return@collect
                hubCall { graph.apis(s).auth.authGetMe() }
                graph.store.current?.let { graph.realtime.connect(it, force = true) }
            }
        }
        viewModelScope.launch {
            graph.realtime.events.collect { envelope ->
                if (envelope.namespace != SESSIONS_NAMESPACE) return@collect
                val json = Serializer.kotlinxSerializationJson
                when (envelope.event) {
                    "session.created", "session.updated" -> envelope.payload["session"]?.let {
                        runCatching { json.decodeFromJsonElement(Session.serializer(), it) }.getOrNull()
                    }?.let { s -> _chats.update { ChatsList.upsert(it, s) } }
                    "session.deleted" -> (envelope.payload["session_id"] as? JsonPrimitive)?.contentOrNull?.let { id ->
                        _chats.update { ChatsList.remove(it, id) }
                    }
                }
            }
        }
    }

    private fun loadProfiles() {
        val s = graph.store.current ?: return
        viewModelScope.launch {
            hubCall { graph.apis(s).auth.authListProfiles() }.onSuccess { page ->
                _profiles.value = page.items.filter { it.slug in s.user.profiles || s.user.isAdmin }
            }
        }
    }

    fun profileName(slug: String): String = _profiles.value.firstOrNull { it.slug == slug }?.name ?: slug

    /** The top selector: always one concrete profile. It never filters a list (NAVIGATION.md rule 4). */
    fun switchProfile(slug: String) = graph.store.update { it.copy(profile = slug) }

    fun setProfileFilter(slug: String?) {
        _chats.update { it.copy(profileFilter = slug) }
        reloadChats()
    }

    fun setArchive(filter: ArchiveFilter) {
        _chats.update { it.copy(archive = filter) }
        reloadChats()
    }

    fun setQuery(query: String) {
        _chats.update { it.copy(query = query) }
        reloadChats()
    }

    fun reloadChats() = load(cursor = null)

    fun loadMore() {
        val cursor = _chats.value.nextCursor ?: return
        if (_chats.value.loading) return
        load(cursor)
    }

    private fun load(cursor: String?) {
        val s = graph.store.current ?: return
        val filter = _chats.value
        loadJob?.cancel()
        _chats.update { it.copy(loading = true, error = null) }
        loadJob = viewModelScope.launch {
            hubCall {
                graph.apis(s).sessions.sessionsList(
                    xHubProfile = filter.profileFilter ?: s.profile,
                    profiles = if (filter.profileFilter == null) SessionsApi.ProfilesSessionsList.ALL else null,
                    archived = when (filter.archive) {
                        ArchiveFilter.ACTIVE -> SessionsApi.ArchivedSessionsList.FALSE
                        ArchiveFilter.ARCHIVED -> SessionsApi.ArchivedSessionsList.TRUE
                        ArchiveFilter.ALL -> SessionsApi.ArchivedSessionsList.ALL
                    },
                    q = filter.query.trim().ifEmpty { null },
                    cursor = cursor,
                    limit = 50,
                )
            }.onSuccess { page ->
                val fresh = page.items.filter(ChatsList::visible)
                _chats.update {
                    it.copy(
                        items = if (cursor == null) fresh else (it.items + fresh).distinctBy { s -> s.id },
                        nextCursor = page.nextCursor,
                        loading = false,
                    )
                }
            }.onFailure { e -> _chats.update { it.copy(loading = false, error = e as HubError) } }
        }
    }

    fun signOut() {
        val s = graph.store.current ?: return
        viewModelScope.launch {
            hubCall { graph.apis(s).auth.authLogout() }
            graph.realtime.close()
            graph.store.save(null)
        }
    }
}

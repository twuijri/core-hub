package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.nav.Route
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.ListRow
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.ProfileBadge
import hub.core.android.ui.components.StatusBadge
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.api.SessionsApi
import hub.core.client.model.Session
import hub.core.client.model.SessionSource
import hub.core.client.model.GlobalAgentOpen
import kotlinx.coroutines.delay

/** Where a search hit opens: the global agent's own page, or the conversation in its profile. */
object SearchHits {
    fun routeOf(session: Session): Route =
        if (session.source == SessionSource.GLOBAL_AGENT) Route.GlobalAgent(session.profile)
        else Route.Chat(session.id, session.profile)
}

/**
 * Search over every conversation in every profile the person may enter, archived ones too
 * (NAVIGATION.md rule 4: search always searches all). The field is focused on arrival; opening
 * a hit does not change the chats list's segment or filter.
 */
@Composable
fun SearchScreen(shell: ShellViewModel, onOpen: (Route) -> Unit) {
    val context = LocalContext.current
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Session>>(emptyList()) }
    var error by remember { mutableStateOf<HubError?>(null) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(query) {
        if (query.isBlank()) {
            results = emptyList()
            return@LaunchedEffect
        }
        delay(250)
        val s = context.graph.store.current ?: return@LaunchedEffect
        hubCall {
            context.graph.apis(s).sessions.sessionsList(
                s.profile, profiles = SessionsApi.ProfilesSessionsList.ALL,
                archived = SessionsApi.ArchivedSessionsList.ALL, q = query.trim(), limit = 50,
            )
        }.onSuccess { results = it.items; error = null }.onFailure { error = it as HubError }
    }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text(stringResource(R.string.search_placeholder)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(12.dp).focusRequester(focus),
        )
        error?.let { ErrorNotice(it, Modifier.padding(horizontal = 12.dp)) }
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (query.isNotBlank() && results.isEmpty() && error == null) {
                item { Text(stringResource(R.string.search_none), color = LocalTokens.current.textMuted) }
            }
            items(results, key = { it.id }) { session ->
                ListRow(
                    title = if (session.source == SessionSource.GLOBAL_AGENT) term("global_agent") else session.title ?: term("new_chat"),
                    subtitle = session.match?.snippet ?: session.preview,
                    trailing = {
                        Column(horizontalAlignment = androidx.compose.ui.Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (session.archived) StatusBadge(stringResource(R.string.chats_archived))
                            ProfileBadge(shell.profileName(session.profile))
                        }
                    },
                    onClick = { onOpen(SearchHits.routeOf(session)) },
                )
            }
        }
    }
}

/**
 * The global agent: the person's one standing conversation in the profile, made on first open
 * with the profile's first agent (DECISIONS §46). No menu entry reaches it; search does.
 */
@Composable
fun GlobalAgentScreen(profile: String, profileName: String) {
    val context = LocalContext.current
    val opened = rememberLoad(profile) {
        val s = context.graph.store.current!!
        val apis = context.graph.apis(s)
        val agent = ChatAgents.startable(apis.agents.agentsList(profile).items).firstOrNull()
            ?: throw HubError(409, "agent_unavailable", null)
        apis.sessions.sessionsOpenGlobalAgent(profile, GlobalAgentOpen(agent.id))
    }
    LoadView(opened) { session ->
        ChatScreen(session.id, session.profile, profileName, onCreated = { _, _ -> })
    }
    if (opened.state is hub.core.android.ui.components.Load.Failed) {
        StatusBadge(stringResource(R.string.chat_no_agents), Tone.WARNING)
    }
}

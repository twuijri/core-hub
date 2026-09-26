package hub.core.android.ui.screens

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.AgentAvatar
import hub.core.android.ui.components.AgentIdentity
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Chip
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.AppLanguage
import hub.core.android.R
import hub.core.android.graph
import hub.core.android.nav.Route
import hub.core.android.nav.Screens
import hub.core.android.ui.components.InContentDirection
import hub.core.android.ui.components.ListRow
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.StatusBadge
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Agent
import hub.core.client.model.AgentStatus
import hub.core.client.model.Channel
import hub.core.client.model.LocalizedText
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The pages an agent offers, from what its adapter declares (the client never decides). */
fun agentPagesOf(agent: Agent): List<String> = Screens.agentPages(
    agent.capabilities.map { it.value },
    configurable = agent.status != AgentStatus.NOT_INSTALLED && agent.install.source != hub.core.client.model.AgentInstall.Source.NONE,
)

/** Owners and admins only; everyone else is sent back, as the web does (NAVIGATION.md §4 rule 5). */
@Composable
fun AdminOnly(isAdmin: Boolean, onRefused: () -> Unit, content: @Composable () -> Unit) {
    if (isAdmin) content() else androidx.compose.runtime.LaunchedEffect(Unit) { onRefused() }
}

@Composable
private fun statusText(status: AgentStatus): Pair<String, Tone?> = when (status) {
    AgentStatus.AVAILABLE -> stringResource(R.string.agent_available) to Tone.SUCCESS
    AgentStatus.LIMITED -> stringResource(R.string.agent_limited) to Tone.WARNING
    AgentStatus.NOT_INSTALLED -> stringResource(R.string.agent_not_installed) to null
    AgentStatus.INSTALLING, AgentStatus.UPDATING -> stringResource(R.string.agent_installing) to Tone.INFO
    AgentStatus.ERROR -> stringResource(R.string.agent_error) to Tone.DANGER
    AgentStatus.DISABLED -> stringResource(R.string.agent_disabled) to null
}

/**
 * The Agents page, as on iOS: a card per agent from the hub's registry — its face, name, version
 * and state (a tinted badge with a dot), what it can do as one quiet line, and its own pages as
 * soft buttons.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AgentsScreen(profile: String, onOpen: (Route) -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val agents = rememberLoad(profile) {
        val s = context.graph.store.current!!
        context.graph.apis(s).agents.agentsList(profile).items
    }
    LoadView(agents) { list ->
        LazyColumn(
            Modifier.fillMaxSize().testTag("agents.list"),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (list.isEmpty()) item { EmptyState(stringResource(R.string.chat_no_agents), body = stringResource(R.string.chat_no_agents_body), icon = Lucide.Bot) }
            items(list, key = { it.id }) { agent ->
                HubCard(Modifier.testTag("agent.card.${agent.slug}"), padding = 16.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AgentAvatar(AgentIdentity.of(agent), profile, 36.dp)
                        Column(Modifier.weight(1f)) {
                            Text(agent.name, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold)
                            listOfNotNull(agent.vendor, agent.install.version).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                                Text(it, fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                            }
                        }
                        val (label, tone) = statusText(agent.status)
                        StatusBadge(label, tone)
                    }
                    // What it can do is information, not buttons: one quiet line.
                    if (agent.capabilities.isNotEmpty()) {
                        Text(agent.capabilities.joinToString(" · ") { it.value }, fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                        agentPagesOf(agent).forEach { page ->
                            HubButton(
                                term(titleOfPage(page)), { onOpen(Route.AgentPage(page, agent.id, agent.name)) },
                                kind = ButtonKind.Subtle, size = ControlSize.Sm, icon = Lucide.ChevronRight,
                                modifier = Modifier.testTag("agent.page.${agent.slug}.$page"),
                            )
                        }
                    }
                }
            }
        }
    }
}

fun titleOfPage(page: String): String = if (page == "agent_settings") "agent_settings" else page.removePrefix("agent_")

/**
 * One of an agent's pages. On the phone the agent's list is the page (NAVIGATION.md §4 rule 6):
 * «Back to agents» at the top, the agent's name, its pages as a row, then the page itself.
 */
@Composable
fun AgentPageScreen(route: Route.AgentPage, profile: String, onOpen: (Route) -> Unit, onBackToAgents: () -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val agent = rememberLoad(route.agentId, profile) {
        val s = context.graph.store.current!!
        context.graph.apis(s).agents.agentsGet(profile, route.agentId)
    }
    Column(Modifier.fillMaxSize()) {
        HubButton(
            term("back_to_agents"), onBackToAgents, kind = ButtonKind.Ghost, size = ControlSize.Md, icon = Lucide.ArrowLeft,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        Text(route.agentName, fontSize = FontTokens.sizeXl.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 16.dp))
        LoadView(agent) { a ->
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                agentPagesOf(a).forEach { page ->
                    Chip(term(titleOfPage(page)), selected = page == route.destination, onClick = { onOpen(Route.AgentPage(page, a.id, a.name)) }, size = ControlSize.Sm)
                }
            }
            AgentPageBody(route.destination, a, profile)
        }
    }
}

@Composable
private fun localized(text: LocalizedText): String =
    if (LocalContext.current.graph.prefs.effectiveLanguage == AppLanguage.AR) text.ar else text.en

/** The page itself, editable on the phone as on iOS (AgentPages.kt). */
@Composable
private fun AgentPageBody(page: String, agent: Agent, profile: String) = AgentPageEditable(page, agent, profile)

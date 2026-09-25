package hub.core.android.ui.screens

import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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

/** The Agents page: a card per agent from the hub's registry, its chips opening its own pages. */
@Composable
fun AgentsScreen(profile: String, onOpen: (Route) -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val agents = rememberLoad(profile) {
        val s = context.graph.store.current!!
        context.graph.apis(s).agents.agentsList(profile).items
    }
    LoadView(agents) { list ->
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(list, key = { it.id }) { agent ->
                Surface(color = t.surface, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().border(0.5.dp, t.border, MaterialTheme.shapes.large)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(agent.name, style = MaterialTheme.typography.titleSmall)
                                listOfNotNull(agent.vendor, agent.install.version).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall, color = t.textMuted)
                                }
                            }
                            val (label, tone) = statusText(agent.status)
                            StatusBadge(label, tone)
                        }
                        // Capability tags are information, not buttons.
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            agent.capabilities.forEach { StatusBadge(it.value) }
                        }
                        run {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                agentPagesOf(agent).forEach { page ->
                                    AssistChip(
                                        onClick = { onOpen(Route.AgentPage(page, agent.id, agent.name)) },
                                        label = { Text(term(titleOfPage(page))) },
                                        trailingIcon = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
                                    )
                                }
                            }
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
        TextButton(onClick = onBackToAgents, modifier = Modifier.padding(horizontal = 4.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
            Text(term("back_to_agents"), modifier = Modifier.padding(start = 6.dp))
        }
        Text(route.agentName, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp))
        LoadView(agent) { a ->
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                agentPagesOf(a).forEach { page ->
                    FilterChip(selected = page == route.destination, onClick = { onOpen(Route.AgentPage(page, a.id, a.name)) }, label = { Text(term(titleOfPage(page))) })
                }
            }
            AgentPageBody(route.destination, a, profile)
        }
    }
}

@Composable
private fun localized(text: LocalizedText): String =
    if (LocalContext.current.graph.prefs.effectiveLanguage == AppLanguage.AR) text.ar else text.en

@Composable
private fun AgentPageBody(page: String, agent: Agent, profile: String) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val api = { context.graph.apis(context.graph.store.current!!) }
    val pad = PaddingValues(12.dp)
    when (page) {
        "agent_skills" -> LoadView(rememberLoad(agent.id, profile) { api().agents.agentsListSkills(profile, agent.id).categories }) { categories ->
            LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (categories.all { it.skills.isEmpty() }) item { Text(stringResource(R.string.agent_nothing), color = t.textMuted) }
                categories.forEach { category ->
                    if (category.skills.isNotEmpty()) item(key = "c" + category.key) { Text(category.name, style = MaterialTheme.typography.labelLarge, color = t.textMuted) }
                    items(category.skills, key = { category.key + it.key }) { skill ->
                        ListRow(skill.name, skill.description, trailing = {
                            StatusBadge(stringResource(if (skill.enabled) R.string.agent_on else R.string.agent_off), if (skill.enabled) Tone.SUCCESS else null)
                        })
                    }
                }
            }
        }
        "agent_mcp" -> LoadView(rememberLoad(agent.id, profile) { api().agents.agentsListMcpServers(profile, agent.id).items }) { servers ->
            LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (servers.isEmpty()) item { Text(stringResource(R.string.agent_nothing), color = t.textMuted) }
                items(servers, key = { it.name }) { server ->
                    ListRow(
                        server.name,
                        listOfNotNull(server.transport.value, stringResource(R.string.agent_tools, server.tools.size), server.error).joinToString(" · "),
                        trailing = { StatusBadge(stringResource(if (server.enabled) R.string.agent_on else R.string.agent_off), if (server.enabled) Tone.SUCCESS else null) },
                    )
                }
            }
        }
        "agent_memory" -> LoadView(rememberLoad(agent.id, profile) { api().agents.agentsListMemory(profile, agent.id).items }) { items ->
            LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (items.isEmpty()) item { Text(stringResource(R.string.agent_nothing), color = t.textMuted) }
                items(items, key = { it.id }) { item ->
                    Surface(color = t.surface, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text(item.title, style = MaterialTheme.typography.labelLarge)
                            item.content?.let { c -> InContentDirection(c) { Text(c, style = MaterialTheme.typography.bodySmall, color = t.textMuted, maxLines = 12) } }
                        }
                    }
                }
            }
        }
        "agent_jobs" -> LoadView(rememberLoad(agent.id, profile) { api().schedules.schedulesList(profile = profile, agentId = agent.id).items }) { jobs ->
            LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (jobs.isEmpty()) item { Text(stringResource(R.string.agent_nothing), color = t.textMuted) }
                items(jobs, key = { it.id }) { job ->
                    ListRow(job.name, listOfNotNull(job.trigger.display ?: job.trigger.expression, job.nextRunAt?.let(::localTime)).joinToString(" · "))
                }
            }
        }
        "agent_channels" -> LoadView(rememberLoad(agent.id, profile) { api().agents.agentsListChannels(profile, agent.id).items }) { channels ->
            LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (channels.isEmpty()) item { Text(stringResource(R.string.agent_nothing), color = t.textMuted) }
                items(channels, key = { it.platform }) { channel ->
                    ListRow(channel.label, channel.error, trailing = {
                        StatusBadge(
                            stringResource(
                                when (channel.status) {
                                    Channel.Status.ONLINE -> R.string.channel_online
                                    Channel.Status.OFFLINE -> R.string.channel_offline
                                    Channel.Status.ERROR -> R.string.agent_error
                                    else -> if (channel.enabled) R.string.agent_on else R.string.agent_off
                                },
                            ),
                            when (channel.status) { Channel.Status.ONLINE -> Tone.SUCCESS; Channel.Status.ERROR -> Tone.DANGER; else -> null },
                        )
                    })
                }
            }
        }
        "agent_plugins" -> LoadView(rememberLoad(agent.id, profile) { api().agents.agentsListPlugins(profile, agent.id).items }) { plugins ->
            LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (plugins.isEmpty()) item { Text(stringResource(R.string.agent_nothing), color = t.textMuted) }
                items(plugins, key = { it.key }) { plugin ->
                    ListRow(plugin.name, plugin.description, trailing = {
                        StatusBadge(stringResource(if (plugin.enabled) R.string.agent_on else R.string.agent_off), if (plugin.enabled) Tone.SUCCESS else null)
                    })
                }
            }
        }
        else -> LoadView(rememberLoad(agent.id, profile) { api().agents.agentsGetSettings(profile, agent.id).sections }) { sections ->
            LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                item { Text(stringResource(R.string.agent_settings_read_only), color = t.textMuted, style = MaterialTheme.typography.bodySmall) }
                sections.forEach { section ->
                    item(key = section.key) { Text(localized(section.title), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp)) }
                    items(section.fields, key = { section.key + "." + it.key }) { field ->
                        val value = when {
                            field.kind == hub.core.client.model.SettingsField.Kind.SECRET -> "••••"
                            field.value is JsonPrimitive -> (field.value as JsonPrimitive).contentOrNull ?: "—"
                            field.value == null -> "—"
                            else -> field.value.toString()
                        }
                        ListRow(localized(field.label), value)
                    }
                }
            }
        }
    }
}

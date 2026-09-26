package hub.core.android.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.AppLanguage
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.nav.AppPaths
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.InContentDirection
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.Custom
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubSwitch
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.ToggleRow
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Agent
import hub.core.client.model.AgentPresetWrite
import hub.core.client.model.AgentSettingsPatch
import hub.core.client.model.AgentsUpdatePluginRequest
import hub.core.client.model.Channel
import hub.core.client.model.ChannelCredentialField
import hub.core.client.model.ChannelPlatform
import hub.core.client.model.ChannelTokenLink
import hub.core.client.model.ConfigFile
import hub.core.client.model.ConfigFileWrite
import hub.core.client.model.LocalizedText
import hub.core.client.model.McpServerPatch
import hub.core.client.model.MemoryItem
import hub.core.client.model.MemoryItemWrite
import hub.core.client.model.Schedule
import hub.core.client.model.ScheduleWrite
import hub.core.client.model.SettingsField
import hub.core.client.model.SkillPatch
import java.math.BigDecimal
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * What an agent's pages change (B14), apart from the screens so it is tested against a scripted
 * hub. Every call carries the profile the pages edit (`X-Hub-Profile`), as on iOS and the web.
 */
class AgentOps(private val apis: () -> HubApis?, val profile: String, val agentId: String) {
    private suspend fun <T> call(block: suspend (HubApis) -> T): Result<T> {
        val api = apis() ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { block(api) }
    }

    suspend fun setSkill(key: String, on: Boolean) = call { it.agents.agentsUpdateSkill(profile, agentId, key, SkillPatch(enabled = on)) }
    suspend fun setMcp(name: String, on: Boolean) = call { it.agents.agentsUpdateMcpServer(profile, agentId, name, McpServerPatch(enabled = on)) }
    suspend fun testMcp(name: String) = call { it.agents.agentsTestMcpServer(profile, agentId, name) }
    suspend fun saveMemory(item: MemoryItem, content: String) =
        call { it.agents.agentsPutMemoryItem(profile, agentId, item.id, MemoryItemWrite(content = content, title = item.title, tags = item.tags, revision = item.revision)) }
    suspend fun runJob(job: Schedule) = call { it.schedules.schedulesRunNow(job.profile, job.id) }
    suspend fun pauseJob(job: Schedule, enabled: Boolean) = call { it.schedules.schedulesUpdate(job.profile, job.id, ScheduleWrite(enabled = enabled)) }
    suspend fun setPlugin(key: String, on: Boolean) = call { it.agents.agentsUpdatePlugin(profile, agentId, key, AgentsUpdatePluginRequest(enabled = on)) }
    suspend fun setSetting(section: String, key: String, value: JsonElement) =
        call { it.agents.agentsUpdateSettings(profile, agentId, AgentSettingsPatch(section, mapOf(key to value))) }

    suspend fun presets() = call { it.agents.agentsListPresets(profile, agentId).items }
    suspend fun savePreset(name: String) = call { it.agents.agentsCreatePreset(profile, agentId, AgentPresetWrite(name = name.trim())) }
    suspend fun deletePreset(id: String) = call { it.agents.agentsDeletePreset(profile, agentId, id) }
    suspend fun activatePreset(id: String) = call { it.agents.agentsActivatePreset(profile, agentId, id) }

    suspend fun configFiles() = call { it.agents.agentsListConfigFiles(profile, agentId).items }
    suspend fun configFile(key: String) = call { it.agents.agentsGetConfigFile(profile, agentId, key) }
    suspend fun saveConfigFile(file: ConfigFile, content: String) =
        call { it.agents.agentsPutConfigFile(profile, agentId, file.key, ConfigFileWrite(content = content, revision = file.revision)) }

    suspend fun link(platform: ChannelPlatform, typed: Map<String, String>, allowed: String) =
        call { it.agents.agentsLinkChannel(profile, agentId, platform.platform, ChannelLinks.request(platform, typed, allowed)) }
    suspend fun unlink(platform: String) = call { it.agents.agentsUnlinkChannel(profile, agentId, platform) }
    suspend fun approve(platform: String, requestId: String) = call { it.agents.agentsApprovePairing(profile, agentId, platform, requestId) }
    suspend fun deny(platform: String, requestId: String) = call { it.agents.agentsDenyPairing(profile, agentId, platform, requestId) }
    suspend fun revoke(platform: String, userId: String) = call { it.agents.agentsRevokePairing(profile, agentId, platform, userId) }
}

/** A settings field's value, shown and typed (the kinds the phone edits in place). */
object SettingValues {
    /** The kinds edited on the phone; `list` and `json` are read here and edited on the web. */
    fun editable(field: SettingsField): Boolean = field.kind !in setOf(SettingsField.Kind.LIST, SettingsField.Kind.JSON)

    fun text(value: JsonElement?): String? = when (value) {
        null, is JsonNull -> null
        is JsonPrimitive -> value.contentOrNull
        else -> value.toString()
    }

    /**
     * What a person typed as the field's value, or null when it is not one: a whole number for
     * `integer`, a number for `number` (a comma taken as the decimal point), within `min` and
     * `max`; text as typed. An empty entry puts the field back to its default (`JsonNull`).
     */
    fun parse(field: SettingsField, typed: String): JsonElement? {
        val t = typed.trim()
        if (t.isEmpty()) return JsonNull
        fun inRange(n: BigDecimal) = (field.min == null || n >= field.min) && (field.max == null || n <= field.max)
        return when (field.kind) {
            SettingsField.Kind.INTEGER -> t.toLongOrNull()?.takeIf { inRange(BigDecimal(it)) }?.let(::JsonPrimitive)
            SettingsField.Kind.NUMBER -> t.replace(',', '.').toBigDecimalOrNull()?.takeIf(::inRange)?.let { JsonPrimitive(it.toDouble()) }
            SettingsField.Kind.TOGGLE -> t.toBooleanStrictOrNull()?.let(::JsonPrimitive)
            SettingsField.Kind.CHOICE -> t.takeIf { v -> field.options.any { it.value == v } }?.let(::JsonPrimitive)
            else -> JsonPrimitive(typed)
        }
    }

    fun on(field: SettingsField): Boolean = ((field.value ?: field.default) as? JsonPrimitive)?.booleanOrNull ?: false
}

/** Which channels link from the phone, and what the link sends. */
object ChannelLinks {
    /** A bot token or credentials link here; a QR platform (WhatsApp) is scanned from another screen. */
    fun onPhone(platform: ChannelPlatform): Boolean = platform.login != ChannelPlatform.Login.QR

    /** The fields the phone asks for, in the platform's order; Telegram's one bot token. */
    fun fields(platform: ChannelPlatform): List<ChannelCredentialField> =
        if (platform.login == ChannelPlatform.Login.TOKEN && platform.credentials.isEmpty()) {
            listOf(ChannelCredentialField(key = "token", kind = ChannelCredentialField.Kind.SECRET, required = true))
        } else platform.credentials

    fun missing(platform: ChannelPlatform, typed: Map<String, String>): List<String> =
        fields(platform).filter { it.required && typed[it.key].isNullOrBlank() }.map { it.key }

    fun request(platform: ChannelPlatform, typed: Map<String, String>, allowed: String): ChannelTokenLink {
        val users = allowed.split(',', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }.takeIf { it.isNotEmpty() && platform.allowedUsersKey != null }
        return if (platform.login == ChannelPlatform.Login.TOKEN) {
            ChannelTokenLink(token = (typed["token"] ?: typed.values.firstOrNull { it.isNotBlank() }).orEmpty().trim(), allowedUsers = users)
        } else {
            ChannelTokenLink(credentials = typed.filterValues { it.isNotBlank() }.mapValues { it.value.trim() }, allowedUsers = users)
        }
    }

    /** A linked channel's account in one line: its name, then its handle or number. */
    fun account(channel: Channel): String? = channel.link?.takeIf { it.linked }?.let { l ->
        listOfNotNull(l.accountName, l.accountUsername?.let { "@$it" }, l.accountPhone).joinToString(" · ").ifEmpty { null }
    }
}

@Composable
private fun localized(text: LocalizedText?): String =
    text?.let { if (LocalContext.current.graph.prefs.effectiveLanguage == AppLanguage.AR) it.ar else it.en }.orEmpty()

@Composable
private fun rememberOps(agent: Agent, profile: String): AgentOps {
    val context = LocalContext.current
    return remember(agent.id, profile) { AgentOps({ context.graph.store.current?.let(context.graph::apis) }, profile, agent.id) }
}

private val pagePad = PaddingValues(horizontal = 16.dp, vertical = 8.dp)

/** A line after an action: words of ours in a tone, or the hub's own failure. */
private data class Note(val text: String? = null, val tone: BadgeTone = BadgeTone.Info, val error: HubError? = null)

@Composable
private fun NoteView(note: Note?, modifier: Modifier = Modifier) {
    when {
        note == null -> Unit
        note.error != null -> ErrorNotice(note.error, modifier)
        note.text != null -> NoticeBox(note.text, note.tone, modifier)
    }
}

/** An agent's page on the phone, editable as on iOS (B14). */
@Composable
fun AgentPageEditable(page: String, agent: Agent, profile: String) {
    when (page) {
        "agent_skills" -> SkillsPage(agent, profile)
        "agent_mcp" -> McpPage(agent, profile)
        "agent_memory" -> MemoryPage(agent, profile)
        "agent_jobs" -> JobsPage(agent, profile)
        "agent_channels" -> ChannelsPage(agent, profile)
        "agent_plugins" -> PluginsPage(agent, profile)
        "agent_config_files" -> ConfigFilesPage(agent, profile)
        else -> SettingsPage(agent, profile)
    }
}

@Composable
private fun SkillsPage(agent: Agent, profile: String) {
    val ops = rememberOps(agent, profile)
    val apis = api()
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<HubError?>(null) }
    val load = rememberLoad(agent.id, profile) { apis().agents.agentsListSkills(profile, agent.id).categories }
    LoadView(load) { categories ->
        LazyColumn(contentPadding = pagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.skills")) {
            item { ErrorNotice(error) }
            if (categories.all { it.skills.isEmpty() }) item { EmptyState(stringResource(R.string.agent_nothing), icon = Lucide.Sparkles) }
            categories.filter { it.skills.isNotEmpty() }.forEach { category ->
                item(key = "c" + category.key) {
                    GroupedList(title = category.name) {
                        category.skills.forEach { skill ->
                            Custom {
                                ToggleRow(
                                    skill.name, skill.enabled,
                                    { on -> scope.launch { ops.setSkill(skill.key, on).onFailure { error = it as HubError }.onSuccess { error = null }; load.reload() } },
                                    subtitle = skill.description, modifier = Modifier.testTag("skill.${skill.key}"),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun api(): () -> HubApis {
    val context = LocalContext.current
    return { context.graph.apis(context.graph.store.current!!) }
}

@Composable
private fun McpPage(agent: Agent, profile: String) {
    val ops = rememberOps(agent, profile)
    val apis = api()
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var error by remember { mutableStateOf<HubError?>(null) }
    val results = remember { mutableStateMapOf<String, Note>() }
    val testing = remember { mutableStateMapOf<String, Boolean>() }
    val load = rememberLoad(agent.id, profile) { apis().agents.agentsListMcpServers(profile, agent.id).items }
    val okText = stringResource(R.string.mcp_test_ok)
    LoadView(load) { servers ->
        LazyColumn(contentPadding = pagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.mcp")) {
            item { ErrorNotice(error) }
            if (servers.isEmpty()) item { EmptyState(stringResource(R.string.agent_nothing), icon = Lucide.Server) }
            items(servers, key = { it.name }) { server ->
                HubCard(Modifier.testTag("mcp.${server.name}"), padding = 14.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(server.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Badge(
                            stringResource(if (server.connected) R.string.mcp_connected else if (server.enabled) R.string.mcp_not_connected else R.string.agent_off),
                            tone = if (server.connected) BadgeTone.Success else BadgeTone.Neutral, dot = true,
                        )
                        HubSwitch(server.enabled, { on -> scope.launch { ops.setMcp(server.name, on).onFailure { error = it as HubError }.onSuccess { error = null }; load.reload() } }, Modifier.testTag("mcp.${server.name}.switch"))
                    }
                    Text(
                        listOf(server.transport.value, stringResource(R.string.agent_tools, server.tools.size)).joinToString(" · "),
                        fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                    )
                    server.error?.let { NoticeBox(it, BadgeTone.Danger) }
                    NoteView(results[server.name], Modifier.testTag("mcp.${server.name}.result"))
                    HubButton(
                        stringResource(R.string.mcp_test), {
                            testing[server.name] = true
                            scope.launch {
                                ops.testMcp(server.name)
                                    .onSuccess { r -> results[server.name] = Note(if (r.ok) okText.format(r.tools.size) else r.error ?: "—", if (r.ok) BadgeTone.Success else BadgeTone.Danger) }
                                    .onFailure { results[server.name] = Note(error = it as HubError) }
                                testing[server.name] = false
                            }
                        },
                        kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Activity, loading = testing[server.name] == true,
                        modifier = Modifier.testTag("mcp.${server.name}.test"),
                    )
                }
            }
        }
    }
}

@Composable
private fun MemoryPage(agent: Agent, profile: String) {
    val ops = rememberOps(agent, profile)
    val apis = api()
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var editing by remember { mutableStateOf<MemoryItem?>(null) }
    val load = rememberLoad(agent.id, profile) { apis().agents.agentsListMemory(profile, agent.id).items }
    LoadView(load) { items ->
        LazyColumn(contentPadding = pagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.memory")) {
            if (items.isEmpty()) item { EmptyState(stringResource(R.string.agent_nothing), icon = Lucide.Brain) }
            items(items, key = { it.id }) { item ->
                HubCard(Modifier.testTag("memory.${item.id}"), onClick = { editing = item }, padding = 12.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(item.title, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                        hub.core.android.ui.kit.LucideIcon(Lucide.Pencil, null, size = 14.dp, tint = t.textFaint)
                    }
                    item.content?.let { c -> InContentDirection(c) { Text(c, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, maxLines = 6) } }
                }
            }
        }
    }
    editing?.let { item ->
        var text by remember(item.id) { mutableStateOf(item.content.orEmpty()) }
        var saving by remember(item.id) { mutableStateOf(false) }
        var error by remember(item.id) { mutableStateOf<HubError?>(null) }
        HubSheet(onDismiss = { editing = null }, title = item.title) {
            ErrorNotice(error)
            HubTextField(text, { text = it }, singleLine = false, minLines = 8, maxLines = 16, fieldTag = "memory.editor", modifier = Modifier.fillMaxWidth().heightIn(min = 200.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HubButton(stringResource(R.string.save), {
                    saving = true
                    scope.launch {
                        ops.saveMemory(item, text).onSuccess { editing = null; load.reload() }.onFailure { error = it as HubError }
                        saving = false
                    }
                }, size = ControlSize.Md, icon = Lucide.Check, loading = saving, enabled = text != item.content.orEmpty(), modifier = Modifier.testTag("memory.save"))
                HubButton(stringResource(R.string.cancel), { editing = null }, kind = ButtonKind.Ghost, size = ControlSize.Md)
            }
        }
    }
}

@Composable
private fun JobsPage(agent: Agent, profile: String) {
    val ops = rememberOps(agent, profile)
    val apis = api()
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var notice by remember { mutableStateOf<Note?>(null) }
    val started = stringResource(R.string.schedules_started)
    val load = rememberLoad(agent.id, profile) { apis().schedules.schedulesList(profile = profile, agentId = agent.id).items }
    LoadView(load) { jobs ->
        LazyColumn(contentPadding = pagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.jobs")) {
            item { NoteView(notice) }
            if (jobs.isEmpty()) item { EmptyState(stringResource(R.string.agent_nothing), icon = Lucide.RotateCcwClock) }
            items(jobs, key = { it.id }) { job ->
                HubCard(Modifier.testTag("job.${job.id}"), padding = 14.dp) {
                    InContentDirection(job.name) { Text(job.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold) }
                    Text(
                        listOfNotNull(job.trigger.display ?: job.trigger.expression, job.nextRunAt?.let { stringResource(R.string.schedules_next, localTime(it)) }).joinToString(" · "),
                        fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                    )
                    job.lastError?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = t.danger, maxLines = 2) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HubButton(stringResource(R.string.schedules_run_now), {
                            scope.launch {
                                ops.runJob(job).onSuccess { notice = Note(started, BadgeTone.Success) }
                                    .onFailure { notice = Note(error = it as HubError) }
                                load.reload()
                            }
                        }, size = ControlSize.Sm, icon = Lucide.Play, modifier = Modifier.testTag("job.${job.id}.run"))
                        HubButton(
                            stringResource(if (job.enabled) R.string.schedules_pause else R.string.schedules_resume), {
                                scope.launch { ops.pauseJob(job, !job.enabled); load.reload() }
                            },
                            kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = if (job.enabled) Lucide.Pause else Lucide.Play,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PluginsPage(agent: Agent, profile: String) {
    val ops = rememberOps(agent, profile)
    val apis = api()
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<HubError?>(null) }
    val load = rememberLoad(agent.id, profile) { apis().agents.agentsListPlugins(profile, agent.id) }
    LoadView(load) { list ->
        LazyColumn(contentPadding = pagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.plugins")) {
            item { ErrorNotice(error) }
            items(list.warnings) { NoticeBox(it, BadgeTone.Warning) }
            if (list.items.isEmpty()) item { EmptyState(stringResource(R.string.agent_nothing), icon = Lucide.Puzzle) }
            else item {
                GroupedList {
                    list.items.forEach { plugin ->
                        Custom {
                            ToggleRow(
                                plugin.name, plugin.enabled,
                                { on -> scope.launch { ops.setPlugin(plugin.key, on).onFailure { error = it as HubError }.onSuccess { error = null }; load.reload() } },
                                subtitle = plugin.description ?: plugin.status.value.replace('_', ' '), enabled = plugin.manageable,
                                modifier = Modifier.testTag("plugin.${plugin.key}"),
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * The adapter's settings (ADR 0002), editable in place: switches, a choice from a menu, and text or
 * numbers in a small dialog; lists and JSON are edited on the web. Presets (§100) head the page.
 */
@Composable
private fun SettingsPage(agent: Agent, profile: String) {
    val ops = rememberOps(agent, profile)
    val apis = api()
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var error by remember { mutableStateOf<HubError?>(null) }
    var editing by remember { mutableStateOf<Pair<String, SettingsField>?>(null) }
    var choosing by remember { mutableStateOf<String?>(null) }
    val load = rememberLoad(agent.id, profile) { apis().agents.agentsGetSettings(profile, agent.id).sections }
    fun write(section: String, key: String, value: JsonElement) {
        scope.launch { ops.setSetting(section, key, value).onFailure { error = it as HubError }.onSuccess { error = null }; load.reload() }
    }
    LoadView(load) { sections ->
        LazyColumn(contentPadding = pagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.settings")) {
            item { PresetsCard(ops, onApplied = { load.reload() }) }
            item { ErrorNotice(error) }
            sections.forEach { section ->
                item(key = section.key) {
                    GroupedList(title = localized(section.title)) {
                        section.fields.forEach { field ->
                            val id = section.key + "." + field.key
                            when {
                                field.kind == SettingsField.Kind.TOGGLE -> Custom {
                                    ToggleRow(localized(field.label), SettingValues.on(field), { on -> write(section.key, field.key, JsonPrimitive(on)) },
                                        subtitle = field.help?.let { localized(it) }, modifier = Modifier.testTag("setting.$id"))
                                }
                                field.kind == SettingsField.Kind.CHOICE -> Custom {
                                    Box {
                                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                                            Text(localized(field.label), fontSize = FontTokens.sizeMd.sp, modifier = Modifier.weight(1f))
                                            val current = SettingValues.text(field.value ?: field.default)
                                            HubButton(
                                                field.options.firstOrNull { it.value == current }?.let { it.labels?.let { l -> localized(l) } ?: it.label } ?: current ?: "—",
                                                { choosing = id }, kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.ChevronsUpDown,
                                                modifier = Modifier.testTag("setting.$id"),
                                            )
                                        }
                                        HubMenu(choosing == id, { choosing = null }) {
                                            field.options.forEach { option ->
                                                MenuItem(option.labels?.let { localized(it) } ?: option.label, { choosing = null; write(section.key, field.key, JsonPrimitive(option.value)) }, checked = option.value == SettingValues.text(field.value))
                                            }
                                        }
                                    }
                                }
                                SettingValues.editable(field) -> Item(
                                    localized(field.label),
                                    value = if (field.kind == SettingsField.Kind.SECRET) (if (field.value != null && field.value !is JsonNull) "••••" else "—") else SettingValues.text(field.value) ?: SettingValues.text(field.default)?.let { "($it)" } ?: "—",
                                    subtitle = field.help?.let { localized(it) }, chevron = true, tag = "setting.$id",
                                    onClick = { editing = section.key to field },
                                )
                                else -> Item(localized(field.label), value = SettingValues.text(field.value) ?: "—", subtitle = stringResource(R.string.settings_edit_on_web))
                            }
                        }
                    }
                }
                section.note?.let { note -> item { Text(localized(note), fontSize = FontTokens.sizeXs.sp, color = t.textMuted) } }
            }
        }
    }
    editing?.let { (section, field) ->
        var typed by remember(field.key) { mutableStateOf(if (field.kind == SettingsField.Kind.SECRET) "" else SettingValues.text(field.value).orEmpty()) }
        val parsed = SettingValues.parse(field, typed)
        HubDialog({ editing = null }, localized(field.label)) {
            field.help?.let { Text(localized(it), fontSize = FontTokens.sizeSm.sp, color = t.textMuted) }
            HubTextField(
                typed, { typed = it }, placeholder = field.hint ?: SettingValues.text(field.default),
                keyboardOptions = KeyboardOptions(keyboardType = if (field.kind == SettingsField.Kind.INTEGER) KeyboardType.Number else if (field.kind == SettingsField.Kind.NUMBER) KeyboardType.Decimal else KeyboardType.Text),
                visualTransformation = if (field.kind == SettingsField.Kind.SECRET) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                error = if (parsed == null) stringResource(R.string.settings_value_bad) else null, fieldTag = "setting.editor",
            )
            Text(stringResource(R.string.settings_empty_is_default), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                HubButton(stringResource(R.string.cancel), { editing = null }, kind = ButtonKind.Secondary, size = ControlSize.Md)
                HubButton(stringResource(R.string.save), { parsed?.let { write(section, field.key, it) }; editing = null }, size = ControlSize.Md, enabled = parsed != null, modifier = Modifier.testTag("setting.save"))
            }
        }
    }
}

/** Presets (§100): saved bundles of this agent's settings in the profile; activate, save the current, delete. */
@Composable
private fun PresetsCard(ops: AgentOps, onApplied: () -> Unit) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val load = rememberLoad(ops.agentId, ops.profile) { ops.presets().getOrThrow() }
    var naming by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<Note?>(null) }
    var deleting by remember { mutableStateOf<hub.core.client.model.AgentPreset?>(null) }
    val appliedText = stringResource(R.string.presets_applied)
    val skippedText = stringResource(R.string.presets_skipped)
    GroupedList(title = stringResource(R.string.presets_title)) {
        Custom {
            NoteView(notice)
            LoadView(load) { presets ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (presets.isEmpty()) Text(stringResource(R.string.presets_none), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                    presets.forEach { preset ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("preset.${preset.id}")) {
                            Column(Modifier.weight(1f)) {
                                InContentDirection(preset.name) { Text(preset.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.Medium) }
                                preset.lastActivatedAt?.let { Text(stringResource(R.string.presets_last, localTime(it)), fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
                            }
                            HubButton(stringResource(R.string.presets_activate), {
                                scope.launch {
                                    ops.activatePreset(preset.id)
                                        .onSuccess { a -> notice = Note(if (a.skipped.isEmpty()) appliedText else skippedText.format(a.skipped.size), if (a.skipped.isEmpty()) BadgeTone.Success else BadgeTone.Warning); onApplied(); load.reload() }
                                        .onFailure { notice = Note(error = it as HubError) }
                                }
                            }, kind = ButtonKind.Subtle, size = ControlSize.Sm, modifier = Modifier.testTag("preset.${preset.id}.activate"))
                            HubIconButton(Lucide.Trash, stringResource(R.string.presets_delete), { deleting = preset }, size = 32.dp, iconSize = 16.dp)
                        }
                    }
                }
            }
            HubButton(stringResource(R.string.presets_save_current), { naming = true }, kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.Plus, modifier = Modifier.testTag("preset.new"))
        }
    }
    if (naming) {
        var name by remember { mutableStateOf("") }
        HubDialog({ naming = false }, stringResource(R.string.presets_save_current)) {
            HubTextField(name, { name = it }, placeholder = stringResource(R.string.presets_name), fieldTag = "preset.name")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                HubButton(stringResource(R.string.cancel), { naming = false }, kind = ButtonKind.Secondary, size = ControlSize.Md)
                HubButton(stringResource(R.string.save), {
                    scope.launch {
                        ops.savePreset(name).onSuccess { load.reload() }.onFailure { notice = Note(error = it as HubError) }
                    }
                    naming = false
                }, size = ControlSize.Md, enabled = name.isNotBlank(), modifier = Modifier.testTag("preset.save"))
            }
        }
    }
    deleting?.let { preset ->
        ConfirmDialog(
            stringResource(R.string.presets_delete_confirm, preset.name), null, stringResource(R.string.presets_delete),
            onConfirm = { scope.launch { ops.deletePreset(preset.id); load.reload() }; deleting = null }, onDismiss = { deleting = null }, danger = true,
        )
    }
}

/**
 * A coding agent's own config files (§78), one set for the hub: a file at a time in a plain
 * editor — Markdown in the reading font with its own direction, JSON and TOML left to right in
 * monospace — saved with its revision so a change made elsewhere is not overwritten.
 */
@Composable
private fun ConfigFilesPage(agent: Agent, profile: String) {
    val ops = rememberOps(agent, profile)
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val list = rememberLoad(agent.id, profile) { ops.configFiles().getOrThrow() }
    var chosen by remember { mutableStateOf<String?>(null) }
    LoadView(list) { files ->
        if (files.isEmpty()) {
            EmptyState(stringResource(R.string.agent_nothing), icon = Lucide.FileCog)
            return@LoadView
        }
        val key = chosen ?: files.first().key
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("agent.config_files"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (files.size > 1) {
                Segmented(files.map { Segment(it.key, localized(it.label), tag = "config.tab.${it.key}") }, key, { chosen = it }, Modifier.fillMaxWidth())
            }
            val file = rememberLoad(agent.id, key) { ops.configFile(key).getOrThrow() }
            LoadView(file) { f ->
                var text by remember(f.key, f.revision) { mutableStateOf(f.content.orEmpty()) }
                var error by remember(f.key) { mutableStateOf<HubError?>(null) }
                var saved by remember(f.key) { mutableStateOf(false) }
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(f.path, fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    NoticeBox(stringResource(R.string.config_shared), BadgeTone.Info)
                    if (!f.exists) Text(stringResource(R.string.config_new_file), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    error?.let { e ->
                        NoticeBox(
                            if (e.status == 409 && e.code == "changed") stringResource(R.string.config_changed) else hub.core.android.ui.components.errorText(e), BadgeTone.Danger,
                        ) {
                            if (e.status == 409) HubButton(stringResource(R.string.config_reload), { file.reload() }, kind = ButtonKind.Secondary, size = ControlSize.Sm)
                        }
                    }
                    if (saved) NoticeBox(stringResource(R.string.config_saved), BadgeTone.Success)
                    HubTextField(
                        text, { text = it; saved = false }, singleLine = false, minLines = 12, maxLines = 40,
                        mono = f.language != ConfigFile.Language.MARKDOWN, size = ControlSize.Md, fieldTag = "config.editor",
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HubButton(stringResource(R.string.save), {
                            scope.launch {
                                ops.saveConfigFile(f, text).onSuccess { error = null; saved = true; file.reload() }.onFailure { error = it as HubError }
                            }
                        }, size = ControlSize.Md, icon = Lucide.Check, enabled = text != f.content.orEmpty(), modifier = Modifier.testTag("config.save"))
                        HubButton(stringResource(R.string.config_revert), { text = f.content.orEmpty() }, kind = ButtonKind.Ghost, size = ControlSize.Md, enabled = text != f.content.orEmpty())
                    }
                }
            }
        }
    }
}

/**
 * Channels: the linked platforms (with Unlink), senders waiting for approval and the approved
 * ones, and linking a platform that signs in with a bot token or credentials. A platform linked by
 * scanning a code (WhatsApp) cannot be scanned from the phone's own screen: the page says so and
 * opens the web on another screen.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChannelsPage(agent: Agent, profile: String) {
    val context = LocalContext.current
    val ops = rememberOps(agent, profile)
    val apis = api()
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var error by remember { mutableStateOf<HubError?>(null) }
    var linking by remember { mutableStateOf(false) }
    var unlinking by remember { mutableStateOf<Channel?>(null) }
    val channels = rememberLoad(agent.id, profile) { apis().agents.agentsListChannels(profile, agent.id).items }
    val pairing = rememberLoad(agent.id, profile, "pairing") { apis().agents.agentsListPairing(profile, agent.id) }
    fun after(result: Result<*>) {
        result.onFailure { error = it as HubError }.onSuccess { error = null }
        channels.reload(); pairing.reload()
    }
    LazyColumn(contentPadding = pagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.channels")) {
        item { ErrorNotice(error) }
        item {
            LoadView(channels) { list ->
                val linked = list.filter { it.configured || it.link?.linked == true }
                GroupedList(title = stringResource(R.string.channels_linked)) {
                    if (linked.isEmpty()) Custom { Text(stringResource(R.string.channels_none), fontSize = FontTokens.sizeSm.sp, color = t.textMuted) }
                    linked.forEach { channel ->
                        Item(
                            channel.label, subtitle = listOfNotNull(ChannelLinks.account(channel), channel.error).joinToString(" · ").ifEmpty { null },
                            icon = Lucide.Radio, tag = "channel.${channel.platform}",
                            trailing = {
                                Badge(
                                    stringResource(
                                        when (channel.status) {
                                            Channel.Status.ONLINE -> R.string.channel_online
                                            Channel.Status.OFFLINE -> R.string.channel_offline
                                            Channel.Status.ERROR -> R.string.agent_error
                                            else -> if (channel.enabled) R.string.agent_on else R.string.agent_off
                                        },
                                    ),
                                    tone = when (channel.status) { Channel.Status.ONLINE -> BadgeTone.Success; Channel.Status.ERROR -> BadgeTone.Danger; else -> BadgeTone.Neutral },
                                    dot = true,
                                )
                                HubIconButton(Lucide.X, stringResource(R.string.channels_unlink), { unlinking = channel }, size = 32.dp, iconSize = 16.dp, modifier = Modifier.testTag("channel.${channel.platform}.unlink"))
                            },
                        )
                    }
                }
            }
        }
        item {
            HubButton(stringResource(R.string.channels_link), { linking = true }, kind = ButtonKind.Subtle, size = ControlSize.Md, icon = Lucide.Link, modifier = Modifier.testTag("channels.link"))
        }
        item {
            LoadView(pairing) { p ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    GroupedList(title = stringResource(R.string.channels_waiting)) {
                        if (p.pending.isEmpty()) Custom { Text(stringResource(R.string.channels_nobody_waiting), fontSize = FontTokens.sizeSm.sp, color = t.textMuted) }
                        p.pending.forEach { r ->
                            Custom(Modifier.testTag("pairing.${r.requestId}")) {
                                Text(r.userName ?: r.userId, fontSize = FontTokens.sizeMd.sp)
                                Text("${r.platform} · ${localTime(r.requestedAt)}", fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    HubButton(stringResource(R.string.workflows_approve), { scope.launch { after(ops.approve(r.platform, r.requestId)) } }, size = ControlSize.Sm, icon = Lucide.Check, modifier = Modifier.testTag("pairing.${r.requestId}.approve"))
                                    HubButton(stringResource(R.string.workflows_deny), { scope.launch { after(ops.deny(r.platform, r.requestId)) } }, kind = ButtonKind.Danger, size = ControlSize.Sm, icon = Lucide.X)
                                }
                            }
                        }
                    }
                    if (p.approved.isNotEmpty()) GroupedList(title = stringResource(R.string.channels_approved)) {
                        p.approved.forEach { a ->
                            Item(
                                a.userName ?: a.userId, subtitle = a.platform, tag = "approved.${a.userId}",
                                trailing = { HubButton(stringResource(R.string.channels_revoke), { scope.launch { after(ops.revoke(a.platform, a.userId)) } }, kind = ButtonKind.Ghost, size = ControlSize.Sm) },
                            )
                        }
                    }
                }
            }
        }
    }
    if (linking) LinkSheet(ops, onDone = { linking = false; channels.reload() }, onWeb = {
        context.graph.store.current?.hub?.let { hub -> AppPaths.webUrl(hub, "agent_channels")?.replace(":agentId", agent.id) }
            ?.let { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) }
    })
    unlinking?.let { channel ->
        ConfirmDialog(
            stringResource(R.string.channels_unlink_confirm, channel.label), null, stringResource(R.string.channels_unlink),
            onConfirm = { scope.launch { after(ops.unlink(channel.platform)) }; unlinking = null }, onDismiss = { unlinking = null }, danger = true,
        )
    }
}

@Composable
private fun LinkSheet(ops: AgentOps, onDone: () -> Unit, onWeb: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val platforms = rememberLoad(ops.agentId, ops.profile, "platforms") {
        context.graph.apis(context.graph.store.current!!).agents.agentsListChannelPlatforms(ops.profile, ops.agentId).items
    }
    var chosen by remember { mutableStateOf<ChannelPlatform?>(null) }
    HubSheet(onDismiss = onDone, title = stringResource(R.string.channels_link)) {
        val p = chosen
        if (p == null) {
            LoadView(platforms) { list ->
                GroupedList {
                    list.forEach { platform ->
                        Item(
                            platform.label, icon = if (ChannelLinks.onPhone(platform)) Lucide.Link else Lucide.QrCode, chevron = true,
                            subtitle = if (ChannelLinks.onPhone(platform)) null else stringResource(R.string.channels_qr_short),
                            tag = "platform.${platform.platform}", onClick = { chosen = platform },
                        )
                    }
                }
            }
        } else if (!ChannelLinks.onPhone(p)) {
            // A code shown on this screen cannot be scanned by this phone's own camera.
            NoticeBox(stringResource(R.string.channels_qr_body, p.label), BadgeTone.Info)
            HubButton(stringResource(R.string.on_the_web_open), onWeb, icon = Lucide.ExternalLink, fill = true, modifier = Modifier.fillMaxWidth().testTag("platform.web"))
            HubButton(stringResource(R.string.back), { chosen = null }, kind = ButtonKind.Ghost, size = ControlSize.Md, icon = Lucide.ArrowLeft)
        } else {
            val typed = remember(p.platform) { mutableStateMapOf<String, String>() }
            var allowed by remember(p.platform) { mutableStateOf("") }
            var busy by remember(p.platform) { mutableStateOf(false) }
            var error by remember(p.platform) { mutableStateOf<HubError?>(null) }
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(p.label, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold)
                ErrorNotice(error)
                ChannelLinks.fields(p).forEach { field ->
                    HubTextField(
                        typed[field.key].orEmpty(), { typed[field.key] = it },
                        label = if (field.key == "token") stringResource(R.string.channels_bot_token) else field.key + if (field.required) " *" else "",
                        mono = true, size = ControlSize.Md,
                        visualTransformation = if (field.kind == ChannelCredentialField.Kind.SECRET) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                        fieldTag = "link.${field.key}",
                    )
                }
                if (p.allowedUsersKey != null) {
                    HubTextField(allowed, { allowed = it }, label = stringResource(R.string.channels_allowed), placeholder = stringResource(R.string.channels_allowed_hint), size = ControlSize.Md, fieldTag = "link.allowed")
                }
                if (p.pairs) Text(stringResource(R.string.channels_pairs_note), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HubButton(stringResource(R.string.channels_link_do), {
                        busy = true
                        scope.launch {
                            ops.link(p, typed.toMap(), allowed).onSuccess { onDone() }.onFailure { error = it as HubError }
                            busy = false
                        }
                    }, size = ControlSize.Md, icon = Lucide.Link, loading = busy, enabled = ChannelLinks.missing(p, typed).isEmpty(), modifier = Modifier.testTag("link.submit"))
                    HubButton(stringResource(R.string.back), { chosen = null }, kind = ButtonKind.Ghost, size = ControlSize.Md)
                }
                p.docsUrl?.let { url ->
                    HubButton(stringResource(R.string.channels_docs), { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }, kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.ExternalLink)
                }
            }
        }
    }
}

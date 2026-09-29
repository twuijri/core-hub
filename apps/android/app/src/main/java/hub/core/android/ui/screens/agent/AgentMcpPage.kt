package hub.core.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.ConfirmDeleteDialog
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.rememberConfirmDelete
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubSwitch
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Agent
import hub.core.client.model.McpServer
import hub.core.client.model.McpLastTest
import hub.core.client.model.McpServerPatch
import hub.core.client.model.McpTestResult
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/*
 * An agent's MCP servers (apps batch 9, the web's page): the hub's own tools card, then every server
 * with its switch, what it runs or where it points, Test (Hermes connects once and lists its tools),
 * Edit and Delete (after asking), and New server. A server is edited as a form — a command with its
 * arguments and variables, or an address with its headers — or as its JSON for anything else; keys
 * the form does not show are kept, and a stored credential stays unless it is typed again.
 */

/** What a test said: Hermes's tools, or why it could not connect; or the hub's refusal. */
internal data class McpTest(val result: McpTestResult? = null, val error: HubError? = null)

@Composable
private fun McpPage(agent: Agent, profile: String) {
    val ops = rememberAgentsTwoOps(agent, profile)
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<HubError?>(null) }
    var editing by remember { mutableStateOf<McpServer?>(null) }
    var creating by remember { mutableStateOf(false) }
    val tests = remember { mutableStateMapOf<String, McpTest>() }
    val testing = remember { mutableStateMapOf<String, Boolean>() }
    val deleting = rememberConfirmDelete<McpServer>()
    var hubServer by remember { mutableStateOf<String?>(null) }
    val load = rememberLoad(agent.id, profile) { ops.servers().getOrThrow() }
    LazyColumn(contentPadding = agentPagePad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("agent.mcp")) {
        item { NoticeBox(stringResource(R.string.agents2_mcp_restart_note), BadgeTone.Info) }
        item { HubToolsCard(ops, onServer = { hubServer = it }) }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                HubButton(stringResource(R.string.agents2_mcp_new), { creating = true }, size = ControlSize.Sm, icon = Lucide.Plus, modifier = Modifier.testTag("mcp.new"))
            }
        }
        item { ToolErrorNotice(error) }
        item {
            LoadView(load) { all ->
                val servers = McpRules.listed(all, hubServer)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (servers.isEmpty()) EmptyState(stringResource(R.string.agents2_mcp_none), body = stringResource(R.string.agents2_mcp_none_body), icon = Lucide.Server)
                    servers.forEach { server ->
                        McpServerRow(
                            server, tests[server.name], testing[server.name] == true,
                            onSwitch = { on -> scope.launch { ops.switchServer(server.name, on).onFailure { error = it as HubError }.onSuccess { error = null }; load.reload() } },
                            onEdit = { editing = server },
                            onTest = {
                                testing[server.name] = true
                                scope.launch {
                                    ops.testServer(server.name).onSuccess { tests[server.name] = McpTest(result = it) }.onFailure { tests[server.name] = McpTest(error = it as HubError) }
                                    testing[server.name] = false
                                    // The hub keeps the answer as the server's last test (§134): read it back.
                                    load.reload()
                                }
                            },
                            onDelete = { deleting.ask(server) },
                            oauth = { open -> McpOAuthRow(ops, server, onChanged = { load.reload() }, expanded = open) },
                        )
                    }
                }
            }
        }
    }
    if (creating) McpEditorSheet(null, onDismiss = { creating = false }) { name, config, _ -> ops.createServer(name, config).onSuccess { load.reload() } }
    editing?.let { server ->
        McpEditorSheet(server, onDismiss = { editing = null }) { _, config, transport -> ops.saveServer(server.name, config, transport).onSuccess { load.reload() } }
    }
    ConfirmDeleteDialog(
        deleting, { stringResource(R.string.agents2_mcp_delete_title, it.name) }, { ops.deleteServer(it.name) },
        onDeleted = { tests.remove(it.name); load.reload() }, body = stringResource(R.string.agents2_mcp_delete_body),
    )
}

/**
 * One server (owner, 2026-09-28, as on the web): the header — chevron, name, transport, state and the
 * switch — opens and folds what is under it; it no longer opens the editor, which has its own Edit
 * button beside Test. Folded by default, open when the server needs the person or was just tested.
 */
@Composable
internal fun McpServerRow(
    server: McpServer,
    test: McpTest?,
    testing: Boolean,
    onSwitch: (Boolean) -> Unit,
    onEdit: () -> Unit,
    onTest: () -> Unit,
    onDelete: () -> Unit,
    /** The server's OAuth sign-in in this profile (DECISIONS §122), [McpOAuthRow]; told whether the row is open. */
    oauth: (@Composable (Boolean) -> Unit)? = null,
) {
    val t = LocalTokens.current
    var open by rememberSaveable(server.name) { mutableStateOf(McpOAuthRules.needsAttention(server) || test != null) }
    LaunchedEffect(testing) { if (testing) open = true }
    val toggle = { open = !open }
    val state = stringResource(if (open) R.string.agents2_mcp_row_open else R.string.agents2_mcp_row_folded)
    HubCard(Modifier.testTag("mcp.${server.name}"), padding = 14.dp) {
        Row(
            Modifier.fillMaxWidth()
                .clickable(role = Role.Button, onClick = toggle)
                .semantics {
                    stateDescription = state
                    if (open) collapse { toggle(); true } else expand { toggle(); true }
                }
                .testTag("mcp.${server.name}.header"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            LucideIcon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, null, size = 16.dp, tint = t.textMuted)
            Text(server.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f, fill = false))
            Badge(server.transport.value)
            McpToolCount(server)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) {
                Badge(
                    stringResource(if (server.connected) R.string.mcp_connected else if (server.enabled) R.string.mcp_not_connected else R.string.agents2_mcp_off),
                    tone = if (server.connected) BadgeTone.Success else BadgeTone.Neutral, dot = true,
                )
            }
            HubSwitch(server.enabled, onSwitch, Modifier.testTag("mcp.${server.name}.switch"))
        }
        val summary = McpRules.summary(server)
        if (summary.isNotEmpty()) {
            Text(summary, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, fontFamily = FontFamily.Monospace, maxLines = if (open) 6 else 1, overflow = TextOverflow.Ellipsis)
        }
        if (open) {
            val last = server.lastTest
            if (last != null) McpLastTestView(server, last)
            else Text(stringResource(R.string.agent_tools, server.tools.size), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            server.error?.let { NoticeBox(it, BadgeTone.Danger) }
            // The kept test above says what this one said; a refusal by the hub is still shown here.
            if (last == null || test?.error != null) McpTestView(server.name, test)
        }
        oauth?.invoke(open)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HubButton(
                stringResource(if (testing) R.string.agents2_mcp_testing else R.string.mcp_test), onTest,
                kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Activity, loading = testing, modifier = Modifier.testTag("mcp.${server.name}.test"),
            )
            HubButton(
                stringResource(R.string.agents2_mcp_edit), onEdit,
                kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Pencil, modifier = Modifier.testTag("mcp.${server.name}.edit"),
            )
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) {
                HubIconButton(
                    Lucide.Trash, stringResource(R.string.kit_delete), onDelete,
                    size = 32.dp, iconSize = 16.dp, tint = t.danger, modifier = Modifier.testTag("mcp.${server.name}.delete"),
                )
            }
        }
    }
}

/** "61 tools", "12 of 61 tools", or that the last test failed — from the test the hub kept (§134). */
@Composable
private fun McpToolCount(server: McpServer) {
    val last = server.lastTest ?: return
    if (!last.ok) {
        Badge(stringResource(R.string.agents2_mcp_test_failed_short), Modifier.testTag("mcp.${server.name}.count"), tone = BadgeTone.Danger)
        return
    }
    val count = McpRules.toolCount(last.tools.map { it.name }, server.toolFilter?.include, server.toolFilter?.exclude)
    val text = if (count.filtered) {
        stringResource(R.string.agents2_mcp_tool_count_filtered, count.allowed.toString(), count.total.toString())
    } else {
        stringResource(R.string.agents2_mcp_tool_count, count.total.toString())
    }
    Badge(text, Modifier.testTag("mcp.${server.name}.count"), tone = if (last.stale) BadgeTone.Warning else BadgeTone.Neutral)
}

/**
 * The last test the hub kept for a server in this profile (DECISIONS §134): its tools without testing
 * again, each with how the hub reads it and whether the agent may use it. Choosing them is on the web.
 */
@Composable
private fun McpLastTestView(server: McpServer, last: McpLastTest) {
    val t = LocalTokens.current
    Column(Modifier.testTag("mcp.${server.name}.last"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (last.stale) NoticeBox(stringResource(R.string.agents2_mcp_tools_stale), BadgeTone.Warning)
        if (!last.ok) {
            NoticeBox(stringResource(R.string.agents2_mcp_test_failed) + " " + (last.error ?: ""), BadgeTone.Danger)
            return@Column
        }
        NoticeBox(
            stringResource(R.string.agents2_mcp_test_ok, last.tools.size.toString(), McpRules.seconds(last.durationMs)) +
                if (last.tools.isEmpty()) " " + stringResource(R.string.agents2_mcp_no_tools) else "",
            BadgeTone.Success,
        )
        last.tools.forEach { tool ->
            val on = McpRules.allowed(tool.name, server.toolFilter?.include, server.toolFilter?.exclude)
            val access = tool.access.value
            Column(Modifier.testTag("mcp.${server.name}.tool.${tool.name}")) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(tool.name, fontSize = FontTokens.sizeXs.sp, fontFamily = FontFamily.Monospace, color = if (on) t.text else t.textMuted)
                    Badge(
                        stringResource(
                            when (access) {
                                "read" -> R.string.agents2_mcp_access_read
                                "write" -> R.string.agents2_mcp_access_write
                                else -> R.string.agents2_mcp_access_unknown
                            },
                        ),
                        tone = when (access) {
                            "read" -> BadgeTone.Success
                            "write" -> BadgeTone.Warning
                            else -> BadgeTone.Neutral
                        },
                    )
                    if (!on) Badge(stringResource(R.string.agents2_mcp_tool_off))
                }
                tool.description?.takeIf { it.isNotEmpty() }?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
            }
        }
        if (last.tools.isNotEmpty()) Text(stringResource(R.string.agents2_mcp_tools_pick_on_web), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    }
}

/** Hermes's answer to a test: the tools it listed (with how long it took), or why it could not connect. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun McpTestView(name: String, test: McpTest?) {
    val result = test?.result
    when {
        test == null -> Unit
        test.error != null -> ToolErrorNotice(test.error, Modifier.testTag("mcp.$name.result"))
        result != null && !result.ok -> NoticeBox(stringResource(R.string.agents2_mcp_test_failed) + " " + (result.error ?: ""), BadgeTone.Danger, Modifier.testTag("mcp.$name.result"))
        result != null -> Column(Modifier.testTag("mcp.$name.result"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            NoticeBox(
                stringResource(R.string.agents2_mcp_test_ok, result.tools.size.toString(), McpRules.seconds(result.durationMs)) +
                    if (result.tools.isEmpty()) " " + stringResource(R.string.agents2_mcp_no_tools) else "",
                BadgeTone.Success,
            )
            if (result.tools.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                result.tools.forEach { Badge(it.name) }
            }
        }
    }
}

/**
 * New server or Edit: the name (new only), then a form for a command or an address, or the server's
 * JSON. Save sends the config; a refusal stays in the sheet in the hub's words.
 */
@Composable
internal fun McpEditorSheet(
    server: McpServer?,
    onDismiss: () -> Unit,
    onSave: suspend (name: String, config: Map<String, JsonElement>, transport: McpServerPatch.Transport?) -> Result<*>,
) {
    HubSheet(onDismiss = onDismiss, title = server?.name ?: stringResource(R.string.agents2_mcp_new)) {
        McpEditorBody(server, onDismiss, onSave)
    }
}

@Composable
internal fun McpEditorBody(
    server: McpServer?,
    onDismiss: () -> Unit,
    onSave: suspend (name: String, config: Map<String, JsonElement>, transport: McpServerPatch.Transport?) -> Result<*>,
) {
    val t = LocalTokens.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(server?.name.orEmpty()) }
    var draft by remember { mutableStateOf(server?.let { McpRules.draftOf(it.config) } ?: McpRules.TEMPLATE) }
    var json by remember { mutableStateOf<String?>(null) }
    var tried by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<HubError?>(null) }
    val parsed = json?.let { McpRules.parse(it) }
    val config = if (json != null) parsed else McpRules.configOf(draft)
    val problem = if (json == null) McpRules.problem(draft) else null
    val badName = name.isNotEmpty() && !McpRules.validName(name)
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.agents2_mcp_editor_note), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        ErrorNotice(failure)
        if (server == null) {
            HubTextField(
                name, { name = it }, label = stringResource(R.string.agents2_mcp_name), placeholder = "filesystem", mono = true, size = ControlSize.Md,
                error = if (badName) stringResource(R.string.agents2_mcp_name_bad) else null, fieldTag = "mcp.editor.name",
            )
        }
        if (json == null) {
            Text(stringResource(R.string.agents2_mcp_kind), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            Segmented(
                listOf(Segment(McpRules.Kind.COMMAND, stringResource(R.string.agents2_mcp_kind_command)), Segment(McpRules.Kind.URL, stringResource(R.string.agents2_mcp_kind_url))),
                draft.kind, { draft = draft.copy(kind = it) }, modifier = Modifier.fillMaxWidth().testTag("mcp.editor.kind"),
            )
            if (draft.kind == McpRules.Kind.COMMAND) {
                HubTextField(
                    draft.command, { draft = draft.copy(command = it) }, label = stringResource(R.string.agents2_mcp_command), mono = true, size = ControlSize.Md,
                    error = if (tried && problem == McpRules.Problem.COMMAND_REQUIRED) stringResource(R.string.agents2_mcp_command_required) else null, fieldTag = "mcp.editor.command",
                )
                Text(stringResource(R.string.agents2_mcp_command_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                HubTextField(
                    draft.args, { draft = draft.copy(args = it) }, label = stringResource(R.string.agents2_mcp_args), mono = true, size = ControlSize.Md,
                    singleLine = false, minLines = 3, maxLines = 10, fieldTag = "mcp.editor.args",
                )
                Text(stringResource(R.string.agents2_mcp_args_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                KeyValueRows(stringResource(R.string.agents2_mcp_env), draft.env, { draft = draft.copy(env = it) }, "mcp.editor.env")
            } else {
                HubTextField(
                    draft.url, { draft = draft.copy(url = it) }, label = stringResource(R.string.agents2_mcp_url), placeholder = "https://", mono = true, size = ControlSize.Md,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    error = if (tried && problem == McpRules.Problem.URL_BAD) stringResource(R.string.agents2_mcp_url_bad) else null, fieldTag = "mcp.editor.url",
                )
                Text(stringResource(R.string.agents2_mcp_url_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                KeyValueRows(stringResource(R.string.agents2_mcp_headers), draft.headers, { draft = draft.copy(headers = it) }, "mcp.editor.headers")
            }
            if (tried && problem == McpRules.Problem.ROW_BAD) NoticeBox(stringResource(R.string.agents2_mcp_row_bad), BadgeTone.Danger)
            if (draft.rest.isNotEmpty()) Text(stringResource(R.string.agents2_mcp_kept, draft.rest.keys.joinToString(", ")), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        } else {
            HubTextField(json.orEmpty(), { json = it }, mono = true, size = ControlSize.Md, singleLine = false, minLines = 10, maxLines = 24, fieldTag = "mcp.editor.json")
            if (parsed == null) NoticeBox(stringResource(R.string.agents2_mcp_invalid_json), BadgeTone.Warning)
        }
        HubButton(
            stringResource(if (json == null) R.string.agents2_mcp_as_json else R.string.agents2_mcp_as_form), {
                if (json == null) json = McpRules.jsonOf(McpRules.configOf(draft))
                else parsed?.let { draft = McpRules.draftOf(it); json = null }
            },
            kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.FileCog, enabled = json == null || parsed != null, modifier = Modifier.testTag("mcp.editor.mode"),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HubButton(stringResource(R.string.cancel), onDismiss, kind = ButtonKind.Secondary, size = ControlSize.Md)
            HubButton(
                stringResource(R.string.save), {
                    tried = true
                    if (config != null && problem == null && McpRules.validName(name)) {
                        saving = true
                        val transport = if (server == null) null else McpRules.transportChange(server, config)
                        scope.launch {
                            onSave(name.trim(), config, transport).onSuccess { failure = null; onDismiss() }.onFailure { failure = it as? HubError ?: HubError(-1, null, it.message) }
                            saving = false
                        }
                    }
                },
                size = ControlSize.Md, icon = Lucide.Check, loading = saving, enabled = name.isNotEmpty() && !badName && config != null,
                modifier = Modifier.testTag("mcp.editor.save"),
            )
        }
    }
}

/** Variables or headers: a name and a secret value per row (a stored one stays unless typed again), Add and Remove. */
@Composable
private fun KeyValueRows(title: String, rows: List<McpRules.Row>, onChange: (List<McpRules.Row>) -> Unit, tag: String) {
    val t = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        rows.forEachIndexed { index, row ->
            var shown by remember(index) { mutableStateOf(false) }
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                HubTextField(
                    row.key, { onChange(rows.toMutableList().apply { set(index, row.copy(key = it)) }) }, Modifier.weight(0.42f),
                    placeholder = stringResource(R.string.agents2_mcp_row_name), mono = true, size = ControlSize.Md, fieldTag = "$tag.$index.key",
                )
                HubTextField(
                    row.value, { onChange(rows.toMutableList().apply { set(index, row.copy(value = it)) }) }, Modifier.weight(0.58f),
                    placeholder = if (row.stored) stringResource(R.string.agents2_mcp_stored) else stringResource(R.string.agents2_mcp_row_value),
                    mono = true, size = ControlSize.Md, fieldTag = "$tag.$index.value",
                    visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    trailing = {
                        HubIconButton(if (shown) Lucide.EyeOff else Lucide.Eye, stringResource(if (shown) R.string.kit_hide_secret else R.string.kit_show_secret), { shown = !shown }, size = 28.dp, iconSize = 14.dp)
                    },
                )
                HubIconButton(Lucide.X, stringResource(R.string.agents2_mcp_row_remove), { onChange(rows.filterIndexed { i, _ -> i != index }) }, size = 36.dp, iconSize = 16.dp, modifier = Modifier.testTag("$tag.$index.remove"))
            }
        }
        HubButton(stringResource(R.string.agents2_mcp_row_add), { onChange(rows + McpRules.Row()) }, kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.Plus, modifier = Modifier.testTag("$tag.add"))
    }
}

internal val agentMcpPage = AgentPageEntry("agent_mcp") { agent, profile -> McpPage(agent, profile) }

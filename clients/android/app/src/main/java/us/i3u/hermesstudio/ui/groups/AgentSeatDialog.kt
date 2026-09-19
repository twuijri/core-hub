package us.i3u.hermesstudio.ui.groups

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import us.i3u.hermesstudio.AgentPreset
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.ConfirmDialog
import us.i3u.hermesstudio.LoadingRow
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.RoomAgentDraft
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.ui.sessions.AgentAvatar
import us.i3u.hermesstudio.ui.sessions.ChatAgentAvatars
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles

/** The agent families a seat can run (the web's `RoomAgentInput.agent`). */
private val AGENT_FAMILIES = listOf("hermes", "ekko", "claude", "codex", "pi", "grok", "opencode", "dsh")
private val GLOBAL_MODE_AGENTS = setOf("codex", "claude", "pi", "grok", "opencode", "dsh")
private val REASONING_EFFORTS = listOf("", "low", "medium", "high", "xhigh", "max")

/**
 * One agent seat (or preset): family, profile, mode, provider/model, reasoning
 * effort, display name and description — the fields the web's agent form
 * edits, with "apply a preset" on top.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AgentSeatDialog(
    state: UiState,
    initial: RoomAgentDraft?,
    presets: List<AgentPreset>,
    title: String,
    onSave: (RoomAgentDraft) -> Unit,
    onDismiss: () -> Unit,
    forPreset: Boolean = false,
) {
    val palette = CoreHub.palette
    val defaultProfile = state.activeProfile.ifBlank { state.profiles.firstOrNull()?.name ?: "default" }
    var draft by remember { mutableStateOf(initial ?: RoomAgentDraft(profile = defaultProfile)) }
    var profileMenu by remember { mutableStateOf(false) }
    var presetMenu by remember { mutableStateOf(false) }
    val available = presets.filter { it.available }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!forPreset && available.isNotEmpty()) {
                    Box {
                        OutlinedButton(onClick = { presetMenu = true }, modifier = Modifier.fillMaxWidth()) {
                            Text(draft.presetId?.let { id -> available.firstOrNull { it.id == id }?.name } ?: stringResource(R.string.preset_apply))
                        }
                        DropdownMenu(expanded = presetMenu, onDismissRequest = { presetMenu = false }) {
                            available.forEach { preset ->
                                DropdownMenuItem(
                                    text = { Text(preset.name) },
                                    leadingIcon = { AgentAvatar(ChatAgentAvatars.forRuntime(preset.agent)) },
                                    onClick = { draft = preset.toDraft(); presetMenu = false },
                                )
                            }
                        }
                    }
                }
                Text(stringResource(R.string.room_agent_family), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    AGENT_FAMILIES.forEach { family ->
                        val avatar = ChatAgentAvatars.forRuntime(family)
                        FilterChip(
                            selected = draft.agent == family,
                            onClick = { draft = draft.copy(agent = family, agentMode = if (family in GLOBAL_MODE_AGENTS) draft.agentMode else "scoped", presetId = null) },
                            label = { Text(avatar.label) },
                            leadingIcon = { AgentAvatar(avatar) },
                        )
                    }
                }
                if (draft.agent in GLOBAL_MODE_AGENTS) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(selected = draft.agentMode == "scoped", onClick = { draft = draft.copy(agentMode = "scoped") }, label = { Text(stringResource(R.string.room_agent_scoped)) })
                        FilterChip(selected = draft.agentMode == "global", onClick = { draft = draft.copy(agentMode = "global") }, label = { Text(stringResource(R.string.room_agent_global)) })
                    }
                }
                Box {
                    OutlinedButton(onClick = { profileMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.drawer_profile) + ": " + draft.profile, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DropdownMenu(expanded = profileMenu, onDismissRequest = { profileMenu = false }) {
                        state.profiles.forEach { profile ->
                            DropdownMenuItem(text = { Text(profile.name) }, onClick = { draft = draft.copy(profile = profile.name); profileMenu = false })
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = draft.provider, onValueChange = { draft = draft.copy(provider = it) },
                        label = { Text(stringResource(R.string.room_agent_provider)) }, singleLine = true,
                        textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Ltr), modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = draft.model, onValueChange = { draft = draft.copy(model = it) },
                        label = { Text(stringResource(R.string.sheet_model)) }, singleLine = true,
                        textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Ltr), modifier = Modifier.weight(1f),
                    )
                }
                Text(stringResource(R.string.composer_reasoning), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    REASONING_EFFORTS.forEach { effort ->
                        FilterChip(selected = draft.reasoningEffort == effort, onClick = { draft = draft.copy(reasoningEffort = effort) }, label = { Text(effort.ifBlank { stringResource(R.string.reasoning_default) }) })
                    }
                }
                OutlinedTextField(
                    value = draft.name, onValueChange = { draft = draft.copy(name = it) },
                    label = { Text(stringResource(R.string.room_agent_name)) }, singleLine = true,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content), modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = draft.description, onValueChange = { draft = draft.copy(description = it) },
                    label = { Text(stringResource(R.string.room_agent_description)) }, maxLines = 3,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content), modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(enabled = draft.profile.isNotBlank() && (!forPreset || draft.name.isNotBlank()), onClick = { onSave(draft) }) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

/** Manage agent presets: list, add, edit, delete (`/group-chat/agent-presets`). */
@Composable
fun PresetsDialog(state: UiState, viewModel: AppViewModel, onDismiss: () -> Unit) {
    val palette = CoreHub.palette
    var editing by remember { mutableStateOf<AgentPreset?>(null) }
    var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<AgentPreset?>(null) }
    LaunchedEffect(Unit) { viewModel.loadAgentPresets() }

    if (creating || editing != null) {
        AgentSeatDialog(
            state = state,
            initial = editing?.toDraft(),
            presets = emptyList(),
            title = stringResource(if (editing == null) R.string.preset_new else R.string.preset_edit),
            forPreset = true,
            onSave = { draft -> viewModel.saveAgentPreset(editing?.id, draft); creating = false; editing = null },
            onDismiss = { creating = false; editing = null },
        )
    }
    deleting?.let { preset ->
        ConfirmDialog(
            title = stringResource(R.string.preset_delete),
            body = preset.name,
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.deleteAgentPreset(preset); deleting = null },
            onDismiss = { deleting = null },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.presets_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (state.loadingPresets && state.agentPresets.isEmpty()) LoadingRow()
                if (!state.loadingPresets && state.agentPresets.isEmpty()) Text(stringResource(R.string.presets_empty), color = palette.textMuted)
                state.agentPresets.forEach { preset ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        AgentAvatar(ChatAgentAvatars.forRuntime(preset.agent))
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(preset.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOf(preset.profile, preset.model).filter { it.isNotBlank() }.joinToString(" · "),
                                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr),
                                color = if (preset.available) palette.textMuted else palette.error,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            if (!preset.available && preset.validationError.isNotBlank()) Text(preset.validationError, style = CoreHubTextStyles.meta, color = palette.error)
                        }
                        IconButton(onClick = { editing = preset }, modifier = Modifier.size(28.dp)) { Icon(CoreHubIcons.Settings, contentDescription = stringResource(R.string.action_edit), tint = palette.textSecondary, modifier = Modifier.size(16.dp)) }
                        IconButton(onClick = { deleting = preset }, modifier = Modifier.size(28.dp)) { Icon(CoreHubIcons.Close, contentDescription = stringResource(R.string.action_delete), tint = palette.textMuted, modifier = Modifier.size(14.dp)) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { creating = true }) { Text(stringResource(R.string.preset_new)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) } },
    )
}

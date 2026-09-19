package us.i3u.hermesstudio.ui.groups

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.ConfirmDialog
import us.i3u.hermesstudio.HandoffChain
import us.i3u.hermesstudio.QrCode
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.RoomAgent
import us.i3u.hermesstudio.RoomMember
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubIcons
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * Room settings, as the web's room drawer arranges them: name and workspace,
 * the agent seats (with presets), the human members, the invite link with its
 * QR, agent handoff, the running summary, and the destructive "clear context".
 * Everything the signed-in user may not manage is shown read-only.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun RoomSettingsSheet(state: UiState, viewModel: AppViewModel, onDismiss: () -> Unit) {
    val palette = CoreHub.palette
    val room = state.openRoom ?: return
    val info = room.room
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val clipboard = LocalClipboardManager.current

    var name by remember(info.id, info.name) { mutableStateOf(info.name) }
    var workspace by remember(info.id, info.workspace) { mutableStateOf(info.workspace) }
    var summaryDraft by remember(info.id, room.summary?.updatedAt) { mutableStateOf(room.summary?.summary.orEmpty()) }
    var handoffDepth by remember(info.id, info.agentHandoffMaxDepth) { mutableStateOf(info.agentHandoffMaxDepth?.toString().orEmpty()) }
    var addingSeat by remember { mutableStateOf(false) }
    var editingSeat by remember { mutableStateOf<RoomAgent?>(null) }
    var removingSeat by remember { mutableStateOf<RoomAgent?>(null) }
    var removingMember by remember { mutableStateOf<RoomMember?>(null) }
    var presets by remember { mutableStateOf(false) }
    var clearing by remember { mutableStateOf(false) }
    var showQr by remember { mutableStateOf(false) }

    LaunchedEffect(info.id) {
        viewModel.loadRoomSummary()
        if (state.agentPresets.isEmpty()) viewModel.loadAgentPresets()
    }

    if (addingSeat) {
        AgentSeatDialog(
            state = state,
            initial = null,
            presets = state.agentPresets,
            title = stringResource(R.string.room_add_agent),
            onSave = { draft -> viewModel.addRoomAgent(draft); addingSeat = false },
            onDismiss = { addingSeat = false },
        )
    }
    editingSeat?.let { seat ->
        AgentSeatDialog(
            state = state,
            initial = seat.toDraft(),
            presets = state.agentPresets,
            title = stringResource(R.string.room_edit_agent),
            onSave = { draft -> viewModel.updateRoomAgent(seat, draft); editingSeat = null },
            onDismiss = { editingSeat = null },
        )
    }
    removingSeat?.let { seat ->
        ConfirmDialog(
            title = stringResource(R.string.room_remove_agent),
            body = seat.name,
            action = stringResource(R.string.action_remove),
            onConfirm = { viewModel.removeRoomAgent(seat); removingSeat = null },
            onDismiss = { removingSeat = null },
        )
    }
    removingMember?.let { member ->
        ConfirmDialog(
            title = stringResource(R.string.room_remove_member),
            body = member.name,
            action = stringResource(R.string.action_remove),
            onConfirm = { viewModel.removeRoomMember(member); removingMember = null },
            onDismiss = { removingMember = null },
        )
    }
    if (presets) PresetsDialog(state, viewModel, onDismiss = { presets = false })
    if (clearing) {
        ConfirmDialog(
            title = stringResource(R.string.room_clear_context),
            body = stringResource(R.string.room_clear_context_body),
            action = stringResource(R.string.room_clear_context),
            onConfirm = { viewModel.clearRoomContext(); clearing = false },
            onDismiss = { clearing = false },
        )
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = palette.bgPrimary) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp)
                .imePadding()
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(stringResource(R.string.room_settings), style = CoreHubTextStyles.sessionTitle.copy(fontWeight = FontWeight.SemiBold), color = palette.textPrimary)

            // ── name and workspace ────────────────────────────────────────
            SectionLabel(R.string.room_name)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    enabled = info.canManage,
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { viewModel.renameRoom(name) }, enabled = info.canManage && name.isNotBlank() && name != info.name) {
                    Text(stringResource(R.string.action_save))
                }
            }
            SectionLabel(R.string.room_workspace)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = workspace,
                    onValueChange = { workspace = it },
                    singleLine = true,
                    enabled = info.canManage,
                    placeholder = { Text(stringResource(R.string.room_workspace_hint), color = palette.textMuted) },
                    textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Ltr),
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { viewModel.setRoomWorkspace(workspace) }, enabled = info.canManage && workspace != info.workspace) {
                    Text(stringResource(R.string.action_save))
                }
            }

            HorizontalDivider(color = palette.borderLight)

            // ── agent seats ───────────────────────────────────────────────
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.room_agents, room.agents.size), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary, modifier = Modifier.weight(1f))
                TextButton(onClick = { presets = true }) { Text(stringResource(R.string.presets_title)) }
            }
            room.agents.forEach { agent ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    RoomAgentAvatar(agent, size = CoreHubTokens.Metrics.agentAvatar, streaming = room.isBusy(agent.name))
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(agent.name, style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content), color = palette.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOf(agent.profile, agent.model, agent.agentMode).filter { it.isNotBlank() }.joinToString(" · "),
                            style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr),
                            color = if (agent.connectionStatus == "online") palette.textMuted else palette.error,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (info.canManage) {
                        IconButton(onClick = { editingSeat = agent }, modifier = Modifier.size(28.dp)) {
                            Icon(CoreHubIcons.Settings, contentDescription = stringResource(R.string.room_edit_agent), tint = palette.textSecondary, modifier = Modifier.size(16.dp))
                        }
                        IconButton(onClick = { removingSeat = agent }, modifier = Modifier.size(28.dp)) {
                            Icon(CoreHubIcons.Close, contentDescription = stringResource(R.string.room_remove_agent), tint = palette.textMuted, modifier = Modifier.size(14.dp))
                        }
                    }
                }
            }
            if (info.canManage) {
                OutlinedButton(onClick = { addingSeat = true }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.room_add_agent)) }
            }

            HorizontalDivider(color = palette.borderLight)

            // ── members ───────────────────────────────────────────────────
            Text(stringResource(R.string.room_members, room.members.size), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
            if (room.members.isEmpty()) Text(stringResource(R.string.room_members_empty), style = CoreHubTextStyles.meta, color = palette.textMuted)
            room.members.forEach { member ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).padding(1.dp)) {
                        Icon(
                            CoreHubIcons.Group,
                            contentDescription = null,
                            tint = if (member.online) palette.accent else palette.textMuted,
                            modifier = Modifier.size(6.dp),
                        )
                    }
                    Spacer(Modifier.width(10.dp))
                    Text(member.name, color = palette.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        stringResource(if (member.online) R.string.room_member_online else R.string.room_member_offline),
                        style = CoreHubTextStyles.meta,
                        color = palette.textMuted,
                    )
                    if (info.canManage) {
                        IconButton(onClick = { removingMember = member }, modifier = Modifier.size(28.dp)) {
                            Icon(CoreHubIcons.Close, contentDescription = stringResource(R.string.room_remove_member), tint = palette.textMuted, modifier = Modifier.size(14.dp))
                        }
                    }
                }
            }

            HorizontalDivider(color = palette.borderLight)

            // ── invite ────────────────────────────────────────────────────
            Text(stringResource(R.string.room_invite), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
            val code = info.inviteCode
            if (code.isNullOrBlank()) {
                Text(stringResource(R.string.room_invite_none), style = CoreHubTextStyles.meta, color = palette.textMuted)
            } else {
                val link = remember(code) { viewModel.roomInviteLink(code) }
                Text(link, style = CoreHubTextStyles.meta.copy(fontFamily = CoreHubTokens.Type.mono, textDirection = TextDirection.Ltr), color = palette.textSecondary)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { clipboard.setText(AnnotatedString(link)); viewModel.showNotice(R.string.room_invite_copied) }) {
                        Text(stringResource(R.string.room_invite_copy))
                    }
                    TextButton(onClick = { showQr = !showQr }) { Text(stringResource(if (showQr) R.string.room_invite_hide_qr else R.string.room_invite_qr)) }
                    if (info.canManage) TextButton(onClick = { viewModel.rotateRoomInviteCode() }) { Text(stringResource(R.string.room_invite_rotate)) }
                }
                if (showQr) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { QrCode(link) }
            }

            HorizontalDivider(color = palette.borderLight)

            // ── agent handoff ─────────────────────────────────────────────
            Text(stringResource(R.string.room_handoff), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.room_handoff_enabled), color = palette.textPrimary, modifier = Modifier.weight(1f))
                Switch(
                    checked = info.agentHandoffEnabled,
                    enabled = info.canManage,
                    onCheckedChange = { viewModel.setRoomHandoff(it, handoffDepth.toIntOrNull(), info.agentHandoffUnlimited) },
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.room_handoff_unlimited), color = palette.textPrimary, modifier = Modifier.weight(1f))
                Switch(
                    checked = info.agentHandoffUnlimited,
                    enabled = info.canManage && info.agentHandoffEnabled,
                    onCheckedChange = { viewModel.setRoomHandoff(info.agentHandoffEnabled, handoffDepth.toIntOrNull(), it) },
                )
            }
            if (!info.agentHandoffUnlimited) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = handoffDepth,
                        onValueChange = { handoffDepth = it.filter(Char::isDigit) },
                        singleLine = true,
                        enabled = info.canManage && info.agentHandoffEnabled,
                        label = { Text(stringResource(R.string.room_handoff_depth)) },
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                        textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Ltr),
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        onClick = { viewModel.setRoomHandoff(info.agentHandoffEnabled, handoffDepth.toIntOrNull(), info.agentHandoffUnlimited) },
                        enabled = info.canManage && info.agentHandoffEnabled,
                    ) { Text(stringResource(R.string.action_save)) }
                }
            }
            room.handoffs.forEach { chain -> HandoffRow(chain, onContinue = { viewModel.continueRoomHandoff(chain) }) }

            HorizontalDivider(color = palette.borderLight)

            // ── running summary ───────────────────────────────────────────
            Text(stringResource(R.string.room_summary), style = CoreHubTextStyles.groupHeader, color = palette.textSecondary)
            room.summary?.let { summary ->
                Text(
                    stringResource(R.string.room_summary_status, summary.status, summary.summarizedTurnCount),
                    style = CoreHubTextStyles.meta,
                    color = if (summary.lastError != null) palette.error else palette.textMuted,
                )
                summary.lastError?.let { Text(it, style = CoreHubTextStyles.meta, color = palette.error) }
            }
            OutlinedTextField(
                value = summaryDraft,
                onValueChange = { summaryDraft = it },
                minLines = 3,
                maxLines = 8,
                enabled = info.canManage,
                placeholder = { Text(stringResource(R.string.room_summary_empty), color = palette.textMuted) },
                textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(onClick = { viewModel.saveRoomSummary(summaryDraft) }, enabled = info.canManage) { Text(stringResource(R.string.action_save)) }
                TextButton(onClick = { viewModel.loadRoomSummary() }) { Text(stringResource(R.string.action_refresh)) }
            }

            HorizontalDivider(color = palette.borderLight)

            Text(
                stringResource(R.string.room_tokens, info.totalTokens),
                style = CoreHubTextStyles.meta.copy(textDirection = TextDirection.Ltr),
                color = palette.textMuted,
            )
            if (info.canManage) {
                TextButton(onClick = { clearing = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.room_clear_context), color = palette.error)
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(label: Int) {
    Text(stringResource(label), style = CoreHubTextStyles.groupHeader, color = CoreHub.palette.textSecondary)
}

/** One handoff chain: status, depth, and "continue" when the server allows it. */
@Composable
private fun HandoffRow(chain: HandoffChain, onContinue: () -> Unit) {
    val palette = CoreHub.palette
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.room_handoff_chain, chain.status, chain.currentDepth, chain.maxDepth ?: 0),
                style = CoreHubTextStyles.meta,
                color = if (chain.lastError != null) palette.error else palette.textSecondary,
            )
            chain.stopReason.takeIf { it.isNotBlank() }?.let { Text(it, style = CoreHubTextStyles.meta, color = palette.textMuted) }
            chain.lastError?.let { Text(it, style = CoreHubTextStyles.meta, color = palette.error) }
        }
        if (chain.status == "stopped" && !chain.continueUsed) {
            TextButton(onClick = onContinue) { Text(stringResource(R.string.room_handoff_continue)) }
        }
    }
}

/** A seat's stored values as an editable draft. */
private fun RoomAgent.toDraft() = us.i3u.hermesstudio.RoomAgentDraft(
    agent = agent,
    agentMode = agentMode,
    profile = profile,
    provider = provider,
    model = model,
    apiMode = apiMode,
    reasoningEffort = reasoningEffort,
    name = name,
    description = description,
    avatar = avatar,
)

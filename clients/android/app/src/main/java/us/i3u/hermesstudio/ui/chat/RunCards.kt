package us.i3u.hermesstudio.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import us.i3u.hermesstudio.CompressionStatus
import us.i3u.hermesstudio.LocationRequest
import us.i3u.hermesstudio.PendingRunAction
import us.i3u.hermesstudio.QueuedRun
import us.i3u.hermesstudio.ContentDirectionBox
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.RequiredAction
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * Approval and clarification requests rendered inline in the stream, as the
 * web does: a card with the prompt, the choices as pills, and (for questions)
 * a free-text answer.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RunActionCard(action: PendingRunAction, onRespond: (String) -> Unit) {
    val palette = CoreHub.palette
    var answer by rememberSaveable(action.id) { mutableStateOf("") }
    val approval = action.kind == RequiredAction.Approval
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(CoreHubTokens.Radius.bubble),
        color = palette.bgCard,
        border = BorderStroke(1.dp, palette.warning.copy(alpha = 0.6f)),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                stringResource(if (approval) R.string.run_approval_title else R.string.run_clarification_title),
                style = CoreHubTextStyles.groupHeader,
                color = palette.warning,
            )
            Text(
                action.prompt.ifBlank { stringResource(if (approval) R.string.run_requires_approval else R.string.run_requires_clarification) },
                style = CoreHubTextStyles.message.copy(textDirection = TextDirection.Content),
                color = palette.textPrimary,
            )
            if (approval) {
                val choices = action.options.filter { it != "deny" }.ifEmpty { listOf("once") }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    choices.forEach { choice ->
                        ChoicePill(
                            label = stringResource(
                                when (choice) {
                                    "session" -> R.string.approval_session
                                    "always" -> R.string.approval_always
                                    else -> R.string.approval_once
                                },
                            ),
                            primary = true,
                        ) { onRespond(choice) }
                    }
                    ChoicePill(label = stringResource(R.string.action_reject), primary = false) { onRespond(action.options.firstOrNull { it == "deny" } ?: "deny") }
                }
            } else {
                if (action.options.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        action.options.forEach { choice -> ChoicePill(label = choice, primary = answer == choice) { answer = choice } }
                    }
                }
                // The answer is the owner's own text: its direction comes from
                // what was typed, not from the interface language.
                ContentDirectionBox(answer) {
                    OutlinedTextField(
                        value = answer,
                        onValueChange = { answer = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(stringResource(R.string.run_clarification_answer), color = palette.textMuted) },
                        textStyle = CoreHubTextStyles.input.copy(color = palette.textPrimary, textDirection = TextDirection.Content),
                        shape = RoundedCornerShape(CoreHubTokens.Radius.bubble),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = palette.accent,
                            unfocusedBorderColor = palette.inputBorder,
                            cursorColor = palette.accent,
                        ),
                        maxLines = 4,
                    )
                }
                Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                    ChoicePill(label = stringResource(R.string.action_send), primary = true, enabled = answer.isNotBlank()) { onRespond(answer.trim()) }
                }
            }
        }
    }
}

@Composable
private fun ChoicePill(label: String, primary: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val palette = CoreHub.palette
    Text(
        label,
        style = CoreHubTextStyles.sessionTitle.copy(fontWeight = FontWeight.Medium),
        color = if (primary) palette.textOnAccent else palette.textPrimary,
        modifier = Modifier
            .clip(RoundedCornerShape(CoreHubTokens.Radius.pill))
            .background(if (primary) palette.accent.copy(alpha = if (enabled) 1f else 0.4f) else palette.segmentTrack)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

/** Queued messages under the stream: run next (insert), interrupt with it (steer), cancel. */
@Composable
fun QueuedRunsList(
    runs: List<QueuedRun>,
    insertionActive: Boolean,
    onInsert: (String) -> Unit,
    onSteer: (String) -> Unit,
    onCancel: (String) -> Unit,
) {
    val palette = CoreHub.palette
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.queued_title), style = CoreHubTextStyles.groupHeader, color = palette.textMuted)
            if (insertionActive) CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.5.dp, color = palette.textMuted)
        }
        runs.forEach { queued ->
            Surface(
                shape = RoundedCornerShape(CoreHubTokens.Radius.medium),
                color = palette.bgCard,
                border = BorderStroke(1.dp, palette.borderLight),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(modifier = Modifier.padding(start = 10.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${queued.position}.",
                        style = CoreHubTextStyles.meta,
                        color = palette.textMuted,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        queued.preview,
                        style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content),
                        color = palette.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = { onInsert(queued.id) }, enabled = !insertionActive, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Filled.KeyboardArrowUp, stringResource(R.string.queued_run_insert), tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                    }
                    IconButton(onClick = { onSteer(queued.id) }, enabled = !insertionActive, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Filled.Bolt, stringResource(R.string.queued_run_steer), tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                    }
                    IconButton(onClick = { onCancel(queued.id) }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Filled.Close, stringResource(R.string.queued_run_cancel), tint = palette.textSecondary, modifier = Modifier.size(16.dp))
                    }
                }
            }
        }
    }
}

/** Compression banner: "Compressing context…" then the before → after token summary. */
@Composable
fun CompressionBanner(status: CompressionStatus, onDismiss: () -> Unit) {
    val palette = CoreHub.palette
    val text = when {
        status.running && status.messageCount != null -> stringResource(R.string.compression_running, status.messageCount)
        status.running -> stringResource(R.string.compression_running_short)
        status.error != null -> stringResource(R.string.compression_failed, status.error)
        status.beforeTokens != null && status.afterTokens != null ->
            stringResource(R.string.compression_done, formatTokens(status.beforeTokens), formatTokens(status.afterTokens))
        else -> stringResource(R.string.compression_done_short)
    }
    InfoBanner(text = text, tint = if (status.error != null) palette.error else palette.info, busy = status.running, onDismiss = if (status.running) null else onDismiss)
}

/** Abort banner while the server stops the run. */
@Composable
fun AbortBanner(phase: String) {
    val palette = CoreHub.palette
    InfoBanner(
        text = stringResource(if (phase == "timeout") R.string.abort_timeout else R.string.abort_started),
        tint = palette.warning,
        busy = true,
        onDismiss = null,
    )
}

@Composable
private fun InfoBanner(text: String, tint: androidx.compose.ui.graphics.Color, busy: Boolean, onDismiss: (() -> Unit)?) {
    val palette = CoreHub.palette
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
        shape = RoundedCornerShape(CoreHubTokens.Radius.medium),
        color = tint.copy(alpha = CoreHubTokens.Alpha.HOVER),
    ) {
        Row(modifier = Modifier.padding(start = 10.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (busy) CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp, color = tint)
            Text(text, style = CoreHubTextStyles.sessionTitle.copy(textDirection = TextDirection.Content), color = palette.textPrimary, modifier = Modifier.weight(1f))
            if (onDismiss != null) {
                IconButton(onClick = onDismiss, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Filled.Close, stringResource(R.string.action_dismiss), tint = palette.textMuted, modifier = Modifier.size(14.dp))
                }
            }
        }
    }
}

/**
 * The consent dialog for `location.requested`. [onAllow] must obtain the
 * runtime permission before the view model reads the position.
 */
@Composable
fun LocationConsentDialog(request: LocationRequest, onAllow: () -> Unit, onDeny: () -> Unit) {
    val palette = CoreHub.palette
    AlertDialog(
        onDismissRequest = onDeny,
        icon = { Icon(Icons.Filled.LocationOn, contentDescription = null, tint = palette.textSecondary) },
        title = { Text(stringResource(R.string.location_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    request.purpose.ifBlank { stringResource(R.string.location_purpose_default) },
                    style = CoreHubTextStyles.message.copy(textDirection = TextDirection.Content),
                )
                Text(
                    stringResource(if (request.accuracy == "precise") R.string.location_precise else R.string.location_coarse),
                    style = CoreHubTextStyles.meta,
                    color = palette.textMuted,
                )
            }
        },
        confirmButton = { TextButton(onClick = onAllow) { Text(stringResource(R.string.location_allow)) } },
        dismissButton = { TextButton(onClick = onDeny) { Text(stringResource(R.string.location_deny)) } },
    )
}

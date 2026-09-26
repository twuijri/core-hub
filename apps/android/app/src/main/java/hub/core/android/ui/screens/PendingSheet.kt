package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.nav.Navigator
import hub.core.android.ui.components.ApprovalCard
import hub.core.android.ui.components.EmptyState
import hub.core.android.ui.components.ProfileBadge
import hub.core.android.ui.components.QuestionCard
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalKind

/**
 * The pending list on the phone (proposed — owner to confirm): a bell in the top bar of the chat,
 * the draft and a room, with how many things wait — approvals and questions of every profile,
 * a room's seats' among them. Each can be answered in the sheet, or opened where it lives.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PendingButton(shell: ShellViewModel, nav: Navigator) {
    val pending by shell.pending.collectAsState()
    val profiles by shell.profiles.collectAsState()
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { shell.refreshPending(); open = true }, modifier = Modifier.testTag("pending.open")) {
        BadgedBox(badge = { if (pending.isNotEmpty()) Badge { Text("${pending.size}") } }) {
            Icon(Icons.Default.Notifications, stringResource(R.string.pending_title))
        }
    }
    if (!open) return
    val t = LocalTokens.current
    ModalBottomSheet(onDismissRequest = { open = false }) {
        LazyColumn(
            Modifier.fillMaxWidth().navigationBarsPadding().testTag("pending.sheet"),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Text(stringResource(R.string.pending_title), style = MaterialTheme.typography.titleMedium) }
            if (pending.isEmpty()) item { EmptyState(stringResource(R.string.pending_empty)) }
            items(pending, key = { it.id }) { approval ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        val where = when {
                            approval.roomId != null -> R.string.pending_in_room
                            approval.workflowRunId != null -> R.string.pending_in_workflow
                            else -> R.string.pending_in_chat
                        }
                        Text(stringResource(where), style = MaterialTheme.typography.labelMedium, color = t.textMuted, modifier = Modifier.weight(1f))
                        if (profiles.size > 1) ProfileBadge(shell.profileName(approval.profile))
                        PendingList.routeOf(approval)?.let { route ->
                            TextButton(onClick = { open = false; nav.go(route) }, modifier = Modifier.testTag("pending.go.${approval.id}")) {
                                Text(stringResource(R.string.pending_open))
                            }
                        }
                    }
                    Box {
                        if (approval.kind == ApprovalKind.QUESTION) {
                            QuestionCard(
                                approval,
                                onAnswer = { shell.respond(approval, null, it) },
                                onSkip = { shell.respond(approval, ApprovalDecision.DENY, null) },
                            )
                        } else {
                            ApprovalCard(approval) { shell.respond(approval, it, null) }
                        }
                    }
                }
            }
        }
    }
}

package hub.core.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.Lucide
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
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
import hub.core.android.ui.components.QuestionCard
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.ApprovalDecision
import hub.core.client.model.ApprovalKind

/**
 * The pending list on the phone (proposed — owner to confirm): a bell in the top bar of the chat,
 * the draft and a room, with how many things wait — approvals and questions of every profile,
 * a room's seats' among them. Each can be answered in the sheet, or opened where it lives.
 */
@Composable
fun PendingButton(shell: ShellViewModel, nav: Navigator) {
    val pending by shell.pending.collectAsState()
    val profiles by shell.profiles.collectAsState()
    var open by remember { mutableStateOf(false) }
    val t = LocalTokens.current
    // The bell shows only while something waits (owner, 2026-09-27: a small mark, not another
    // permanent button); its count is the badge, its words are for TalkBack.
    if (pending.isNotEmpty() || open) {
        Box {
            HubIconButton(
                Lucide.Bell, stringResource(R.string.pending_count, pending.size), { shell.refreshPending(); open = true },
                kind = IconKind.Glass, modifier = Modifier.testTag("pending.open"),
            )
            if (pending.isNotEmpty()) {
                Text(
                    "${pending.size}", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = t.accentText,
                    modifier = Modifier.align(Alignment.TopEnd).background(t.accent, CircleShape).padding(horizontal = 5.dp, vertical = 1.dp),
                )
            }
        }
    }
    if (!open) return
    HubSheet(onDismiss = { open = false }, title = stringResource(R.string.pending_title)) {
        LazyColumn(
            Modifier.fillMaxWidth().heightIn(max = 560.dp).testTag("pending.sheet"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (pending.isEmpty()) item { EmptyState(stringResource(R.string.pending_empty), icon = Lucide.Inbox) }
            items(pending, key = { it.id }) { approval ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        val where = when {
                            approval.roomId != null -> R.string.pending_in_room
                            approval.workflowRunId != null -> R.string.pending_in_workflow
                            else -> R.string.pending_in_chat
                        }
                        Text(stringResource(where), fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted, modifier = Modifier.weight(1f))
                        if (profiles.size > 1) Badge(shell.profileName(approval.profile), tone = BadgeTone.Accent)
                        PendingList.routeOf(approval)?.let { route ->
                            HubButton(
                                stringResource(R.string.pending_open), { open = false; nav.go(route) }, kind = ButtonKind.Ghost, size = ControlSize.Sm,
                                icon = Lucide.ExternalLink, modifier = Modifier.testTag("pending.go.${approval.id}"),
                            )
                        }
                    }
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

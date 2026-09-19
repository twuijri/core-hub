package us.i3u.hermesstudio.ui.workflows

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.ui.theme.CoreHubTokens

/**
 * The status vocabulary shared by the workflow list chip and the run timeline.
 * The server sends the web's strings; both surfaces must colour and name them
 * the same way, so the mapping lives here and is unit-tested.
 */
enum class WorkflowStatusTone { Idle, Busy, Good, Bad, Waiting }

/** Maps a server status onto the tone the chip is painted with. */
fun workflowStatusTone(status: String): WorkflowStatusTone = when (status.lowercase()) {
    "running", "queued", "pending", "in_progress" -> WorkflowStatusTone.Busy
    "completed", "succeeded", "success", "done" -> WorkflowStatusTone.Good
    "failed", "error", "canceled", "cancelled", "aborted" -> WorkflowStatusTone.Bad
    "blocked", "pending_approval", "waiting" -> WorkflowStatusTone.Waiting
    else -> WorkflowStatusTone.Idle
}

/** The label resource for a server status; unknown values keep the raw word. */
fun workflowStatusLabel(status: String): Int? = when (status.lowercase()) {
    "idle" -> R.string.workflow_status_idle
    "queued" -> R.string.workflow_status_queued
    "running", "in_progress" -> R.string.workflow_status_running
    "completed", "succeeded", "success", "done" -> R.string.workflow_status_completed
    "failed", "error" -> R.string.workflow_status_failed
    "canceled", "cancelled", "aborted" -> R.string.workflow_status_canceled
    "blocked", "pending_approval" -> R.string.workflow_status_waiting
    "skipped" -> R.string.workflow_status_skipped
    else -> null
}

@Composable
fun workflowStatusText(status: String): String = workflowStatusLabel(status)?.let { stringResource(it) } ?: status

fun workflowStatusColor(palette: CoreHubTokens.Palette, status: String): Color = when (workflowStatusTone(status)) {
    WorkflowStatusTone.Busy -> palette.info
    WorkflowStatusTone.Good -> palette.success
    WorkflowStatusTone.Bad -> palette.error
    WorkflowStatusTone.Waiting -> palette.warning
    WorkflowStatusTone.Idle -> palette.textMuted
}

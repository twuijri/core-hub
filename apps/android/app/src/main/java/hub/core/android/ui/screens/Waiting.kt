package hub.core.android.ui.screens

import hub.core.android.nav.Route
import hub.core.client.model.Approval
import hub.core.client.model.ApprovalStatus
import hub.core.client.model.BulkResult
import hub.core.client.model.Session

/**
 * What waits for the person, across every profile they may enter (ADR 0016): the approvals and
 * questions of their chats, their rooms' seats and their workflows (`sessions.listApprovals`, one
 * call per profile), oldest first — what has waited longest is the most likely to expire.
 * Pure, so where each thing opens is tested without a hub.
 */
object PendingList {
    fun merge(groups: List<List<Approval>>): List<Approval> =
        groups.flatten().filter { it.status == ApprovalStatus.PENDING }.distinctBy { it.id }.sortedBy { it.createdAt }

    /** Where a waiting thing is handled: its room, its conversation, or Schedules for a workflow's step. */
    fun routeOf(approval: Approval): Route? = when {
        approval.roomId != null -> Route.Room(approval.roomId!!, approval.profile)
        approval.sessionId != null -> Route.Chat(approval.sessionId!!, approval.profile)
        approval.workflowRunId != null -> Route.Schedules
        else -> null
    }
}

/**
 * The chats list's batch mode: a long press selects, then archive, unarchive or delete them all
 * at once (`sessions.bulkUpdate` / `sessions.bulkDelete`). The list may hold several profiles and
 * each call names one, so the selection is sent per profile, at most 100 ids a call.
 */
object ChatsBatch {
    const val MAX_PER_CALL = 100

    fun toggle(selected: Set<String>, id: String): Set<String> = if (id in selected) selected - id else selected + id

    /** The selected chats by profile, in chunks the hub takes in one call. */
    fun byProfile(items: List<Session>, selected: Set<String>): List<Pair<String, List<String>>> =
        items.filter { it.id in selected }.groupBy { it.profile }
            .flatMap { (profile, sessions) -> sessions.map { it.id }.chunked(MAX_PER_CALL).map { profile to it } }

    /** The hub's words for what did not go through (partial success is still a success). */
    fun failures(results: List<BulkResult>): List<String> =
        results.flatMap { it.results }.filter { !it.ok }.map { it.error?.error ?: it.id }
}

/** A conversation exported to share: the hub's Markdown transcript, named after the chat. */
object Exports {
    fun fileName(title: String?, sessionId: String): String {
        val safe = title.orEmpty().replace(Regex("[\\\\/:*?\"<>|\\n\\r\\t]+"), " ").trim().take(80)
        return (safe.ifEmpty { sessionId }) + ".md"
    }
}

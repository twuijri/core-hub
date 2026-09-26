package hub.core.android.chat

import hub.core.client.model.ToolCall
import hub.core.client.model.ToolCallStatus

/** The folded row of a finished turn's tools: how many, how long, how many failed, which. */
data class ToolActivitySummary(
    val count: Int,
    val failed: Int,
    /** Wall-clock time from the first start to the last finish, else the calls' durations summed. */
    val durationMs: Long?,
    /** The latest distinct tool names, most recent first. */
    val names: List<String>,
)

data class ToolActivityState(
    /** True once the turn has ended and nothing is still running or waiting. */
    val folded: Boolean,
    /** The calls a live turn shows, in order; empty when folded (the row opens to all of them). */
    val visible: List<ToolCall>,
    /** How many calls the "+k earlier steps" line (live) or the folded row stands for. */
    val hidden: Int,
    val summary: ToolActivitySummary,
)

/**
 * What a turn's tool calls show — the web's `toolActivity` (packages/web/src/chat/toolActivity.ts)
 * with the phone's window of two (owner, 2026-09-26; DECISIONS §111):
 *
 * - while the turn runs, the last [WINDOW] calls, plus any call still running or waiting and any
 *   that failed (an error stays in view until the turn ends); the rest are "+k earlier steps";
 * - once it has ended, every call folds into one summary row that opens to the full list.
 */
object ToolActivity {
    const val WINDOW = 2
    const val NAMES = 2

    private fun ToolCall.busy() = status == ToolCallStatus.RUNNING || status == ToolCallStatus.AWAITING_APPROVAL
    private fun ToolCall.pinned() = busy() || status == ToolCallStatus.FAILED

    fun of(calls: List<ToolCall>, live: Boolean, window: Int = WINDOW, maxNames: Int = NAMES): ToolActivityState {
        val summary = summarize(calls, maxNames)
        val folded = !live && calls.none { it.busy() }
        if (folded) return ToolActivityState(true, emptyList(), calls.size, summary)
        val start = (calls.size - window).coerceAtLeast(0)
        val visible = calls.filterIndexed { index, call -> index >= start || call.pinned() }
        return ToolActivityState(false, visible, calls.size - visible.size, summary)
    }

    fun summarize(calls: List<ToolCall>, maxNames: Int = NAMES): ToolActivitySummary {
        val names = mutableListOf<String>()
        for (call in calls.asReversed()) {
            if (names.size >= maxNames) break
            if (call.name !in names) names += call.name
        }
        return ToolActivitySummary(
            count = calls.size,
            failed = calls.count { it.status == ToolCallStatus.FAILED },
            durationMs = totalDuration(calls),
            names = names,
        )
    }

    private fun totalDuration(calls: List<ToolCall>): Long? {
        if (calls.isNotEmpty() && calls.all { it.startedAt != null && it.finishedAt != null }) {
            val start = calls.minOf { it.startedAt!!.toInstant().toEpochMilli() }
            val end = calls.maxOf { it.finishedAt!!.toInstant().toEpochMilli() }
            return (end - start).coerceAtLeast(0)
        }
        val durations = calls.mapNotNull { it.durationMs?.toLong() }
        return if (durations.isEmpty()) null else durations.sum()
    }

    /** Minutes and seconds of the folded row's time, never below one second ("1m 05s", "42s"). */
    fun durationParts(ms: Long): Pair<Long, Long> {
        val total = ((ms + 500) / 1000).coerceAtLeast(1)
        return total / 60 to total % 60
    }
}

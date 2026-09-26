package hub.core.android.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.chat.ToolActivity
import hub.core.android.chat.ToolActivitySummary
import hub.core.android.generated.FontTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.theme.LocalReducedMotion
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.Mono
import hub.core.client.model.ToolCall

/** `motion.normal` of tokens.json (200 ms); the Android tokens carry no motion group yet. */
private const val STEP_MS = 200

/**
 * A turn's tools, as on the web and iOS (owner, 2026-09-26; [ToolActivity]): while the agent
 * works, the latest two steps — a running or failed one stays too — with the earlier ones one
 * "+k earlier steps" line away, a new step sliding in and an old one sliding out; once the turn
 * has ended, one row — how many steps, how long, how many failed, the latest tools — that opens
 * to every card. What is open is per message and never saved. Reduced motion: no slide, no fade.
 */
@Composable
fun ToolActivityView(calls: List<ToolCall>, live: Boolean) {
    if (calls.isEmpty()) return
    val activity = ToolActivity.of(calls, live)
    val reduced = LocalReducedMotion.current
    val key = calls.first().id
    if (!activity.folded) {
        var earlier by rememberSaveable(key, "earlier") { mutableStateOf(false) }
        val shownIds = if (earlier) calls.map { it.id }.toSet() else activity.visible.map { it.id }.toSet()
        Column(Modifier.fillMaxWidth().testTag("tool.activity.live"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (activity.hidden > 0) {
                EarlierLine(activity.hidden, earlier) { earlier = !earlier }
            }
            calls.forEach { call ->
                // A step that arrives while the turn runs slides in; one that leaves the window slides out.
                val state = remember(call.id) { MutableTransitionState(reduced) }
                state.targetState = call.id in shownIds
                AnimatedVisibility(
                    visibleState = state,
                    enter = if (reduced) EnterTransition.None else fadeIn(tween(STEP_MS)) + expandVertically(tween(STEP_MS)),
                    exit = if (reduced) ExitTransition.None else fadeOut(tween(STEP_MS)) + shrinkVertically(tween(STEP_MS)),
                ) { ToolCallCard(call) }
            }
        }
    } else {
        var open by rememberSaveable(key, "open") { mutableStateOf(false) }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            FoldedRow(activity.summary, open) { open = !open }
            AnimatedVisibility(
                visible = open,
                enter = if (reduced) EnterTransition.None else fadeIn(tween(STEP_MS)) + expandVertically(tween(STEP_MS)),
                exit = if (reduced) ExitTransition.None else fadeOut(tween(STEP_MS)) + shrinkVertically(tween(STEP_MS)),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { calls.forEach { ToolCallCard(it) } }
            }
        }
    }
}

@Composable
private fun EarlierLine(count: Int, open: Boolean, toggle: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = toggle).padding(vertical = 2.dp).testTag("tool.activity.earlier"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LucideIcon(if (open) Lucide.ChevronUp else Lucide.ChevronDown, null, size = 14.dp, tint = t.textFaint)
        Text(
            if (open) stringResource(R.string.tool_activity_hide_earlier)
            else pluralStringResource(R.plurals.tool_activity_earlier, count, count),
            fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
        )
    }
}

/** The finished turn's one row: «6 steps · 1m 05s · 1 failed · web_search terminal ⌄». */
@Composable
fun FoldedRow(summary: ToolActivitySummary, open: Boolean, toggle: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().background(t.surface2, RoundedCornerShape(RadiusTokens.md.dp))
            .clickable(role = Role.Button, onClickLabel = stringResource(if (open) R.string.tool_activity_hide else R.string.tool_activity_show), onClick = toggle)
            .padding(horizontal = 8.dp, vertical = 7.dp).testTag("tool.activity.folded"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideIcon(Lucide.Wrench, null, size = 14.dp, tint = t.textMuted)
        Text(
            pluralStringResource(R.plurals.tool_activity_steps, summary.count, summary.count),
            fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.SemiBold, color = t.text, maxLines = 1,
        )
        summary.durationMs?.let { ms ->
            val (minutes, seconds) = ToolActivity.durationParts(ms)
            Text(
                if (minutes > 0) stringResource(R.string.tool_activity_minutes, minutes.toInt(), seconds.toInt())
                else stringResource(R.string.tool_activity_seconds, seconds.toInt()),
                fontSize = FontTokens.sizeXs.sp, color = t.textFaint, maxLines = 1,
            )
        }
        if (summary.failed > 0) {
            Badge(
                pluralStringResource(R.plurals.tool_activity_failed, summary.failed, summary.failed),
                Modifier.testTag("tool.activity.failed"), tone = BadgeTone.Danger,
            )
        }
        // The tools' names are code: left to right whatever the language, clipped when the row is full.
        // In Arabic they still sit beside the count, at the reading start of their slot.
        val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            Row(
                Modifier.weight(1f).clipToBounds(),
                horizontalArrangement = Arrangement.spacedBy(4.dp, if (rtl) Alignment.End else Alignment.Start),
            ) {
                summary.names.forEach { name ->
                    // Each chip takes its share and ends in «…» rather than being cut mid-letter.
                    Text(
                        name, fontFamily = Mono, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 1,
                        softWrap = false, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false)
                            .background(t.surface, RoundedCornerShape(RadiusTokens.sm.dp)).padding(horizontal = 4.dp),
                    )
                }
            }
        }
        LucideIcon(if (open) Lucide.ChevronUp else Lucide.ChevronDown, null, size = 14.dp, tint = t.textFaint)
    }
}

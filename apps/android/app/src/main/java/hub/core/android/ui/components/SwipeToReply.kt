package hub.core.android.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.theme.LocalReducedMotion
import hub.core.android.ui.theme.LocalTokens
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * Swipe a message to reply to it, as in Telegram (DECISIONS §150; the owner: «اذا المستخدم سحب
 * المحادثة يسار يخليني كاني برد عليها نفس التيليقرام»). The bubble follows the finger toward the
 * start of the reading direction — left in English, right in Arabic, the side away from the
 * system back gesture's own — with the reply arrow appearing behind it; past [SwipeReplyRules.THRESHOLD]
 * a light tick, and on release the same reply the message menu offers. A mostly vertical drag is
 * left to the list's scroll; the axis is decided once and kept. TalkBack gets a «Reply» action.
 */
object SwipeReplyRules {
    /** How far the bubble must travel before letting go replies. */
    val THRESHOLD = 60.dp

    /** How far it goes at most; beyond the threshold it moves at a third of the finger's speed. */
    val LIMIT = 96.dp

    /**
     * The sign of a reply swipe's horizontal travel: toward the reading start — negative (left)
     * in a left-to-right layout, positive (right) in a right-to-left one.
     */
    fun direction(layout: LayoutDirection): Float = if (layout == LayoutDirection.Ltr) -1f else 1f

    /** Whether the first move past the touch slop is a swipe to reply (and not a scroll). */
    fun startsSwipe(dx: Float, dy: Float, direction: Float): Boolean = dx * direction > 0 && abs(dx) > abs(dy) * 1.5f

    /** Where the bubble is for a finger [travel] along [direction], in pixels (resisted past the threshold). */
    fun offsetFor(travel: Float, threshold: Float, limit: Float): Float {
        val along = travel.coerceAtLeast(0f)
        val resisted = if (along <= threshold) along else threshold + (along - threshold) / 3f
        return resisted.coerceAtMost(limit)
    }
}

@Composable
fun SwipeToReply(enabled: Boolean, onReply: () -> Unit, content: @Composable () -> Unit) {
    if (!enabled) {
        content()
        return
    }
    val density = LocalDensity.current
    val threshold = with(density) { SwipeReplyRules.THRESHOLD.toPx() }
    val limit = with(density) { SwipeReplyRules.LIMIT.toPx() }
    val direction = SwipeReplyRules.direction(LocalLayoutDirection.current)
    val slop = LocalViewConfiguration.current.touchSlop
    val haptics = LocalHapticFeedback.current
    val reduced = LocalReducedMotion.current
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val replyLabel = stringResource(R.string.chat_controls_reply_action)
    val t = LocalTokens.current
    Box(
        Modifier
            .semantics { customActions = listOf(CustomAccessibilityAction(replyLabel) { onReply(); true }) }
            .pointerInput(direction, threshold, limit, reduced) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    var dx = 0f
                    var dy = 0f
                    // Decide the axis once, past the touch slop: a mostly vertical drag is the list's.
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val change = event.changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
                        if (!change.pressed) return@awaitEachGesture
                        dx += change.positionChange().x
                        dy += change.positionChange().y
                        if (abs(dx) < slop && abs(dy) < slop) continue
                        if (!SwipeReplyRules.startsSwipe(dx, dy, direction)) return@awaitEachGesture
                        change.consume()
                        break
                    }
                    var travel = dx * direction
                    var ticked = false
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        travel += change.positionChange().x * direction
                        change.consume()
                        val shown = SwipeReplyRules.offsetFor(travel, threshold, limit)
                        if (!ticked && shown >= threshold) {
                            ticked = true
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        } else if (ticked && shown < threshold) {
                            ticked = false
                        }
                        scope.launch { offset.snapTo(shown * direction) }
                    }
                    if (ticked) onReply()
                    scope.launch {
                        if (reduced) offset.snapTo(0f) else offset.animateTo(0f, tween(180))
                    }
                }
            },
    ) {
        // The arrow behind the bubble, on the side it is pulled away from.
        val progress = (abs(offset.value) / threshold).coerceIn(0f, 1f)
        if (progress > 0f) {
            Box(
                Modifier.align(if (direction < 0) AbsoluteAlignment.CenterRight else AbsoluteAlignment.CenterLeft)
                    .padding(horizontal = 8.dp)
                    .alpha(progress)
                    .graphicsLayer { scaleX = 0.6f + 0.4f * progress; scaleY = 0.6f + 0.4f * progress }
                    .testTag("message.swipe_reply"),
            ) {
                LucideIcon(Lucide.Reply, null, size = 20.dp, tint = t.accent)
            }
        }
        Box(Modifier.graphicsLayer { translationX = offset.value }) { content() }
    }
}

package hub.core.android.ui.components

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material3.DrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.SoftwareKeyboardController
import androidx.compose.ui.unit.Velocity
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop

/*
 * The keyboard gets out of the way the way it does in the phone's messaging apps (owner,
 * 2026-09-25): a tap on the conversation, a drag of the list, or the drawer moving puts it away.
 */

/**
 * Puts the keyboard away: focus moves off the text field to [sink] (a non-text area placed with
 * [keyboardSink]) and the IME hides. Moving focus inside the page, instead of clearing it, keeps
 * the window's own focus where it is: a cleared window refocuses its first text field, which
 * would bring the keyboard straight back.
 */
@Stable
class KeyboardDismisser(private val focus: FocusManager, private val keyboard: SoftwareKeyboardController?) {
    val sink = FocusRequester()

    fun dismiss() {
        val moved = try {
            sink.requestFocus()
        } catch (_: IllegalStateException) {
            false // no sink placed on screen
        }
        if (!moved) focus.clearFocus(force = true)
        keyboard?.hide()
    }
}

@Composable
fun rememberKeyboardDismisser(): KeyboardDismisser {
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    return remember(focus, keyboard) { KeyboardDismisser(focus, keyboard) }
}

/** Where focus goes when [dismisser] puts the keyboard away: an area with no text field of its own. */
fun Modifier.keyboardSink(dismisser: KeyboardDismisser): Modifier = focusRequester(dismisser.sink).focusTarget()

/**
 * A tap on this area puts the keyboard away. The children see the tap first: a button, a link or
 * a chip inside keeps its own tap and the keyboard stays.
 */
fun Modifier.dismissKeyboardOnTap(dismisser: KeyboardDismisser): Modifier =
    pointerInput(dismisser) { detectTapGestures(onTap = { dismisser.dismiss() }) }

/** Dragging a list inside the area this is given to (`Modifier.nestedScroll`) puts the keyboard away, once per drag. */
@Composable
fun rememberDismissKeyboardOnScroll(dismisser: KeyboardDismisser): NestedScrollConnection {
    val current by rememberUpdatedState(dismisser)
    return remember {
        object : NestedScrollConnection {
            private var done = false

            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (!done && source == NestedScrollSource.UserInput && available.y != 0f) {
                    done = true
                    current.dismiss()
                }
                return Offset.Zero
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                done = false
                return Velocity.Zero
            }
        }
    }
}

/**
 * The drawer moving, either way, first puts the keyboard away: it never opens over the keyboard
 * (by the menu button or by a swipe), and closing it never leaves its search typing into nothing.
 */
@Composable
fun DismissKeyboardWhenDrawerMoves(drawer: DrawerState, dismisser: KeyboardDismisser) {
    val current by rememberUpdatedState(dismisser)
    LaunchedEffect(drawer) {
        snapshotFlow { drawer.targetValue }.distinctUntilChanged().drop(1).collect { current.dismiss() }
    }
}

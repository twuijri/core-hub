package hub.core.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.click
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.ui.components.BrandMark
import hub.core.android.ui.components.DismissKeyboardWhenDrawerMoves
import hub.core.android.ui.components.dismissKeyboardOnTap
import hub.core.android.ui.components.keyboardSink
import hub.core.android.ui.components.rememberDismissKeyboardOnScroll
import hub.core.android.ui.components.rememberKeyboardDismisser
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.ThemeChoice
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The keyboard gets out of the way (docs/changes/2026-09-26-twuijri-mobile-polish.md): a tap on
 * the conversation, a drag of it, or the drawer opening takes focus off the composer, which is
 * what hides the keyboard. Robolectric has no keyboard to look at, so focus is the evidence.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class KeyboardDismissTest {
    @get:Rule val compose = createComposeRule()

    /** A conversation laid out like ChatScreen: the transcript above, the composer below. */
    @Composable
    private fun Conversation(onButton: () -> Unit = {}) {
        val dismiss = rememberKeyboardDismisser()
        val onScroll = rememberDismissKeyboardOnScroll(dismiss)
        var text by remember { mutableStateOf("") }
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxWidth().nestedScroll(onScroll).dismissKeyboardOnTap(dismiss).keyboardSink(dismiss).testTag("transcript")) {
                LazyColumn(Modifier.fillMaxSize().testTag("list")) {
                    item { Button(onClick = onButton, modifier = Modifier.testTag("button")) { Text("Approve") } }
                    items(60) { Text("message $it", Modifier.height(40.dp)) }
                }
            }
            TextField(text, { text = it }, Modifier.testTag("composer"))
        }
    }

    @Test
    fun tappingTheConversationPutsTheKeyboardAway() {
        compose.setContent { CoreHubTheme(ThemeChoice.LIGHT) { Conversation() } }
        compose.onNodeWithTag("composer").performClick().assertIsFocused()
        compose.onNodeWithTag("transcript").performTouchInput { click(center) }
        compose.onNodeWithTag("composer").assertIsNotFocused()
    }

    @Test
    fun aButtonInTheConversationKeepsItsOwnTap() {
        var pressed = 0
        compose.setContent { CoreHubTheme(ThemeChoice.LIGHT) { Conversation(onButton = { pressed++ }) } }
        compose.onNodeWithTag("composer").performClick().assertIsFocused()
        compose.onNodeWithTag("button").performClick()
        assertEquals(1, pressed)
    }

    @Test
    fun draggingTheConversationPutsTheKeyboardAway() {
        compose.setContent { CoreHubTheme(ThemeChoice.LIGHT) { Conversation() } }
        compose.onNodeWithTag("list").performTouchInput { swipeUp() }
        compose.onNodeWithTag("composer").performClick().assertIsFocused()
        compose.onNodeWithTag("list").performTouchInput { swipeDown() }
        compose.onNodeWithTag("composer").assertIsNotFocused()
    }

    @Test
    fun openingTheDrawerPutsTheKeyboardAwayFirst() {
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                val drawer = rememberDrawerState(DrawerValue.Closed)
                val scope = rememberCoroutineScope()
                val dismiss = rememberKeyboardDismisser()
                DismissKeyboardWhenDrawerMoves(drawer, dismiss)
                ModalNavigationDrawer(drawerState = drawer, drawerContent = { ModalDrawerSheet(Modifier.keyboardSink(dismiss)) { Text("menu") } }) {
                    Column {
                        Button(onClick = { scope.launch { drawer.open() } }, modifier = Modifier.testTag("menu")) { Text("Menu") }
                        var text by remember { mutableStateOf("") }
                        TextField(text, { text = it }, Modifier.testTag("composer"))
                    }
                }
            }
        }
        compose.onNodeWithTag("composer").performClick().assertIsFocused()
        compose.onNodeWithTag("menu").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("composer").assertIsNotFocused()
    }

    @Test
    fun theBrandMarkIsTheDrawnMark() {
        compose.setContent { CoreHubTheme(ThemeChoice.LIGHT) { BrandMark() } }
        compose.onNodeWithTag("brand.mark").assertExists()
    }
}

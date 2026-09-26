package hub.core.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSwitch
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.ThemeChoice
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The kit's controls behave as their web and iOS twins: named icons, one choice, a switch. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class KitTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `a long press on an icon button shows its name`() {
        var clicks = 0
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                HubIconButton(Lucide.Archive, "Archive the chats", { clicks++ }, modifier = Modifier.testTag("b"))
            }
        }
        compose.onNodeWithTag("b").performClick()
        assertEquals(1, clicks)
        compose.onNodeWithTag("b").performTouchInput { longClick() }
        compose.onNodeWithText("Archive the chats").assertExists()
        assertEquals("a long press is not a click", 1, clicks)
    }

    @Test fun `a segmented control has one chosen item`() {
        compose.setContent {
            CoreHubTheme(ThemeChoice.DARK) {
                var chosen by remember { mutableStateOf("chat") }
                Segmented(listOf(Segment("chat", "Chat", tag = "s.chat"), Segment("rooms", "Rooms", tag = "s.rooms")), chosen, { chosen = it })
            }
        }
        compose.onNodeWithTag("s.chat").assertIsSelected()
        compose.onNodeWithTag("s.rooms").performClick()
        compose.onNodeWithTag("s.rooms").assertIsSelected()
    }

    @Test fun `a switch turns on`() {
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                var on by remember { mutableStateOf(false) }
                HubSwitch(on, { on = it }, Modifier.testTag("sw"))
            }
        }
        compose.onNodeWithTag("sw").performClick()
        compose.onNodeWithTag("sw").assertIsOn()
    }
}

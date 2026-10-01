package hub.core.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.chat.ChatMessage
import hub.core.android.chat.Turn
import hub.core.android.ui.components.LocalMessageActions
import hub.core.android.ui.components.MessageActions
import hub.core.android.ui.components.SwipeReplyRules
import hub.core.android.ui.components.SwipeToReply
import hub.core.android.ui.components.TurnView
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.ThemeChoice
import hub.core.client.model.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Swipe a message to reply, as in Telegram (DECISIONS §150): toward the reading start (left in
 * English, right in Arabic), never on a vertical drag, a «Reply» accessibility action; and a long
 * press on the agent's reply opens the same menu as on the person's message.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class SwipeToReplyUiTest {
    @get:Rule val compose = createComposeRule()

    private fun bubble(direction: LayoutDirection, enabled: Boolean = true, onReply: () -> Unit) {
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                CompositionLocalProvider(LocalLayoutDirection provides direction) {
                    Box(Modifier.fillMaxWidth().height(120.dp)) {
                        SwipeToReply(enabled = enabled, onReply = onReply) {
                            Text("مرحبا hello", Modifier.fillMaxWidth().height(80.dp).testTag("bubble"))
                        }
                    }
                }
            }
        }
    }

    @Test fun `in English a swipe to the left replies, a swipe to the right does not`() {
        var replied = 0
        bubble(LayoutDirection.Ltr) { replied += 1 }
        compose.onNodeWithTag("bubble").performTouchInput { swipeRight() }
        assertEquals(0, replied)
        compose.onNodeWithTag("bubble").performTouchInput { swipeLeft() }
        assertEquals(1, replied)
    }

    @Test fun `in Arabic a swipe to the right replies, mirrored`() {
        var replied = 0
        bubble(LayoutDirection.Rtl) { replied += 1 }
        compose.onNodeWithTag("bubble").performTouchInput { swipeLeft() }
        assertEquals(0, replied)
        compose.onNodeWithTag("bubble").performTouchInput { swipeRight() }
        assertEquals(1, replied)
    }

    @Test fun `a vertical drag is the list's, and a short swipe replies to nothing`() {
        var replied = 0
        bubble(LayoutDirection.Ltr) { replied += 1 }
        compose.onNodeWithTag("bubble").performTouchInput { swipeDown() }
        compose.onNodeWithTag("bubble").performTouchInput {
            swipeLeft(startX = centerX, endX = centerX - 20f)
        }
        assertEquals(0, replied)
    }

    @Test fun `TalkBack offers Reply`() {
        var replied = 0
        bubble(LayoutDirection.Ltr) { replied += 1 }
        val actions = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions))
            .fetchSemanticsNode().config[SemanticsActions.CustomActions]
        assertEquals(listOf("Reply"), actions.map { it.label })
        actions.first().action()
        assertEquals(1, replied)
    }

    @Test fun `a row that cannot be replied to offers no swipe and no action`() {
        var replied = 0
        bubble(LayoutDirection.Ltr, enabled = false) { replied += 1 }
        compose.onNodeWithTag("bubble").performTouchInput { swipeLeft() }
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions)).assertDoesNotExist()
        assertEquals(0, replied)
    }

    @Test fun `the rules - direction mirrors with the layout, the axis needs a mostly horizontal start`() {
        assertEquals(-1f, SwipeReplyRules.direction(LayoutDirection.Ltr))
        assertEquals(1f, SwipeReplyRules.direction(LayoutDirection.Rtl))
        assertTrue(SwipeReplyRules.startsSwipe(dx = -30f, dy = 5f, direction = -1f))
        assertFalse(SwipeReplyRules.startsSwipe(dx = -30f, dy = 25f, direction = -1f))
        assertFalse(SwipeReplyRules.startsSwipe(dx = 30f, dy = 0f, direction = -1f))
        assertEquals(100f, SwipeReplyRules.offsetFor(100f, threshold = 160f, limit = 260f))
        assertEquals(180f, SwipeReplyRules.offsetFor(220f, threshold = 160f, limit = 260f))
    }

    @Test fun `a long press on the agent's reply opens the message menu, as on the person's`() {
        var replied: String? = null
        val reply = ChatMessage(
            id = "m1", seq = 2, role = MessageRole.ASSISTANT, authorName = "Hermes", text = "الجواب هنا",
            reasoning = "", reasoningMs = null, toolCalls = emptyList(), attachments = emptyList(), runId = "r1", streaming = false,
        )
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                CompositionLocalProvider(LocalMessageActions provides MessageActions(reply = { replied = it.id })) {
                    TurnView(Turn(MessageRole.ASSISTANT, "Hermes", listOf(reply)), youLabel = "You", mine = false)
                }
            }
        }
        compose.onNodeWithTag("message.agent").performTouchInput { longClick() }
        compose.onNodeWithTag("message.reply").performSemanticsAction(SemanticsActions.OnClick)
        assertEquals("m1", replied)
        compose.onNodeWithText("الجواب هنا").assertExists()
    }
}

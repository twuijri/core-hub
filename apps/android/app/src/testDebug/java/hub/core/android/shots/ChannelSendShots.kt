package hub.core.android.shots

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.repoRoot
import hub.core.android.ui.screens.ChannelBottom
import hub.core.android.ui.screens.ChannelSendBottom
import hub.core.android.ui.screens.ChannelSendRefusal
import hub.core.android.ui.screens.HubMessageView
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.ThemeChoice
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.ChannelOutgoing
import hub.core.client.model.ChannelSendUnavailable
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Writing into a Telegram conversation from the phone (§153): the hub's messages with what became
 * of them (sending, answering, failed) and the composer under them; and, where it cannot be written
 * into, the reason with the way to the current conversation. Pictures go to
 * `apps/android/app/build/shots/channel-send/android-<name>.png` for the change record.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w440dp-h956dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChannelSendShots {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val out = File(repoRoot, "apps/android/app/build/shots/channel-send").apply { mkdirs() }
    private val at = "2026-10-08T10:00:00Z"

    private fun outgoing(status: String, error: String = "null") = Serializer.kotlinxSerializationJson.decodeFromString(
        ChannelOutgoing.serializer(),
        """{"id":"01K6ZQ4W5X6Y7Z8A9B0C1D2E3F","conversation_id":"T1","client_message_id":"a-1","text":"x","author_name":"Sara",
            "status":"$status","error":$error,"message_id":null,"session_id":null,"created_at":"$at","updated_at":"$at"}""",
    )

    private fun show(theme: ThemeChoice, channel: String, words: Triple<String, String, String>, bottom: ChannelBottom, refusal: ChannelSendRefusal? = null, onOpen: (String) -> Unit = {}) =
        compose.setContent {
            CoreHubTheme(theme) {
                var draft by remember { mutableStateOf("") }
                Column(Modifier.fillMaxWidth().background(LocalTokens.current.bg).testTag("shot")) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        HubMessageView("Sara", words.first, channel, followed = true, status = outgoing("answering"))
                        HubMessageView("Sara", words.second, channel, followed = true, status = outgoing("failed", """{"reason":"bridge_no_answer","message":null}"""))
                        HubMessageView(null, words.third, channel, followed = true, status = null)
                    }
                    ChannelSendBottom(
                        bottom, channel, "Omar", draft, { draft = it }, busy = false, failure = refusal,
                        onSend = {}, onOpenCurrent = onOpen, onContinue = {},
                    )
                }
            }
        }

    private fun save(name: String) {
        compose.waitForIdle()
        val bounds = compose.onNodeWithTag("shot").fetchSemanticsNode().boundsInRoot
        val view = compose.activity.window.decorView
        val whole = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(whole))
        val bitmap = android.graphics.Bitmap.createBitmap(
            whole, bounds.left.toInt(), bounds.top.toInt(),
            bounds.width.toInt().coerceAtMost(whole.width - bounds.left.toInt()),
            bounds.height.toInt().coerceAtMost(whole.height - bounds.top.toInt()),
        )
        File(out, "android-$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    private val english = Triple("What's the latest?", "Can you send the report?", "Thanks!")

    @Test fun composerEnglish() {
        show(ThemeChoice.LIGHT, "Telegram", english, ChannelBottom.Composer, ChannelSendRefusal.Channel("Bad Request: chat not found"))
        compose.onAllNodesWithText("Sara · from Core Hub").assertCountEquals(2)
        compose.onNodeWithText("The agent is answering on Telegram…").assertExists()
        compose.onNodeWithText("You · from Core Hub").assertExists()
        compose.onNodeWithText("Sending on Telegram…").assertExists()
        compose.onNodeWithTag("channel.send.error").assertExists()
        compose.onNodeWithTag("composer.input").performTextReplacement("Hello from the hub")
        save("composer-light-en")
    }

    @Test fun composerDark() {
        show(ThemeChoice.DARK, "Telegram", english, ChannelBottom.Composer)
        save("composer-dark-en")
    }

    @Test fun notCurrentOpensTheCurrentConversation() {
        var opened: String? = null
        show(ThemeChoice.LIGHT, "Telegram", english, ChannelBottom.Unavailable(ChannelSendUnavailable.NOT_CURRENT, "T2"), onOpen = { opened = it })
        compose.onNodeWithText("This Telegram chat has moved on to a newer conversation; a message from here would go there.").assertExists()
        save("not-current-light-en")
        compose.onNodeWithTag("channel.open_current").performClick()
        compose.waitForIdle()
        assertEquals("T2", opened)
    }

    @Config(qualifiers = "ar-w440dp-h956dp-xxhdpi")
    @Test fun composerArabic() {
        show(ThemeChoice.LIGHT, "تيليجرام", Triple("ما آخر الأخبار؟", "أرسل التقرير لو سمحت", "شكرًا"), ChannelBottom.Composer)
        compose.onAllNodesWithText("Sara · من كور هب").assertCountEquals(2)
        compose.onNodeWithText("الوكيل يرد على تيليجرام…").assertExists()
        save("composer-light-ar")
    }

    @Config(qualifiers = "ar-w440dp-h956dp-xxhdpi")
    @Test fun notAdminArabic() {
        show(ThemeChoice.DARK, "تيليجرام", Triple("ما آخر الأخبار؟", "أرسل التقرير لو سمحت", "شكرًا"), ChannelBottom.Unavailable(ChannelSendUnavailable.NOT_ADMIN, null))
        compose.onNodeWithTag("channel.open_current").assertDoesNotExist()
        save("not-admin-dark-ar")
    }
}

package hub.core.android.shots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.repoRoot
import hub.core.android.ui.components.ToolActivityView
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.ThemeChoice
import hub.core.client.model.ToolCall
import hub.core.client.model.ToolCallStatus
import java.io.File
import java.time.OffsetDateTime
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A turn's tool activity on the phone (owner, 2026-09-26): the live window of two with a failure
 * kept in view, and the folded row that opens to every card. Pictures go to
 * `apps/android/app/build/shots/tool-activity/android-<name>.png` for the change record.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w440dp-h956dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ToolActivityShots {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val out = File(repoRoot, "apps/android/app/build/shots/tool-activity").apply { mkdirs() }

    private fun call(id: String, name: String, status: ToolCallStatus, preview: String, second: Int) = ToolCall(
        id = id, name = name, status = status, preview = preview, outputTruncated = false,
        output = if (status == ToolCallStatus.FAILED) "the image could not be read" else null,
        durationMs = if (status == ToolCallStatus.RUNNING) null else 5_000,
        startedAt = OffsetDateTime.parse("2026-09-26T10:00:00Z").plusSeconds(second.toLong()),
        finishedAt = if (status == ToolCallStatus.RUNNING) null else OffsetDateTime.parse("2026-09-26T10:00:05Z").plusSeconds(second.toLong() + 8),
    )

    private val calls = listOf(
        call("1", "skill_view", ToolCallStatus.SUCCEEDED, "arxiv", 0),
        call("2", "vision_analyze", ToolCallStatus.FAILED, "a.png", 10),
        call("3", "terminal", ToolCallStatus.SUCCEEDED, "ls -la", 20),
        call("4", "read_file", ToolCallStatus.SUCCEEDED, "README.md", 30),
        call("5", "vision_analyze", ToolCallStatus.RUNNING, "b.png", 50),
    )

    private fun show(calls: List<ToolCall>, live: Boolean) = compose.setContent {
        CoreHubTheme(ThemeChoice.LIGHT) {
            val t = LocalTokens.current
            Box(Modifier.fillMaxWidth().background(t.bg).padding(12.dp).testTag("shot")) {
                Box(Modifier.background(t.agentBubble).padding(12.dp)) { ToolActivityView(calls, live) }
            }
        }
    }

    private fun save(name: String) {
        compose.waitForIdle()
        // Robolectric cannot capture a node's window; the activity's view draws into a bitmap,
        // cut to the node's bounds (as ScreenShots does for whole screens).
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

    @Test fun liveWindow() {
        show(calls, live = true)
        // The last two, and the failure before them; the other two are "+2 earlier steps".
        compose.onNodeWithText("+2 earlier steps").assertExists()
        compose.onAllNodesWithTag("tool.vision_analyze", useUnmergedTree = true).assertCountEquals(2)
        compose.onNodeWithTag("tool.skill_view", useUnmergedTree = true).assertDoesNotExist()
        save("tool-activity-live-en")
    }

    @Test fun foldedRow() {
        show(calls.map { if (it.status == ToolCallStatus.RUNNING) it.copy(status = ToolCallStatus.SUCCEEDED, durationMs = 5_000, finishedAt = it.startedAt!!.plusSeconds(15)) else it }, live = false)
        compose.onNodeWithText("5 steps").assertExists()
        compose.onNodeWithText("1m 05s").assertExists()
        compose.onNodeWithText("1 failed").assertExists()
        compose.onNodeWithTag("tool.skill_view", useUnmergedTree = true).assertDoesNotExist()
        save("tool-activity-folded-en")
        compose.onNodeWithTag("tool.activity.folded").performClick()
        compose.onNodeWithTag("tool.skill_view", useUnmergedTree = true).assertExists()
        save("tool-activity-open-en")
    }

    @Config(qualifiers = "ar-w440dp-h956dp-xxhdpi")
    @Test fun foldedRowArabic() {
        show(calls.dropLast(1), live = false)
        compose.onNodeWithText("خطوات", substring = true).assertExists()
        compose.onNodeWithText("فشلت خطوة").assertExists()
        save("tool-activity-folded-ar")
    }

    @Config(qualifiers = "ar-w440dp-h956dp-xxhdpi")
    @Test fun liveWindowArabic() {
        show(calls, live = true)
        compose.onNodeWithText("+ خطوتان سابقتان").assertExists()
        save("tool-activity-live-ar")
    }
}

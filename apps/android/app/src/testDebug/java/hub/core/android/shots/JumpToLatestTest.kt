package hub.core.android.shots

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.ui.components.JumpToLatest
import hub.core.android.ui.components.rememberScrolledAway
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.ThemeChoice
import kotlinx.coroutines.launch
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * "Jump to latest" (owner, 2026-10-27): not there at the newest message; there once the reader
 * has scrolled up; one tap brings the newest message back and it is gone again.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w440dp-h956dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class JumpToLatestTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun showsOnlyWhileScrolledUpAndBringsTheNewestBack() {
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                val list = rememberLazyListState()
                val scope = rememberCoroutineScope()
                LaunchedEffect(Unit) { list.scrollToItem(99) }
                Box(Modifier.fillMaxSize()) {
                    LazyColumn(Modifier.fillMaxSize().testTag("list"), state = list) {
                        items(100) { index -> Text("Message $index", Modifier.height(48.dp)) }
                    }
                    if (rememberScrolledAway(list)) {
                        JumpToLatest(onJump = { scope.launch { list.scrollToItem(99) } }, modifier = Modifier.align(Alignment.BottomCenter))
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("chat.jump_latest").assertDoesNotExist()
        compose.onNodeWithTag("list").performScrollToIndex(10)
        compose.waitForIdle()
        compose.onNodeWithTag("chat.jump_latest").assertExists().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("chat.jump_latest").assertDoesNotExist()
    }
}

package hub.core.android.shots

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.AppLanguage
import hub.core.android.MainActivity
import hub.core.android.data.StoredSession
import hub.core.android.data.StoredUser
import hub.core.android.data.TokenKind
import hub.core.android.graph
import hub.core.android.phone.VoiceSource
import hub.core.android.repoRoot
import hub.core.android.ui.theme.ThemeChoice
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The Android app's main screens against the iOS demo hub ([DemoHub]), in light and dark,
 * English and Arabic, at the iPhone 6.9" size (440 × 956 dp at 3×, the iOS App Store shots'
 * 1320 × 2868), so each picture sits beside its iOS twin
 * (docs/changes/2026-09-27-twuijri-android-redesign.md). The PNGs go to
 * `apps/android/app/build/shots/<theme>/<locale>/android-NN-<name>.png`; each screen also asserts
 * the element it is about, so a screen that stops drawing fails here.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w440dp-h956dp-xxhdpi", application = ShotsApp::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenShots {
    @get:Rule val compose = createEmptyComposeRule()

    private lateinit var hub: DemoHub
    private val out = File(repoRoot, "apps/android/app/build/shots")

    @Before fun start() {
        hub = DemoHub(ExtraFixtures.answers).start()
    }

    @After fun stop() {
        hub.missed.sorted().forEach { println("demo hub: no answer for $it") }
        hub.stop()
    }

    @Test fun lightEnglish() = shoot(ThemeChoice.LIGHT, AppLanguage.EN)
    @Test fun darkEnglish() = shoot(ThemeChoice.DARK, AppLanguage.EN)
    @Test fun lightArabic() = shoot(ThemeChoice.LIGHT, AppLanguage.AR)
    @Test fun darkArabic() = shoot(ThemeChoice.DARK, AppLanguage.AR)

    private fun shoot(theme: ThemeChoice, language: AppLanguage) {
        val graph = ApplicationProvider.getApplicationContext<android.content.Context>().graph
        graph.prefs.language = language
        graph.prefs.setTheme(theme)
        // The microphone shows as on a phone that can listen (Robolectric has no recognizer).
        graph.device.update { it.copy(voiceSource = VoiceSource.HUB) }
        graph.store.save(
            StoredSession(
                hub = hub.base, kind = TokenKind.APP, accessToken = "demo",
                user = StoredUser("01K5DM00000000000000000001", "sara", "Sara", "owner", listOf("work", "personal"), "work"),
                profile = "work",
            ),
        )
        val dir = File(out, "${theme.name.lowercase()}/${if (language == AppLanguage.AR) "ar-SA" else "en-US"}")
        dir.mkdirs()

        open("/chat/${hub.chatId}") { activity ->
            waitFor("message.agent")
            // The agent's name under the title: the profile's agents have loaded.
            waitFor("topbar.subtitle")
            save(activity, dir, "01-chat")
            // The composer reads as on iOS and the web: «+», the words, the microphone, Send —
            // from the reading start to its end.
            val order = listOf("composer.attach", "composer.input", "composer.dictate", "composer.send").map { left(it) }
            val readingOrder = if (language == AppLanguage.AR) order.reversed() else order
            assertEquals("the composer's order ($order)", readingOrder.sorted(), readingOrder)
            compose.onNodeWithTag("shell.menu").performClick()
            waitFor("chat.row.${hub.chatId}")
            save(activity, dir, "02-chats")
            // The chats list starts in the upper half of the drawer, so most of it is the list.
            val root = compose.onAllNodes(hasTestTag("shell.sidebar"), useUnmergedTree = true).fetchSemanticsNodes().first().boundsInRoot
            val firstRow = compose.onNodeWithTag("chat.row.${hub.chatId}", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertTrue("the first chat row starts at ${firstRow.top} of ${root.height}", firstRow.top < root.height * 0.5f)
            // The profile chip sits in the footer, on the account name's line beside the connection
            // dot (owner, 2026-09-26, DECISIONS §113), not at the top of the drawer.
            val chip = compose.onNodeWithTag("shell.profile", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val dot = compose.onNodeWithTag("shell.connection", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertTrue("the profile chip at ${chip.top} of ${root.height} is in the footer", chip.top > root.height * 0.8f)
            assertTrue("the profile chip ${chip} is on the connection dot's line ${dot}", chip.top < dot.center.y && dot.center.y < chip.bottom)
        }
        open("/new") { activity ->
            waitFor("screen.new_chat")
            compose.onNodeWithTag("shell.menu").performClick()
            waitFor("shell.segment.rooms")
            compose.onNodeWithTag("shell.segment.rooms", useUnmergedTree = true).performClick()
            waitForPrefix("room.row.")
            save(activity, dir, "11-rooms")
            compose.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("a room row") { node ->
                node.config.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.TestTag) { null }?.startsWith("room.row.") == true
            }, useUnmergedTree = true).onFirst().performClick()
            waitFor("room.transcript")
            waitForPrefix("message.")
            save(activity, dir, "12-room")
        }
        open("/agents") { activity ->
            waitFor("agents.list")
            save(activity, dir, "03-agents")
        }
        open("/tasks") { activity ->
            waitFor("tasks.board")
            save(activity, dir, "04-tasks")
        }
        open("/new") { activity ->
            waitFor("screen.new_chat")
            waitForPrefix("chat.agent.")
            save(activity, dir, "05-new-chat")
        }
        open("/settings") { activity ->
            waitFor("settings.list")
            save(activity, dir, "06-settings")
        }
        open("/schedules") { activity ->
            waitFor("schedules.list")
            save(activity, dir, "07-schedules")
        }
        open("/search") { activity ->
            waitFor("screen.search")
            save(activity, dir, "08-search")
        }
        open("/settings/this-device") { activity ->
            waitFor("device.page")
            save(activity, dir, "09-this-device")
        }
        open("/settings/notifications") { activity ->
            waitFor("notices.list")
            waitForPrefix("notice.")
            save(activity, dir, "10-notifications")
        }
        graph.store.save(null)
        open(null) { activity ->
            waitFor("screen.sign_in")
            save(activity, dir, "00-sign-in")
        }
    }

    private fun open(path: String?, block: (Activity) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(context, MainActivity::class.java)
        if (path != null) intent.data = Uri.parse("corehub://open$path")
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            var activity: Activity? = null
            scenario.onActivity { activity = it }
            block(activity!!)
        }
    }

    private fun waitFor(tag: String) {
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        // Let images, fonts and the last frames settle.
        compose.mainClock.advanceTimeBy(600)
        compose.waitForIdle()
    }

    /** Waits for any node whose tag starts with [prefix] (a list's first row). */
    private fun waitForPrefix(prefix: String) {
        compose.waitUntil(10_000) {
            compose.onAllNodes(androidx.compose.ui.test.SemanticsMatcher("tag starts with $prefix") { node ->
                node.config.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.TestTag) { null }?.startsWith(prefix) == true
            }, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.mainClock.advanceTimeBy(600)
        compose.waitForIdle()
    }

    private fun left(tag: String): Float =
        compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.left

    private fun save(activity: Activity, dir: File, name: String) {
        val view = activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(dir, "android-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}

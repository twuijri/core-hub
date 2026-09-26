package hub.core.android.shots

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
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
import hub.core.android.repoRoot
import hub.core.android.ui.theme.ThemeChoice
import org.junit.After
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

    @After fun stop() = hub.stop()

    @Test fun lightEnglish() = shoot(ThemeChoice.LIGHT, AppLanguage.EN)
    @Test fun darkEnglish() = shoot(ThemeChoice.DARK, AppLanguage.EN)
    @Test fun lightArabic() = shoot(ThemeChoice.LIGHT, AppLanguage.AR)
    @Test fun darkArabic() = shoot(ThemeChoice.DARK, AppLanguage.AR)

    private fun shoot(theme: ThemeChoice, language: AppLanguage) {
        val graph = ApplicationProvider.getApplicationContext<android.content.Context>().graph
        graph.prefs.language = language
        graph.prefs.setTheme(theme)
        graph.store.save(
            StoredSession(
                hub = hub.base, kind = TokenKind.DEVICE, accessToken = "demo",
                user = StoredUser("01K5DM00000000000000000001", "sara", "Sara", "owner", listOf("work", "personal"), "work"),
                profile = "work",
            ),
        )
        val dir = File(out, "${theme.name.lowercase()}/${if (language == AppLanguage.AR) "ar-SA" else "en-US"}")
        dir.mkdirs()

        open("/chat/${hub.chatId}") { activity ->
            waitFor("message.agent")
            save(activity, dir, "01-chat")
            compose.onNodeWithTag("shell.menu").performClick()
            waitFor("chat.row.${hub.chatId}")
            save(activity, dir, "02-chats")
        }
        open("/agents") { activity ->
            waitFor("screen.agents")
            save(activity, dir, "03-agents")
        }
        open("/tasks") { activity ->
            waitFor("screen.tasks")
            save(activity, dir, "04-tasks")
        }
        open("/new") { activity ->
            waitFor("screen.new_chat")
            save(activity, dir, "05-new-chat")
        }
        open("/settings") { activity ->
            waitFor("screen.settings")
            save(activity, dir, "06-settings")
        }
        open("/schedules") { activity ->
            waitFor("screen.schedules")
            save(activity, dir, "07-schedules")
        }
        open("/search") { activity ->
            waitFor("screen.search")
            save(activity, dir, "08-search")
        }
        open("/settings/this-device") { activity ->
            waitFor("screen.this_device")
            save(activity, dir, "09-this-device")
        }
        open("/settings/notifications") { activity ->
            waitFor("screen.notifications")
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

    private fun save(activity: Activity, dir: File, name: String) {
        val view = activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(dir, "android-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}

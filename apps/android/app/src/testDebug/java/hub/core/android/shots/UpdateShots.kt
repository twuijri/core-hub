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
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.AppLanguage
import hub.core.android.MainActivity
import hub.core.android.data.StoredSession
import hub.core.android.data.StoredUser
import hub.core.android.data.TokenKind
import hub.core.android.graph
import hub.core.android.phone.AppRelease
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
 * Self-update's notice (SelfUpdateUi.kt) in the app: a newer release found when the app comes to
 * the front shows on New chat and as a row in Settings; Later hides it, This device still offers
 * it. Pictures go to `apps/android/app/build/shots/<theme>/<locale>/android-13-update.png`.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w440dp-h956dp-xxhdpi", application = ShotsApp::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UpdateShots {
    @get:Rule val compose = createEmptyComposeRule()

    private lateinit var hub: DemoHub
    private val out = File(repoRoot, "apps/android/app/build/shots")

    @Before fun start() {
        hub = DemoHub(ExtraFixtures.answers).start()
        ShotsApp.release = AppRelease(
            version = "9.9.9",
            apkName = "Core-Hub-9.9.9-android.apk",
            apkUrl = "https://github.com/twuijri/core-hub/releases/download/v9.9.9/Core-Hub-9.9.9-android.apk",
            size = 31_457_280,
            pageUrl = "https://github.com/twuijri/core-hub/releases/tag/v9.9.9",
        )
    }

    @After fun stop() {
        ShotsApp.release = null
        hub.stop()
    }

    @Test fun lightEnglish() = shoot(ThemeChoice.LIGHT, AppLanguage.EN)
    @Test fun darkArabic() = shoot(ThemeChoice.DARK, AppLanguage.AR)

    private fun shoot(theme: ThemeChoice, language: AppLanguage) {
        val graph = ApplicationProvider.getApplicationContext<android.content.Context>().graph
        graph.prefs.language = language
        graph.prefs.setTheme(theme)
        graph.store.save(
            StoredSession(
                hub = hub.base, kind = TokenKind.APP, accessToken = "demo",
                user = StoredUser("01K5DM00000000000000000001", "sara", "Sara", "owner", listOf("work", "personal"), "work"),
                profile = "work",
            ),
        )
        val dir = File(out, "${theme.name.lowercase()}/${if (language == AppLanguage.AR) "ar-SA" else "en-US"}").apply { mkdirs() }

        open("/new") { activity ->
            // Coming to the front asked the (scripted) releases and found 9.9.9.
            waitFor("update.banner")
            waitFor("screen.new_chat")
            save(activity, dir, "13-update")
            compose.onNodeWithTag("update.later", useUnmergedTree = true).performClick()
            compose.waitForIdle()
            assertEquals(0, compose.onAllNodes(hasTestTag("update.banner"), useUnmergedTree = true).fetchSemanticsNodes().size)
        }
        assertEquals("9.9.9", graph.updates.checker.skipped.value)
        open("/settings") {
            // Still offered in Settings and This device after Later.
            waitFor("settings.update")
        }
        open("/settings/this-device") { activity ->
            waitFor("device.page")
            // The Updates part is the page's last: scroll to it.
            compose.onNodeWithTag("device.page").performScrollToNode(hasTestTag("device.update_check"))
            waitFor("device.updates")
            waitFor("update.now")
            save(activity, dir, "14-update-this-device")
            assertTrue(compose.onAllNodes(hasTestTag("update.later"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        }
    }

    private fun open(path: String, block: (Activity) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(context, MainActivity::class.java).setData(Uri.parse("corehub://open$path"))
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            var activity: Activity? = null
            scenario.onActivity { activity = it }
            block(activity!!)
        }
    }

    private fun waitFor(tag: String) {
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
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

package hub.core.android.shots

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.net.Uri
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
import hub.core.client.api.MetaApi
import hub.core.client.api.SessionsApi
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A reply with a picture it made and a PDF (docs/changes/2026-09-26-twuijri-mobile-open-files.md):
 * the picture drawn in the message from the bytes the (demo) hub serves with the bearer, the PDF a
 * row with its size, and the picture full screen after a tap. Pictures go to
 * `apps/android/app/build/shots/<theme>/<locale>/android-15-files.png` and `-16-picture.png`.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w440dp-h956dp-xxhdpi", application = ShotsApp::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FilesShots {
    @get:Rule val compose = createEmptyComposeRule()

    private lateinit var hub: DemoHub
    private val out = File(repoRoot, "apps/android/app/build/shots")
    private val photo = "01K5DM00000000000000000F01"
    private val pdf = "01K5DM00000000000000000F02"
    private val photoName = "retouch-this-exact-photo-20260926-175416-1.png"
    private val seenBearer = mutableSetOf<String?>()

    private fun contentPath(id: String) =
        MetaApi.defaultBasePath + SessionsApi("").sessionsDownloadAttachmentRequestConfig("work", id, null).path

    /** A picture worth looking at: a warm gradient with a sun, as an agent's edit might be. */
    private fun png(): ByteArray {
        val bitmap = Bitmap.createBitmap(900, 600, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawRect(0f, 0f, 900f, 600f, Paint().apply { shader = LinearGradient(0f, 0f, 0f, 600f, 0xFF3B5BDB.toInt(), 0xFFF08C00.toInt(), Shader.TileMode.CLAMP) })
        canvas.drawCircle(640f, 250f, 110f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFE066.toInt() })
        canvas.drawRect(0f, 470f, 900f, 600f, Paint().apply { color = 0xFF2B8A3E.toInt() })
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    /** The demo conversation, its last reply now carrying the picture, a PDF and a link to the picture. */
    private fun messages(language: String): String {
        val page = Json.parseToJsonElement(hub.answer("$language sessions.listMessages ${hub.chatId}")!!).jsonObject
        val items = page.getValue("items").jsonArray
        val last = items.indexOfLast { it.jsonObject["role"]?.jsonPrimitive?.content == "assistant" }
        val link = if (language == "ar") "[عرض الصورة المعدّلة]($photoName)" else "[See the edited picture]($photoName)"
        val reply = items[last].jsonObject
        val content = JsonArray(
            reply.getValue("content").jsonArray + listOf(
                JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(link))),
                JsonObject(
                    mapOf(
                        "type" to JsonPrimitive("image"), "attachment_id" to JsonPrimitive(photo), "name" to JsonPrimitive(photoName),
                        "mime" to JsonPrimitive("image/png"), "size_bytes" to JsonPrimitive(png().size), "url" to JsonPrimitive(contentPath(photo)),
                    ),
                ),
                JsonObject(
                    mapOf(
                        "type" to JsonPrimitive("file"), "attachment_id" to JsonPrimitive(pdf), "name" to JsonPrimitive("quarterly-report.pdf"),
                        "mime" to JsonPrimitive("application/pdf"), "size_bytes" to JsonPrimitive(248_320), "url" to JsonPrimitive(contentPath(pdf)),
                    ),
                ),
            ),
        )
        val changed = JsonArray(items.mapIndexed { i, item -> if (i == last) JsonObject(reply + ("content" to content)) else item })
        return JsonObject(page + ("items" to changed)).toString()
    }

    @Before fun start() {
        hub = DemoHub(ExtraFixtures.answers).start()
        val listMessages = MetaApi.defaultBasePath + SessionsApi("").sessionsListMessagesRequestConfig("work", hub.chatId, null, null).path
        val picture = png()
        hub.raw = { request ->
            val path = request.requestUrl?.encodedPath
            val language = if (request.getHeader("Accept-Language")?.startsWith("ar") == true) "ar" else "en"
            when (path) {
                contentPath(photo) -> {
                    synchronized(seenBearer) { seenBearer += request.getHeader("Authorization") }
                    MockResponse().setHeader("Content-Type", "image/png")
                        .setHeader("Content-Disposition", "attachment; filename=\"$photoName\"")
                        .setBody(Buffer().write(picture))
                }
                listMessages -> MockResponse().setHeader("Content-Type", "application/json").setBody(messages(language))
                else -> null
            }
        }
    }

    @After fun stop() {
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
        open("/chat/${hub.chatId}") { activity ->
            waitFor("message.image")
            waitFor("message.file")
            // The reply grew when its picture arrived: bring its last file into view.
            compose.onNodeWithTag("message.file", useUnmergedTree = true).performScrollTo()
            compose.waitForIdle()
            save(activity, dir, "15-files")
            assertTrue("the picture came with the bearer header", seenBearer.contains("Bearer demo"))
            compose.onNodeWithTag("message.image", useUnmergedTree = true).performClick()
            waitFor("message.image.viewer")
            // The viewer is a window of its own: drawn from its node, not the activity's.
            val window = org.robolectric.shadows.ShadowDialog.getLatestDialog().window!!.decorView
            val viewer = Bitmap.createBitmap(window.width, window.height, Bitmap.Config.ARGB_8888)
            window.draw(Canvas(viewer))
            File(dir, "android-16-picture.png").outputStream().use { viewer.compress(Bitmap.CompressFormat.PNG, 100, it) }
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

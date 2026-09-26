package hub.core.android.parity

import hub.core.android.data.HubApis
import hub.core.android.ui.screens.AdminRules
import hub.core.android.ui.screens.ModelOps
import hub.core.android.ui.screens.ModelRules
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.ModelRef
import hub.core.client.model.NoticeKind
import hub.core.client.model.NotifyPreferences
import hub.core.client.model.ProviderPreset
import hub.core.client.model.ProviderScope
import hub.core.client.model.UserCreate
import hub.core.client.model.Voice
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Models and the admin pages on the phone (group 5): the rules, and what is sent. */
class ModelsAdminTest {
    private val json = Serializer.kotlinxSerializationJson
    private val a = ModelRef("p1", "gpt-a")
    private val b = ModelRef("p1", "gpt-b")
    private val c = ModelRef("p2", "claude-c")

    @Test fun `fallbacks move by drag, are added once and never repeat the default`() {
        assertEquals(listOf(b, c, a), ModelRules.move(listOf(a, b, c), 0, 2))
        assertEquals(listOf(c, a, b), ModelRules.move(listOf(a, b, c), 2, 0))
        assertEquals(listOf(a, b), ModelRules.add(listOf(a, b), b, null))
        assertEquals(listOf(a), ModelRules.add(listOf(a), c, default = c))
        assertEquals(listOf(a, c), ModelRules.add(listOf(a), c, default = b))
        assertEquals(2, ModelRules.dropIndex(0, 130f, 60f, 3))
        assertEquals(0, ModelRules.dropIndex(2, -400f, 60f, 3))
        assertEquals(1, ModelRules.dropIndex(1, 10f, 60f, 3))
    }

    private fun preset(key: String, signIn: Boolean = false, baseUrl: Boolean = false) = json.decodeFromString(
        ProviderPreset.serializer(),
        """{"id":"openai","label":"OpenAI","kind":"llm","api_mode":"chat_completions","base_url_required":$baseUrl,"key":"$key",
            "local":false,"repeatable":false,"sign_in":$signIn,"base_url":null,"keys_url":null,"base_url_example":null}""",
    )

    @Test fun `adding a provider sends its key only where it takes one, and waits for what it needs`() {
        val keyed = preset("required")
        assertFalse(ModelRules.ready(keyed, " ", ""))
        assertTrue(ModelRules.ready(keyed, "sk-1", ""))
        val body = ModelRules.create(keyed, " sk-1 ", "", ProviderScope.PROFILE)
        assertEquals("sk-1", body.apiKey)
        assertEquals("openai", body.preset)
        assertEquals(ProviderScope.PROFILE, body.scope)
        assertNull(body.baseUrl)
        val signIn = preset("required", signIn = true)
        assertTrue("a sign-in needs no key", ModelRules.ready(signIn, "", ""))
        assertNull(ModelRules.create(signIn, "typed", "", ProviderScope.ALL).apiKey)
        assertFalse(ModelRules.ready(preset("optional", baseUrl = true), "", ""))
    }

    private fun voice(id: String, language: String?) = Voice(id = id, name = id, language = language)

    @Test fun `voices in the person's languages come first, every language stays, a search narrows`() {
        val all = listOf(voice("Zeina", "ar-SA"), voice("Amy", "en-GB"), voice("Hans", "de-DE"), voice("Aria", "en-US"), voice("X", null))
        assertEquals(listOf("Zeina", "Amy", "Aria", "Hans", "X"), ModelRules.voices(all, listOf("ar", "en"), "").map { it.id })
        assertEquals(listOf("Amy", "Aria", "Zeina", "Hans", "X"), ModelRules.voices(all, listOf("en"), "").map { it.id })
        assertEquals(listOf("Hans"), ModelRules.voices(all, listOf("ar"), "de").map { it.id })
        assertEquals("مرحبًا، هذا صوتي في كور هب.", ModelRules.sample("ar-SA", "x"))
        assertEquals("x", ModelRules.sample("ja", "x"))
    }

    @Test fun `a new person is a member of chosen profiles or an admin of all`() {
        assertNull(AdminRules.create("Sara!", "", "12345678", false, listOf("work")))
        assertNull(AdminRules.create("sara", "", "short", false, listOf("work")))
        assertNull("a member needs a profile", AdminRules.create("sara", "", "12345678", false, emptyList()))
        val member = AdminRules.create(" sara ", " سارة ", "12345678", false, listOf("work", "home"))!!
        assertEquals("sara", member.username)
        assertEquals("سارة", member.displayName)
        assertEquals(UserCreate.Role.MEMBER, member.role)
        assertEquals("work", member.defaultProfile)
        val admin = AdminRules.create("omar", "", "12345678", true, emptyList())!!
        assertEquals(UserCreate.Role.ADMIN, admin.role)
        assertNull(admin.profiles)
    }

    @Test fun `every notice kind is a row, a missing one is on in both, and one switch changes one cell`() {
        val prefs = json.decodeFromString(
            NotifyPreferences.serializer(),
            """{"events":{"task_moved":{"in_app":true,"push":false}},"quiet_hours":{"enabled":false,"from":"22:00","to":"07:00","timezone":"Asia/Riyadh"}}""",
        )
        val rows = AdminRules.rows(prefs)
        assertEquals(NoticeKind.entries.size, rows.size)
        assertTrue(rows.first { it.first == NoticeKind.RUN_COMPLETED }.second.push)
        assertFalse(rows.first { it.first == NoticeKind.TASK_MOVED }.second.push)
        val next = AdminRules.set(prefs, NoticeKind.RUN_COMPLETED, push = false)
        assertFalse(next.events.getValue("run_completed").push)
        assertTrue(next.events.getValue("run_completed").inApp)
        assertTrue(AdminRules.timeOk("07:30"))
        assertFalse(AdminRules.timeOk("25:00"))
        assertEquals("12.3K", AdminRules.tokens(12_300))
        assertEquals(33, AdminRules.percent(1, 3))
    }

    // ------------------------------------------------------------------ what is sent

    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()
    private val defaults = """{"default":{"provider_id":"p1","model":"gpt-a"},"image":null,"fallbacks":[],"auxiliary":{"tasks":[],"assignments":{}},"inherited":null}"""
    private val speech = """{"stt":{"ready":false,"providers":[],"active_provider_id":null,"reason":null},"tts":{"ready":true,"providers":[],"active_provider_id":null,"reason":null}}"""

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.requestUrl!!.encodedPath
                val body = when {
                    path.endsWith("/models/defaults") -> defaults
                    path.endsWith("/models/speech") -> speech
                    else -> return MockResponse().setResponseCode(404)
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun ops() = ModelOps({ HubApis(server.url("/").toString().trimEnd('/'), OkHttpClient()) }, "work")

    @Test fun `the fallbacks are saved in their new order, and a voice is kept in the provider's settings`() = runTest {
        assertTrue(ops().setFallbacks(listOf(c, a)).isSuccess)
        val put = requests.last()
        assertEquals("work", put.getHeader("X-Hub-Profile"))
        assertEquals("""{"fallbacks":[{"provider_id":"p2","model":"claude-c"},{"provider_id":"p1","model":"gpt-a"}]}""", put.body.readUtf8())

        assertTrue(ops().setVoice("tts1", "Zeina").isSuccess)
        assertEquals("""{"providers":[{"id":"tts1","settings":{"voice":"Zeina"}}]}""", requests.last().body.readUtf8())
    }
}

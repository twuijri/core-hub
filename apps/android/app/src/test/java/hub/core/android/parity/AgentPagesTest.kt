package hub.core.android.parity

import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.nav.Screens
import hub.core.android.ui.screens.AgentOps
import hub.core.android.ui.screens.ChannelLinks
import hub.core.android.ui.screens.SettingValues
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.ChannelPlatform
import hub.core.client.model.ConfigFile
import hub.core.client.model.MemoryItem
import hub.core.client.model.SettingsField
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
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

/** An agent's pages on Android, editable as on iOS (B14): the rules and the calls, against a scripted hub. */
class AgentPagesTest {
    private val json = Serializer.kotlinxSerializationJson
    private val agent = "01J8QK3ZR2W7M5N4P6T8V9X0AG"

    private fun field(kind: String, min: String = "null", max: String = "null", options: String = "[]", value: String = "null") = json.decodeFromString(
        SettingsField.serializer(),
        """{"key":"k","label":{"ar":"ح","en":"F"},"kind":"$kind","value":$value,"options":$options,"min":$min,"max":$max,"hint":null}""",
    )

    private fun platform(login: String, credentials: String = "[]", allowlist: String? = null) = json.decodeFromString(
        ChannelPlatform.serializer(),
        """{"platform":"p","label":"P","support":"full","login":"$login","credentials":$credentials,
            "allowed_users_key":${allowlist?.let { "\"$it\"" } ?: "null"},"validates":true,"pairs":true,"allowlist":false,
            "settings":false,"exclusive":true,"packages":"none","inbound":false,"program":null,"docs_url":null}""",
    )

    @Test fun `typed settings become the field's kind within its bounds`() {
        assertEquals(JsonPrimitive(40L), SettingValues.parse(field("integer", "1", "500"), "40"))
        assertNull(SettingValues.parse(field("integer", "1", "500"), "600"))
        assertNull(SettingValues.parse(field("integer"), "4.5"))
        assertEquals(JsonPrimitive(0.7), SettingValues.parse(field("number"), "0,7"))
        assertEquals(JsonPrimitive("  hello "), SettingValues.parse(field("text"), "  hello "))
        assertEquals(JsonNull, SettingValues.parse(field("integer"), "  "))
        val choice = field("choice", options = """[{"value":"fast","label":"Fast"}]""")
        assertEquals(JsonPrimitive("fast"), SettingValues.parse(choice, "fast"))
        assertNull(SettingValues.parse(choice, "slow"))
        assertTrue(SettingValues.on(field("toggle", value = "true")))
        assertFalse(SettingValues.editable(field("json")))
        assertTrue(SettingValues.editable(field("secret")))
    }

    @Test fun `token and credential platforms link here, a code is scanned from the web`() {
        assertFalse(ChannelLinks.onPhone(platform("qr")))
        val telegram = platform("token", allowlist = "TELEGRAM_ALLOWED_USERS")
        assertTrue(ChannelLinks.onPhone(telegram))
        assertEquals(listOf("token"), ChannelLinks.fields(telegram).map { it.key })
        assertEquals(listOf("token"), ChannelLinks.missing(telegram, emptyMap()))
        val request = ChannelLinks.request(telegram, mapOf("token" to " 123:abc "), "111, 222")
        assertEquals("123:abc", request.token)
        assertEquals(listOf("111", "222"), request.allowedUsers)
        assertNull(request.credentials)
        val discord = platform(
            "credentials",
            """[{"key":"DISCORD_BOT_TOKEN","kind":"secret","required":true},{"key":"DISCORD_HOME_CHANNEL","kind":"text","required":false}]""",
        )
        assertEquals(listOf("DISCORD_BOT_TOKEN"), ChannelLinks.missing(discord, mapOf("DISCORD_HOME_CHANNEL" to "x")))
        val linked = ChannelLinks.request(discord, mapOf("DISCORD_BOT_TOKEN" to "t", "DISCORD_HOME_CHANNEL" to " "), "9")
        assertEquals(mapOf("DISCORD_BOT_TOKEN" to "t"), linked.credentials)
        assertNull("a platform with no allowlist variable sends none", linked.allowedUsers)
    }

    @Test fun `config files are an agent page for admins with their capability`() {
        assertTrue("agent_config_files" in Screens.agentLevel)
        assertTrue("agent_config_files" in Screens.adminOnly)
        assertEquals(listOf("agent_config_files", "agent_settings"), Screens.agentPages(listOf("config_files"), configurable = true))
    }

    // ------------------------------------------------------------------ the calls, against a scripted hub

    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()

    private fun ok(body: String, status: Int = 200) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    private val skill = """{"key":"web","name":"Web","enabled":false,"pinned":false,"source":"user","use_count":0,"description":null}"""
    private val section = """{"section":{"key":"agent","title":{"ar":"الوكيل","en":"Agent"},"restart_required":false,"fields":[]},"restart_job_id":null}"""
    private fun file(revision: String) = """{"key":"instructions","label":{"ar":"التعليمات","en":"Instructions"},"path":"/data/home/.claude/CLAUDE.md",
        "language":"markdown","exists":true,"size_bytes":5,"revision":"$revision","updated_at":null,"content":"hello"}"""

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.requestUrl!!.encodedPath
                return when {
                    path.endsWith("/skills/web") -> ok(skill.replace("false,\"pinned\"", "true,\"pinned\""))
                    path.endsWith("/agents/$agent/settings") -> ok(section)
                    path.endsWith("/config-files/instructions") && request.method == "PUT" ->
                        if (request.body.peek().readUtf8().contains("\"revision\":\"old\"")) ok("""{"error":"changed","code":"changed"}""", 409)
                        else ok(file("r2"))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun ops() = AgentOps({ HubApis(server.url("/").toString().trimEnd('/'), OkHttpClient()) }, "work", agent)

    @Test fun `a switch and a setting go to the profile the pages edit`() = runTest {
        assertTrue(ops().setSkill("web", true).isSuccess)
        val patch = requests.last()
        assertEquals("PATCH", patch.method)
        assertEquals("work", patch.getHeader("X-Hub-Profile"))
        assertEquals("""{"enabled":true}""", patch.body.readUtf8())

        assertTrue(ops().setSetting("agent", "max_turns", JsonPrimitive(40)).isSuccess)
        val settings = requests.last()
        assertEquals("work", settings.getHeader("X-Hub-Profile"))
        assertEquals("""{"section":"agent","values":{"max_turns":40}}""", settings.body.readUtf8())
    }

    @Test fun `a config file is saved with the revision it was read at, and a stale one is refused`() = runTest {
        val read = json.decodeFromString(ConfigFile.serializer(), file("r1"))
        val saved = ops().saveConfigFile(read, "hello again")
        assertEquals("r2", saved.getOrThrow().revision)
        assertTrue(requests.last().body.readUtf8().contains("\"revision\":\"r1\""))

        val stale = ops().saveConfigFile(read.copy(revision = "old"), "x").exceptionOrNull() as HubError
        assertEquals(409, stale.status)
        assertEquals("changed", stale.code)
    }

    @Test fun `memory is written with its title, tags and revision`() = runTest {
        val item = json.decodeFromString(MemoryItem.serializer(), """{"id":"m1","kind":"entry","title":"T","tags":["a"],"revision":3,"content":"old"}""")
        ops().saveMemory(item, "new")
        val put = requests.last()
        assertEquals("PUT", put.method)
        val body = put.body.readUtf8()
        assertTrue(body, body.contains("\"content\":\"new\"") && body.contains("\"revision\":3") && body.contains("\"title\":\"T\""))
    }
}

package hub.core.android.chat

import hub.core.android.chat.ChatControls.Action
import hub.core.android.data.HubApis
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Agent
import hub.core.client.model.AgentCapability
import hub.core.client.model.Choice
import hub.core.client.model.LocalizedText
import hub.core.client.model.Model
import hub.core.client.model.ModelKind
import hub.core.client.model.Session
import hub.core.client.model.SessionCompression
import hub.core.client.model.SessionPatch
import hub.core.client.model.SettingsField
import hub.core.client.model.SettingsSection
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The chat controls (apps batch 1): what the model and approvals chips offer, a new chat's folder,
 * the chat's own actions, and the calls behind them. iOS ChatControlsTests checks the same rules.
 */
class ChatControlsTest {
    private val server = MockWebServer()
    private val json = Serializer.kotlinxSerializationJson

    @Before fun start() = server.start()

    @After fun stop() = server.shutdown()

    private fun api() = ChatActions(HubApis(server.url("/").toString(), OkHttpClient()))

    private fun ok(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)

    private fun model(
        key: String, alias: String? = null, kind: ModelKind = ModelKind.CHAT, visible: Boolean = true, disabled: Boolean = false,
        imageOnly: Boolean? = null, gateway: Boolean? = null, tools: Boolean? = null, window: Int? = null,
    ) =
        Model(
            key = key, providerId = key.substringBefore('/'), provider = key.substringBefore('/').replaceFirstChar { it.uppercase() },
            model = key.substringAfter('/'), kind = kind, visible = visible, custom = false, preview = false, disabled = disabled,
            capabilities = emptyList(), alias = alias, imageOnly = imageOnly, agentGateway = gateway, agentTools = tools,
            contextWindow = window,
        )

    /** An agent as the hub sends it; [extra] adds `default_model`, `agent_default_model`, `model_source`. */
    private fun agent(kind: String = "acp", extra: String = "") = json.decodeFromString(
        Agent.serializer(),
        """{"id":"A1","profile":"work","owner_id":"u1","created_at":"2026-09-21T10:00:00Z","updated_at":"2026-09-21T10:00:00Z",
            "slug":"gemini-cli","name":"Gemini CLI","kind":"$kind","avatar":{"kind":"generated","url":null,"seed":"g"},"status":"available",
            "enabled":true,"install":{"source":"managed","update_available":false,"newer_than_tested":false,"auto_update":false,
            "auto_update_supported":false},"runtime":{"state":"not_applicable"},"capabilities":[],"sections":[],"limited":false,
            "subagents":"none","vendor":"Google"$extra}""",
    )

    /** The model gateway (ADR 0029, DECISIONS §140–141): the same rules as iOS ChatControlsTests. */
    @Test fun `a coding agent on the hub's models is offered what the gateway serves, and Default names the profile's model`() {
        val catalogue = listOf(model("groq/llama", alias = "Llama", gateway = true), model("openai-codex/gpt-5", gateway = false), model("older/model"))
        val ref = ",\"default_model\":{\"provider_id\":\"p1\",\"model\":\"llama\"},\"agent_default_model\":\"gemini-2.5-pro\""
        val onHub = agent(extra = """$ref,"model_source":"hub"""")
        assertTrue(ChatControls.gatewayOnly(onHub))
        val options = ChatControls.models(catalogue, ChatControls.gatewayOnly(onHub))
        assertEquals(listOf("groq/llama"), options.map { it.value })
        assertEquals("Llama", ChatControls.defaultModelName(onHub, options))
        assertEquals("hub", ChatControls.modelSource(onHub))
        // On its own account: the whole catalogue, and its own settings' model.
        val own = agent(extra = """$ref,"model_source":"agent"""")
        assertFalse(ChatControls.gatewayOnly(own))
        assertEquals(3, ChatControls.models(catalogue, ChatControls.gatewayOnly(own)).size)
        assertEquals("gemini-2.5-pro", ChatControls.defaultModelName(own, options))
        assertEquals("agent", ChatControls.modelSource(own))
        // An older hub says nothing: the whole catalogue, the plain «Default model», no line.
        val older = agent()
        assertFalse(ChatControls.gatewayOnly(older))
        assertNull(ChatControls.defaultModelName(older, options))
        assertNull(ChatControls.modelSource(older))
        // Hermes runs on the profile's default, named by the catalogue.
        val hermes = agent(kind = "hermes", extra = ""","default_model":{"provider_id":"p1","model":"llama"}""")
        assertEquals("Llama", ChatControls.defaultModelName(hermes, options))
        assertNull(ChatControls.defaultModelName(null, options))
    }

    /** Picker quality (§141): no tools, left out; under the agent's context floor, marked; on its own account, neither. */
    @Test fun `the gateway picker leaves out models without tools and marks small ones`() {
        val catalogue = listOf(
            model("openrouter/coder", gateway = true, window = 262_144),
            model("openrouter/no-tools", gateway = true, tools = false, window = 131_072),
            model("openrouter/small", gateway = true, window = 32_768),
            model("ollama/unknown", gateway = true),
        )
        val options = ChatControls.models(catalogue, gatewayOnly = true, minContext = 64_000)
        assertEquals(listOf("openrouter/coder", "openrouter/small", "ollama/unknown"), options.map { it.value })
        assertEquals(listOf(null, 64_000, null), options.map { it.smallUnder })
        val own = ChatControls.models(catalogue, gatewayOnly = false, minContext = 64_000)
        assertEquals(4, own.size)
        assertTrue(own.all { it.smallUnder == null })
    }

    private fun sessionJson(title: String? = "Trip plan", pinned: Boolean = false, archived: Boolean = false, model: String? = null) =
        """{"id":"01J8QK3ZR2W7M5N4P6T8V9X0S1","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-20T10:00:00Z",
           "updated_at":"2026-09-20T10:00:00Z","agent_id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","title":${title?.let { "\"$it\"" }},"source":"chat",
           "origin":null,"channel":null,"model":${model?.let { "\"$it\"" }},"provider":null,"reasoning_effort":null,"working_dir":"/w/trip",
           "pinned":$pinned,"archived":$archived,"category_id":null,"preview":null,"message_count":3,"usage":null,
           "context":null,"status":"idle","active_run_id":null,"parent_session_id":null,"notify":true,
           "last_message_at":null,"match":null}"""

    @Test fun `the model chip offers the visible chat models by their key`() {
        val options = ChatControls.models(
            listOf(
                model("openai/gpt-5", alias = "GPT-5"),
                model("openai/whisper-1", kind = ModelKind.STT),
                model("openai/dall-e", imageOnly = true),
                model("anthropic/claude-hidden", visible = false),
                model("anthropic/claude-off", disabled = true),
                model("anthropic/claude-sonnet"),
            ),
        )
        assertEquals(listOf("openai/gpt-5", "anthropic/claude-sonnet"), options.map { it.value })
        assertEquals(listOf("GPT-5", "claude-sonnet"), options.map { it.label })
        assertEquals(listOf("Openai", "Anthropic"), ChatControls.groups(options).map { it.first })
        assertEquals(listOf("anthropic/claude-sonnet"), ChatControls.filter(options, " SONNET ").map { it.value })
        assertEquals(listOf("openai/gpt-5"), ChatControls.filter(options, "openai").map { it.value })
        assertEquals("GPT-5", ChatControls.modelLabel("openai/gpt-5", options))
        assertEquals("llama-4", ChatControls.modelLabel("groq/llama-4", options))
        assertNull(ChatControls.modelLabel(null, options))
    }

    private fun field(key: String, value: String?, default: String? = null, options: List<String>) = SettingsField(
        key = key, label = LocalizedText("", ""), kind = SettingsField.Kind.CHOICE, `value` = value?.let(::JsonPrimitive),
        options = options.map { Choice(it, it) }, default = default?.let(::JsonPrimitive),
    )

    @Test fun `the approvals chip reads the agent's own field and its default`() {
        val hermes = SettingsSection("approvals", LocalizedText("", ""), false, listOf(field("approvals_mode", null, "smart", listOf("manual", "smart", "off"))))
        val found = ChatControls.approval(listOf(hermes))
        assertEquals("approvals", found?.section)
        assertEquals("approvals_mode", found?.key)
        assertEquals("smart", found?.value)
        val acp = SettingsSection("agent", LocalizedText("", ""), false, listOf(field("approval_mode", "auto_all", options = listOf("ask", "auto_safe", "auto_all"))))
        assertEquals("auto_all", ChatControls.approval(listOf(acp))?.value)
        assertNull(ChatControls.approval(emptyList()))
        assertTrue(ChatControls.risky("off"))
        assertFalse(ChatControls.risky("manual"))
    }

    @Test fun `a new chat's folder is a name under the root or the automatic one`() {
        val root = "/var/lib/corehub/workspaces/work"
        assertEquals("corehub", ChatControls.folderName("$root/corehub", root))
        assertNull(ChatControls.folderName("$root/01J8QK3ZR2W7M5N4P6T8V9X0YA", root))
        assertNull(ChatControls.folderName(null, root))
        assertEquals("reports", ChatControls.folderName("reports", root))
        assertEquals("reports", ChatControls.newFolder("  reports "))
        assertNull(ChatControls.newFolder("a/b"))
        assertNull(ChatControls.newFolder(".."))
        assertNull(ChatControls.newFolder("   "))
    }

    @Test fun `the chat's menu offers what this chat can do`() {
        assertEquals(
            listOf(Action.RENAME, Action.PIN, Action.ARCHIVE, Action.FORK, Action.COMPRESS, Action.EXPORT, Action.DELETE),
            ChatControls.actions(pinned = false, archived = false, globalAgent = false, canCompress = true),
        )
        assertEquals(
            listOf(Action.RENAME, Action.UNPIN, Action.UNARCHIVE, Action.FORK, Action.EXPORT, Action.DELETE),
            ChatControls.actions(pinned = true, archived = true, globalAgent = false, canCompress = false),
        )
        assertEquals(listOf(Action.COMPRESS, Action.EXPORT), ChatControls.actions(pinned = false, archived = false, globalAgent = true, canCompress = true))
        assertEquals(SessionPatch(pinned = true), ChatControls.patch(Action.PIN))
        assertEquals(SessionPatch(archived = false), ChatControls.patch(Action.UNARCHIVE))
        assertNull(ChatControls.patch(Action.RENAME))
        assertEquals("Trip plan", ChatControls.renameTitle("  Trip plan  "))
        assertNull(ChatControls.renameTitle("   "))
        assertEquals(200, ChatControls.renameTitle("a".repeat(250))?.length)
    }

    @Test fun `default model and automatic naming send an explicit null, and nothing else does`() = runTest {
        // Contract decision §114: an optional nullable field goes out as `null` only when listed in `sendNull`.
        val sent = mutableListOf<String>()
        suspend fun send(patch: SessionPatch) {
            server.enqueue(ok(sessionJson()))
            api().update("01J8QK3ZR2W7M5N4P6T8V9X0S1", "work", patch)
            val request = server.takeRequest()
            assertEquals("PATCH", request.method)
            sent += request.body.readUtf8()
        }
        send(ChatControls.modelPatch(null))
        send(ChatControls.patch(Action.AUTO_TITLE)!!)
        send(ChatControls.modelPatch("openai/gpt-5"))
        send(SessionPatch(pinned = true))
        send(SessionPatch(title = "Kept", sendNull = setOf(SessionPatch.Clearable.TITLE)))
        assertEquals(
            listOf(
                """{"model":null}""",
                """{"title":null}""",
                """{"model":"openai/gpt-5"}""",
                """{"pinned":true}""",
                """{"title":"Kept"}""",
            ),
            sent,
        )
        assertEquals(
            listOf(Action.RENAME, Action.AUTO_TITLE, Action.PIN, Action.ARCHIVE, Action.FORK, Action.EXPORT, Action.DELETE),
            ChatControls.actions(pinned = false, archived = false, globalAgent = false, canCompress = false, titled = true),
        )
        assertFalse(Action.AUTO_TITLE in ChatControls.actions(pinned = false, archived = false, globalAgent = true, canCompress = false, titled = true))
    }

    @Test fun `compressing and steering say what happened`() {
        assertEquals(
            ChatControls.Compression.Compressed(90000, 12000),
            ChatControls.compression(SessionCompression(SessionCompression.Status.COMPRESSED, beforeTokens = 90000, afterTokens = 12000)),
        )
        assertEquals(ChatControls.Compression.Skipped, ChatControls.compression(SessionCompression(SessionCompression.Status.SKIPPED)))
        assertTrue(ChatControls.canSteer(true, "focus on tests", listOf(AgentCapability.STEER)))
        assertFalse(ChatControls.canSteer(false, "focus on tests", listOf(AgentCapability.STEER)))
        assertFalse(ChatControls.canSteer(true, "  ", listOf(AgentCapability.STEER)))
        assertFalse(ChatControls.canSteer(true, "focus", listOf(AgentCapability.COMPRESS)))
    }

    @Test fun `pinning sends only what it changes, and the answer shows on the open chat`() = runTest {
        server.enqueue(ok(sessionJson(pinned = true)))
        val updated = api().update("01J8QK3ZR2W7M5N4P6T8V9X0S1", "work", ChatControls.patch(ChatControls.Action.PIN)!!)
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("work", request.getHeader("X-Hub-Profile"))
        // A merge-patch: a title that is not sent is not cleared.
        assertEquals(mapOf("pinned" to "true"), json.parseToJsonElement(request.body.readUtf8()).jsonObject.mapValues { it.value.jsonPrimitive.content })
        val state = ChatReducer.absorb(ChatState(), updated)
        assertEquals("Trip plan", state.session?.title)
        assertTrue(state.session!!.pinned)
        assertEquals("/w/trip", state.session!!.workingDir)
        val other = json.decodeFromString(Session.serializer(), sessionJson().replace("X0S1", "X0S2"))
        assertEquals(state, ChatReducer.absorb(state, other))
    }

    @Test fun `a fork from a message names it, and steering and compressing reach the hub`() = runTest {
        server.enqueue(ok(sessionJson(title = "Trip plan (fork)")))
        val fork = api().fork("01J8QK3ZR2W7M5N4P6T8V9X0S1", "work", "01J8QK3ZR2W7M5N4P6T8V9X0M9")
        assertEquals("Trip plan (fork)", fork.title)
        val forkRequest = server.takeRequest()
        assertEquals("POST", forkRequest.method)
        assertTrue(forkRequest.path!!.endsWith("/fork"))
        assertEquals("01J8QK3ZR2W7M5N4P6T8V9X0M9", json.parseToJsonElement(forkRequest.body.readUtf8()).jsonObject["at_message_id"]?.jsonPrimitive?.content)

        server.enqueue(ok("""{"status":"queued"}"""))
        val steer = api().steer("01J8QK3ZR2W7M5N4P6T8V9X0S1", "work", "01J8QK3ZR2W7M5N4P6T8V9X0R1", "focus on the tests")
        assertEquals(hub.core.client.model.RunSteerResult.Status.QUEUED, steer.status)
        val steerRequest = server.takeRequest()
        assertTrue(steerRequest.path!!.endsWith("/steer"))
        assertEquals("focus on the tests", json.parseToJsonElement(steerRequest.body.readUtf8()).jsonObject["text"]?.jsonPrimitive?.content)

        server.enqueue(ok("""{"status":"compressed","before_tokens":90000,"after_tokens":12000,"before_messages":40,"after_messages":6,"context":null,"message":null}"""))
        val compressed = api().compress("01J8QK3ZR2W7M5N4P6T8V9X0S1", "work")
        assertEquals(ChatControls.Compression.Compressed(90000, 12000), ChatControls.compression(compressed))
        assertTrue(server.takeRequest().path!!.endsWith("/compress"))
    }

    @Test fun `the catalogue is read to its last page and the approval mode is written in its own section`() = runTest {
        val gpt = """{"key":"openai/gpt-5","provider_id":"openai","provider":"OpenAI","model":"gpt-5","alias":"GPT-5","kind":"chat","visible":true,"custom":false,"preview":false,"disabled":false,"capabilities":[]}"""
        val sonnet = gpt.replace("openai/gpt-5", "anthropic/claude-sonnet").replace("\"GPT-5\"", "null")
        server.enqueue(ok("""{"items":[$gpt],"next_cursor":"page2"}"""))
        server.enqueue(ok("""{"items":[$sonnet],"next_cursor":null}"""))
        val options = api().catalogue("work")
        assertEquals(listOf("openai/gpt-5", "anthropic/claude-sonnet"), options.map { it.value })
        server.takeRequest()
        assertEquals("page2", server.takeRequest().requestUrl?.queryParameter("cursor"))

        server.enqueue(ok("""{"section":{"key":"approvals","title":{"ar":"","en":""},"restart_required":false,"fields":[]},"restart_job_id":null}"""))
        val field = ChatControls.ApprovalField("approvals", "approvals_mode", "smart", listOf(Choice("manual", "manual"), Choice("off", "off")))
        api().setApproval("work", "01J8QK3ZR2W7M5N4P6T8V9X0AG", field, "manual")
        val body = json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("approvals", body["section"]?.jsonPrimitive?.content)
        assertEquals("manual", body["values"]?.jsonObject?.get("approvals_mode")?.jsonPrimitive?.content)
    }
}

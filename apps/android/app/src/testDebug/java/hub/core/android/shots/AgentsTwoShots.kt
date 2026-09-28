package hub.core.android.shots

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.repoRoot
import hub.core.android.ui.screens.ChannelCard
import hub.core.android.ui.screens.ChannelRules
import hub.core.android.ui.screens.ChannelSettingsBody
import hub.core.android.ui.screens.GatewayNote
import hub.core.android.ui.screens.HubToolsView
import hub.core.android.ui.screens.McpEditorBody
import hub.core.android.ui.screens.McpServerRow
import hub.core.android.ui.screens.McpTest
import hub.core.android.ui.screens.PendingWriteRow
import hub.core.android.ui.screens.WebhookRow
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.ThemeChoice
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Channel
import hub.core.client.model.ChannelGateway
import hub.core.client.model.ChannelSetting
import hub.core.client.model.HermesWebhook
import hub.core.client.model.HubTools
import hub.core.client.model.McpServer
import hub.core.client.model.McpTestResult
import hub.core.client.model.PendingWrite
import java.io.File
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Agents II (apps batch 9): the hub's tools card, an MCP server with a test's tools, the server editor,
 * a pending write; then two channel cards, the gateway line, a channel's settings and a webhook — drawn
 * to `apps/android/app/build/shots/agents/android-mcp.png` and `android-channels.png`.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w440dp-h1600dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentsTwoShots {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val out = File(repoRoot, "apps/android/app/build/shots/agents").apply { mkdirs() }
    private val json = Serializer.kotlinxSerializationJson

    private val github = json.decodeFromString(
        McpServer.serializer(),
        """{"name":"github","transport":"stdio","enabled":true,"connected":false,"tools":[{"name":"search_issues"},{"name":"create_issue"}],"error":null,
            "config":{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"[stored]"},"timeout":30},"updated_at":"2026-09-21T11:45:00Z"}""",
    )
    private val tested = json.decodeFromString(McpTestResult.serializer(), """{"ok":true,"tools":[{"name":"search_issues"},{"name":"create_issue"},{"name":"list_prs"}],"error":null,"duration_ms":820}""")
    private val hubTools = json.decodeFromString(
        HubTools.serializer(),
        """{"enabled":true,"available":true,"server_name":"corehub","url":"http://hub:3000/hub-mcp","updated_at":"2026-09-21T11:45:00Z",
            "groups":[{"id":"tasks","enabled":true,"allow_writes":false,"tools":[{"name":"tasks.list","access":"read"},{"name":"tasks.create","access":"write"}]},
                      {"id":"notifications","enabled":false,"allow_writes":false,"tools":[{"name":"notify.send","access":"write"}]}],
            "recent_calls":[{"id":"01J8QK3ZR2W7M5N4P6T8V9X0C1","tool":"tasks.list","ok":true,"duration_ms":12,"created_at":"2026-09-27T09:12:00Z"},
                            {"id":"01J8QK3ZR2W7M5N4P6T8V9X0C2","tool":"tasks.create","ok":false,"duration_ms":4,"created_at":"2026-09-27T09:13:00Z","error_code":"hub_tools_group_chat"}]}""",
    )
    private val write = json.decodeFromString(
        PendingWrite.serializer(),
        """{"id":"w1","kind":"memory","action":"add","summary":"Remember the weekly report goes out on Sundays","origin":"background_review","target":"memory",
            "created_at":"2026-09-27T08:00:00Z","content":"التقرير الأسبوعي يُرسل يوم الأحد."}""",
    )

    private fun channel(body: String) = json.decodeFromString(Channel.serializer(), body)
    private val whatsapp = channel(
        """{"platform":"whatsapp","label":"WhatsApp","enabled":true,"configured":true,"exclusive":true,"status":"offline","restart_needed":true,"fields":[],"error":null,
            "login":"qr","link":{"linked":true,"account_name":"Office","account_phone":"966500000000","mode":"self-chat","reply_title":"Office"}}""",
    )
    private val telegram = channel(
        """{"platform":"telegram","label":"Telegram","enabled":true,"configured":true,"exclusive":true,"status":"online","restart_needed":false,"fields":[],"error":null,
            "login":"token","link":{"linked":true,"account_name":"Office bot","account_username":"office_bot"}}""",
    )
    private val gateway = json.decodeFromString(ChannelGateway.serializer(), """{"profile":"work","state":"running","applies":"now"}""")
    private val options = listOf(
        """{"key":"allowed_users","section":"access","kind":"list","value":["1234567"],"default":[],"shared":false}""",
        """{"key":"unauthorized_dm_behavior","section":"access","kind":"select","value":null,"default":"pair","shared":false,"choices":["pair","ignore"]}""",
        """{"key":"show_reasoning","section":"replies","kind":"toggle","value":true,"default":false,"shared":false}""",
        """{"key":"stt_enabled","section":"media","kind":"toggle","value":null,"default":true,"shared":true}""",
    ).map { json.decodeFromString(ChannelSetting.serializer(), it) }
    private val hook = json.decodeFromString(
        HermesWebhook.serializer(),
        """{"name":"github-issues","prompt":"A new issue was opened: {issue.title}","events":["issues"],"deliver":"telegram","path":"/webhooks/01J8/github-issues","static":false,"secret":"s3cr3t"}""",
    )

    private fun shoot(name: String) {
        val view = compose.activity.window.decorView
        val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bitmap))
        File(out, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun mcpServersHubToolsEditorAndPendingWrite() {
        var deleted = false
        var edited = 0
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                Column(
                    Modifier.fillMaxSize().background(LocalTokens.current.bg).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    HubToolsView(hubTools, busy = false, error = null, test = null, testing = false, onSwitch = {}, onGroup = { _, _, _ -> }, onTest = {})
                    McpServerRow(github, McpTest(result = tested), testing = false, onSwitch = {}, onEdit = { edited += 1 }, onTest = {}, onDelete = { deleted = true })
                    PendingWriteRow(write, busy = false) {}
                    McpEditorBody(github, onDismiss = {}, onSave = { _, _, _ -> Result.success(Unit) })
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("hub.group.tasks.writes").assertIsDisplayed()
        compose.onNodeWithTag("mcp.github.result", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("mcp.editor.env.0.value").assertExists()
        shoot("android-mcp.png")
        compose.onNodeWithTag("mcp.editor.env.add").performClick()
        compose.onNodeWithTag("mcp.editor.env.1.key").performTextInput("MODE")
        compose.waitForIdle()
        assertEquals(false, deleted)
        // The header folds the row and opens nothing else; Edit is its own button (owner, 2026-09-28).
        compose.onNodeWithTag("mcp.github.header").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("mcp.github.result", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("mcp.github.header").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("mcp.github.result", useUnmergedTree = true).assertExists()
        assertEquals(0, edited)
        compose.onNodeWithTag("mcp.github.edit").performClick()
        compose.waitForIdle()
        assertEquals(1, edited)
    }

    @Test fun channelCardsSettingsAndWebhook() {
        val chosen = mutableListOf<ChannelRules.Action>()
        compose.setContent {
            CoreHubTheme(ThemeChoice.LIGHT) {
                val draft = remember { mutableStateMapOf<String, JsonElement>() }
                Column(
                    Modifier.fillMaxSize().background(LocalTokens.current.bg).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    GatewayNote(gateway)
                    ChannelCard(whatsapp, null, waiting = 2, canRestart = true, restarting = false, busy = false, onSwitch = {}, onRestart = {}, onAction = { chosen += it })
                    ChannelCard(telegram, null, waiting = 0, canRestart = true, restarting = false, busy = false, onSwitch = {}, onRestart = {}, onAction = { chosen += it })
                    WebhookRow(hook, "https://hub.example/webhooks/01J8/github-issues", null, testing = false, onTest = {}, onDelete = {})
                    ChannelSettingsBody("telegram", options, draft, gateway, saved = false, error = null, saving = false, onChange = { k, v -> draft[k] = v }, onDiscard = {}, onSave = {})
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("channel.whatsapp.restart").assertIsDisplayed()
        compose.onNodeWithTag("channel.whatsapp.waiting").assertIsDisplayed()
        compose.onNodeWithTag("channel.settings.access").assertIsDisplayed()
        shoot("android-channels.png")
        compose.onNodeWithTag("channel.whatsapp.mode").performClick()
        compose.onNodeWithTag("channel.telegram.settings").performClick()
        compose.waitForIdle()
        assertEquals(listOf(ChannelRules.Action.MODE, ChannelRules.Action.SETTINGS), chosen)
    }
}

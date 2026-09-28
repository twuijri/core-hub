package hub.core.android.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.McpOAuthFlow
import hub.core.client.model.McpOAuthState
import hub.core.client.model.McpServer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/*
 * Signing a remote MCP server in by OAuth on its row (DECISIONS §122), as the web's MCP page does: the
 * server's sign-in state in this profile, and Connect / Reconnect, which has Hermes start its own browser
 * sign-in through the hub, opens the provider's page in the system browser and asks the hub every two
 * seconds until Hermes says how it went. The provider sends the browser back to the hub, not to the app.
 * Nothing here holds a token. iOS's McpOAuthRow.swift is its twin.
 */

internal object McpOAuthRules {
    /**
     * Whether the row offers a sign-in: a remote server from a hub that reports it, that signs in by OAuth
     * already or carries no credential of its own in `headers` (Hermes refuses those).
     */
    fun offers(server: McpServer): Boolean {
        val oauth = server.oauth ?: return false
        if (server.transport == McpServer.Transport.STDIO) return false
        val hasHeaders = (server.config["headers"] as? JsonObject)?.isNotEmpty() == true
        return oauth.required || oauth.status != McpOAuthState.Status.NOT_CONNECTED || !hasHeaders
    }

    /**
     * A row that starts open (owner, 2026-09-28): Hermes reported an error for it, or its sign-in ran
     * out, went unreadable, or was never made for a server that requires one. The web's rule.
     */
    fun needsAttention(server: McpServer): Boolean {
        if (server.error != null) return true
        val oauth = server.oauth ?: return false
        if (!offers(server)) return false
        return when (oauth.status) {
            McpOAuthState.Status.CONNECTED -> false
            McpOAuthState.Status.NOT_CONNECTED -> oauth.required
            else -> true
        }
    }

    fun statusText(status: McpOAuthState.Status): Int = when (status) {
        McpOAuthState.Status.CONNECTED -> R.string.mcp_oauth_connected
        McpOAuthState.Status.EXPIRED -> R.string.mcp_oauth_expired_status
        McpOAuthState.Status.NOT_CONNECTED -> R.string.mcp_oauth_not_connected
        McpOAuthState.Status.ERROR -> R.string.mcp_oauth_error
    }
}

@Composable
internal fun McpOAuthRow(ops: AgentsTwoOps, server: McpServer, onChanged: () -> Unit, expanded: Boolean = true) {
    val state = server.oauth ?: return
    if (!McpOAuthRules.offers(server)) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var flow by remember(server.name) { mutableStateOf<McpOAuthFlow?>(null) }
    var starting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<HubError?>(null) }
    val open = { url: String -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
    // While the sign-in waits, the hub is asked again every two seconds; once it ended, the list is read again.
    LaunchedEffect(flow?.id) {
        while (true) {
            val current = flow ?: break
            if (current.status != McpOAuthFlow.Status.PENDING) break
            delay(2000)
            ops.mcpOAuthFlow(server.name, current.id)
                .onSuccess { next ->
                    flow = next
                    error = null
                    if (next.status != McpOAuthFlow.Status.PENDING) onChanged()
                }
                .onFailure { error = it as HubError }
        }
    }
    Column(Modifier.testTag("mcp.${server.name}.oauth"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (state.required || state.status != McpOAuthState.Status.NOT_CONNECTED) {
                Badge(
                    stringResource(McpOAuthRules.statusText(state.status)),
                    tone = when (state.status) {
                        McpOAuthState.Status.CONNECTED -> BadgeTone.Success
                        McpOAuthState.Status.EXPIRED -> BadgeTone.Warning
                        McpOAuthState.Status.ERROR -> BadgeTone.Danger
                        McpOAuthState.Status.NOT_CONNECTED -> BadgeTone.Neutral
                    },
                    dot = true,
                )
            }
            if (expanded && flow?.status != McpOAuthFlow.Status.PENDING) {
                HubButton(
                    stringResource(if (state.status == McpOAuthState.Status.NOT_CONNECTED) R.string.mcp_oauth_connect else R.string.mcp_oauth_reconnect),
                    {
                        starting = true
                        error = null
                        scope.launch {
                            ops.startMcpOAuth(server.name)
                                .onSuccess { started ->
                                    flow = started
                                    val link = started.authorizationUrl
                                    if (started.status == McpOAuthFlow.Status.PENDING && link != null) open(link)
                                }
                                .onFailure { error = it as HubError }
                            starting = false
                        }
                    },
                    kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.KeyRound, loading = starting,
                    modifier = Modifier.testTag("mcp.${server.name}.oauth.connect"),
                )
            }
        }
        // Folded, the row shows only the badge: Connect / Reconnect and the sign-in's progress are under
        // it, out of reach of a stray tap. The polling above keeps running either way.
        if (expanded) {
            Text(stringResource(R.string.mcp_oauth_per_profile), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            ErrorNotice(error)
            flow?.let { current ->
                when (current.status) {
                    McpOAuthFlow.Status.PENDING -> {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Spinner(14.dp)
                            Text(stringResource(R.string.mcp_oauth_waiting), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                        }
                        current.authorizationUrl?.let { link ->
                            HubButton(stringResource(R.string.mcp_oauth_open_page), { open(link) }, kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.ExternalLink)
                        }
                    }
                    McpOAuthFlow.Status.APPROVED -> NoticeBox(
                        stringResource(R.string.mcp_oauth_approved, current.tools.size.toString()), BadgeTone.Success,
                        Modifier.testTag("mcp.${server.name}.oauth.approved"),
                    )
                    else -> NoticeBox(
                        stringResource(
                            when (current.status) {
                                McpOAuthFlow.Status.CANCELLED -> R.string.mcp_oauth_cancelled
                                McpOAuthFlow.Status.EXPIRED -> R.string.mcp_oauth_expired
                                else -> R.string.mcp_oauth_failed
                            },
                        ) + (current.error?.let { " $it" } ?: ""),
                        BadgeTone.Danger,
                    )
                }
            }
        }
    }
}

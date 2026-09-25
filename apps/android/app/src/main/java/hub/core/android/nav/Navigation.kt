package hub.core.android.nav

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf

/**
 * Where the app can be. Every route names the `navigation.json` destination it shows
 * ([destination]); the parity test (NavigationParityTest) checks the registry below against the
 * manifest, so a screen cannot exist without a destination nor a destination without a screen.
 */
sealed interface Route {
    val destination: String

    data object NewChat : Route { override val destination = "new_chat" }
    data class Chat(val sessionId: String, val profile: String) : Route { override val destination = "chat" }
    data object Search : Route { override val destination = "search" }
    data object Agents : Route { override val destination = "agent_manager" }
    data object Tasks : Route { override val destination = "tasks" }
    data object Schedules : Route { override val destination = "schedules" }
    data object Settings : Route { override val destination = "settings" }
    /** The person's one standing conversation in a profile (null: the selector's). */
    data class GlobalAgent(val profile: String? = null) : Route { override val destination = "global_agent" }

    /** A page opened from the Settings list: a tab, a management page or a tool. */
    data class SettingsPage(override val destination: String) : Route

    /** One of an agent's own pages (`agentLevel`), entered from its card on Agents. */
    data class AgentPage(override val destination: String, val agentId: String, val agentName: String) : Route
}

/** The screens this client has, by destination id — what the parity test compares with the manifest. */
object Screens {
    /**
     * Destinations reached as their own [Route] object, plus the drawer's two segment lists:
     * `chat` (the chats list; a conversation is [Route.Chat]) and `rooms`, which switch the
     * list under the segments and leave the drawer open (NAVIGATION.md §1).
     */
    val top = listOf(
        Route.NewChat, Route.Search, Route.Agents, Route.Tasks, Route.Schedules, Route.Settings, Route.GlobalAgent(),
    ).map { it.destination } + listOf("chat", "rooms")

    /** The Settings list, in the manifest's order, as the phone's Settings page draws it. */
    val settingsTabs = listOf("account", "users", "webhooks", "display", "notifications", "privacy", "this_device", "about")
    val settingsManagement = listOf("models", "device_connections", "knowledge")
    val settingsTools = listOf("logs", "usage", "performance", "theme", "workspaces", "updates", "plugins")

    /** An agent's pages, in order; each shows only when the adapter declares its capability. */
    val agentLevel = listOf(
        "agent_skills", "agent_mcp", "agent_memory", "agent_jobs", "agent_channels", "agent_plugins", "agent_settings",
    )

    /** The drawer's primary rows (the manifest's `rail`), segments and footer. */
    val rail = listOf("new_chat", "search", "agent_manager", "tasks", "schedules")
    val segments = listOf("chat", "rooms")
    val footer = listOf("settings")

    /** Screens shown before anyone is signed in; not destinations (`preAuth`). */
    val preAuth = listOf("login", "setup")

    /** Every destination this client can show. */
    val all: Set<String> get() = (top + settingsTabs + settingsManagement + settingsTools + agentLevel).toSet()

    /** Destinations only an owner or admin sees (`roles: ["admin"]`). */
    val adminOnly = setOf("agent_manager", "users", "webhooks", "performance", "workspaces", "updates", "plugins") + agentLevel

    /** The capability an agent page needs (`agent_settings` is shown for every installed agent). */
    val capabilityOf = mapOf(
        "agent_skills" to "skills", "agent_mcp" to "mcp", "agent_memory" to "memory", "agent_jobs" to "jobs",
        "agent_channels" to "channels", "agent_plugins" to "plugins", "agent_settings" to "settings",
    )

    /**
     * The agent pages an agent with these capabilities shows, in order; Settings last for an
     * agent that can be configured (one that is installed), whatever it declares.
     */
    fun agentPages(capabilities: Collection<String>, configurable: Boolean): List<String> =
        agentLevel.filter { if (it == "agent_settings") configurable else capabilityOf.getValue(it) in capabilities }

    /** A drawer or Settings entry is visible to this person. */
    fun visible(destination: String, isAdmin: Boolean): Boolean = isAdmin || destination !in adminOnly
}

/**
 * A back stack. The root is always the new-chat draft or a conversation; everything else is
 * pushed on top and Back returns through it, the way the web's history does.
 */
@Stable
class Navigator(start: Route = Route.NewChat) {
    val stack = mutableStateListOf(start)
    val current: Route get() = stack.last()

    /** Opens a route; a destination already on the stack is brought back rather than stacked twice. */
    fun go(route: Route) {
        if (current == route) return
        if (route is Route.NewChat || route is Route.Chat) {
            stack.clear()
            stack.add(route)
            return
        }
        stack.removeAll { it == route }
        stack.add(route)
    }

    fun back(): Boolean {
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        return true
    }

    /** The route Settings' "back to chats" row returns to: the last conversation or the draft. */
    fun backToChats() {
        val chat = stack.lastOrNull { it is Route.Chat || it is Route.NewChat } ?: Route.NewChat
        stack.clear()
        stack.add(chat)
    }
}

package hub.core.android.nav

import hub.core.android.generated.SurfaceRoutes

/** A path inside the app, resolved: the destination it names, its parameters and its query. */
data class PathTarget(val destination: String, val params: Map<String, String>, val query: Map<String, String>)

/**
 * The app's paths are `surfaceRoutes.android` in navigation.json — the web's paths plus This
 * device — so a `corehub://open/<path>` link and a web link name the same page.
 */
object AppPaths {
    private data class Pattern(val destination: String, val regex: Regex, val names: List<String>)

    private val patterns: List<Pattern> = SurfaceRoutes.android.map { (id, route) -> compile(id, route) }
        // Literal paths before parameterised ones (`/settings/users` before `/settings/:x`).
        .sortedBy { it.names.size }

    private fun compile(id: String, route: String): Pattern {
        val names = mutableListOf<String>()
        val body = route.trim('/').split('/').joinToString("") { segment ->
            when {
                segment.startsWith(':') && segment.endsWith('?') -> {
                    names += segment.substring(1, segment.length - 1)
                    "(?:/([^/]+))?"
                }
                segment.startsWith(':') -> {
                    names += segment.substring(1)
                    "/([^/]+)"
                }
                else -> "/" + Regex.escape(segment)
            }
        }
        return Pattern(id, Regex("^$body/?$"), names)
    }

    fun resolve(path: String): PathTarget? {
        val bare = path.substringBefore('?')
        val query = path.substringAfter('?', "").split('&').filter { '=' in it }
            .associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        for (p in patterns) {
            val match = p.regex.matchEntire(bare) ?: continue
            val params = p.names.zip(match.groupValues.drop(1)).filter { it.second.isNotEmpty() }.toMap()
            return PathTarget(p.destination, params, query)
        }
        return null
    }

    /**
     * The route a path opens. `profile` is where an item without `?profile=` opens (the top
     * selector's). A chats-list path without a conversation opens the new-chat draft.
     */
    fun route(target: PathTarget, profile: String): Route? {
        val itemProfile = target.query["profile"] ?: profile
        return when (target.destination) {
            "new_chat" -> Route.NewChat
            "chat" -> target.params["sessionId"]?.let { Route.Chat(it, itemProfile) } ?: Route.NewChat
            "rooms" -> target.params["roomId"]?.let { Route.Room(it, itemProfile) } ?: Route.NewChat
            "search" -> Route.Search
            "agent_manager" -> Route.Agents
            "tasks" -> Route.Tasks
            "schedules" -> Route.Schedules
            "settings" -> Route.Settings
            "global_agent" -> Route.GlobalAgent(target.query["profile"])
            in Screens.agentLevel -> target.params["agentId"]?.let { Route.AgentPage(target.destination, it, "") }
            in Screens.settingsTabs, in Screens.settingsManagement, in Screens.settingsTools -> Route.SettingsPage(target.destination)
            else -> null
        }
    }

    /** The web page of a destination on this hub, for the pages the phone hands to the browser. */
    fun webUrl(hub: String, destination: String): String? = SurfaceRoutes.web[destination]?.let { hub + it }
}

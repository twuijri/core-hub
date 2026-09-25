package hub.core.android.nav

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppPathsTest {
    @Test fun `a conversation opens in the profile its link names, else the selector's`() {
        val id = "01J8QK3ZR2W7M5N4P6T8V9X0YA"
        assertEquals(Route.Chat(id, "work"), AppPaths.route(AppPaths.resolve("/chat/$id?profile=work")!!, "default"))
        assertEquals(Route.Chat(id, "default"), AppPaths.route(AppPaths.resolve("/chat/$id")!!, "default"))
        assertEquals(Route.NewChat, AppPaths.route(AppPaths.resolve("/chat")!!, "default"))
    }

    @Test fun `settings and agent pages keep their parameters`() {
        assertEquals(Route.SettingsPage("device_connections"), AppPaths.route(AppPaths.resolve("/settings/devices")!!, "p"))
        assertEquals(Route.SettingsPage("this_device"), AppPaths.route(AppPaths.resolve("/settings/this-device")!!, "p"))
        assertEquals(Route.AgentPage("agent_memory", "AG", ""), AppPaths.route(AppPaths.resolve("/agents/AG/memory")!!, "p"))
        assertEquals(Route.Settings, AppPaths.route(AppPaths.resolve("/settings/")!!, "p"))
    }

    @Test fun `an unknown path opens nothing`() {
        assertNull(AppPaths.resolve("/nowhere"))
        assertNull(AppPaths.resolve("/settings/agents/x"))
        assertEquals("https://hub.io/settings/models", AppPaths.webUrl("https://hub.io", "models"))
        assertNull(AppPaths.webUrl("https://hub.io", "this_device"))
    }

    @Test fun `the back stack keeps one chat at its root`() {
        val nav = Navigator()
        nav.go(Route.Tasks)
        nav.go(Route.Settings)
        nav.go(Route.Tasks)
        assertEquals(listOf(Route.NewChat, Route.Settings, Route.Tasks), nav.stack.toList())
        nav.go(Route.Chat("S", "p"))
        assertEquals(listOf<Route>(Route.Chat("S", "p")), nav.stack.toList())
        nav.go(Route.Settings)
        nav.go(Route.SettingsPage("about"))
        nav.backToChats()
        assertEquals(listOf<Route>(Route.Chat("S", "p")), nav.stack.toList())
    }
}

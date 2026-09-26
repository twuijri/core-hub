package hub.core.android.nav

import hub.core.android.generated.SurfaceRoutes
import hub.core.android.generated.Terms
import hub.core.android.ui.screens.SearchHits
import hub.core.android.ui.screens.SettingsList
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android client against docs/clients/navigation.json (docs/clients/README.md, rules 1–7).
 * The manifest is read from the repository (the test resources point at docs/clients), never
 * from a copy.
 */
class NavigationParityTest {
    private val manifest: JsonObject = Json.parseToJsonElement(
        javaClass.classLoader!!.getResource("navigation.json")!!.readText(),
    ).jsonObject

    private fun list(key: String) = manifest.getValue(key).jsonArray.map { it.jsonPrimitive.content }
    private val destinations = manifest.getValue("destinations").jsonArray.map { it.jsonObject }
        .filter { d -> d["surfaces"]?.jsonArray?.any { it.jsonPrimitive.content == "android" } ?: true }
    private val ids = destinations.map { it.getValue("id").jsonPrimitive.content }
    private fun destination(id: String) = destinations.first { it.getValue("id").jsonPrimitive.content == id }

    @Test fun `1 and 2 - every destination has a screen and every screen a destination`() {
        assertEquals(ids.toSet(), Screens.all)
        assertTrue("this_device is a phone destination", "this_device" in Screens.all)
    }

    @Test fun `pre-auth screens are the manifest's and are not destinations`() {
        val preAuth = manifest.getValue("preAuth").jsonObject.filterKeys { !it.startsWith("$") }
        assertEquals(preAuth.keys.toList(), Screens.preAuth)
        Screens.preAuth.forEach { assertFalse(it in ids) }
        assertEquals(
            preAuth.mapValues { it.value.jsonObject.getValue("routes").jsonObject.getValue("android").jsonPrimitive.content },
            SurfaceRoutes.preAuthAndroid,
        )
    }

    @Test fun `3 - one primary entry per destination, in the manifest's order`() {
        assertEquals(list("rail"), Screens.rail)
        assertEquals(list("segments"), Screens.segments)
        assertEquals(list("footer"), Screens.footer)
        assertEquals(list("settingsTabs").filter { it in ids }, Screens.settingsTabs)
        assertEquals(list("settingsManagement").filter { it in ids }, Screens.settingsManagement)
        assertEquals(list("settingsTools").filter { it in ids }, Screens.settingsTools)
        assertEquals(list("agentLevel").filter { it in ids }, Screens.agentLevel)
        assertEquals(listOf(Screens.settingsTabs, Screens.settingsManagement, Screens.settingsTools), SettingsList.groups.map { it.second })
        val primaries = Screens.rail + Screens.segments + Screens.footer + Screens.settingsTabs + Screens.settingsManagement +
            Screens.settingsTools + Screens.agentLevel
        assertEquals("no destination has two primary entries", primaries.size, primaries.toSet().size)
    }

    private fun termsXml(dir: String): Map<String, String> {
        val file = File(System.getProperty("user.dir"), "build/generated/shared/res/$dir/terms.xml")
        val nodes = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            nodes.item(i).attributes.getNamedItem("name").nodeValue.removePrefix("term_") to nodes.item(i).textContent
        }
    }

    @Test fun `4 - every label and title comes from terms, in Arabic and English`() {
        val terms = manifest.getValue("terms").jsonObject
        assertEquals(terms.keys, Terms.ids.keys)
        val en = termsXml("values")
        val ar = termsXml("values-ar")
        for ((key, value) in terms) {
            assertEquals(key, value.jsonObject.getValue("en").jsonPrimitive.content, en[key])
            assertEquals(key, value.jsonObject.getValue("ar").jsonPrimitive.content, ar[key])
        }
        for (d in destinations) assertNotNull(Terms.ids[d.getValue("title").jsonPrimitive.content])
    }

    @Test fun `5 - search is the secondary way to a conversation and to the global agent`() {
        val secondary = manifest.getValue("secondaryEntries").jsonObject
        val chat = SearchHits.routeOf(fakeSession("chat")).destination
        val global = SearchHits.routeOf(fakeSession("global_agent")).destination
        for (target in listOf(chat, global)) {
            assertTrue("$target reached from search", secondary.getValue(target).jsonArray.any { it.jsonPrimitive.content == "search" })
        }
        assertEquals("global_agent", global)
    }

    @Test fun `6 - admin destinations are hidden from members, and surfaces are respected`() {
        val admin = destinations.filter { d -> d.getValue("roles").jsonArray.any { it.jsonPrimitive.content == "admin" } }
            .map { it.getValue("id").jsonPrimitive.content }.toSet()
        assertEquals(admin, Screens.adminOnly)
        admin.forEach { assertFalse(Screens.visible(it, isAdmin = false)) }
        assertTrue(SettingsList.visible(isAdmin = false).flatMap { it.second }.none { it in admin })
        val web = manifest.getValue("surfaceRoutes").jsonObject.getValue("web").jsonObject.keys
        assertFalse("this_device is not on the web", "this_device" in web)
    }

    @Test fun `7 - agent pages follow the adapter's capabilities`() {
        for (id in Screens.agentLevel) {
            assertEquals(destination(id).getValue("capability").jsonPrimitive.content, Screens.capabilityOf[id])
        }
        assertEquals(listOf("agent_skills", "agent_mcp", "agent_settings"), Screens.agentPages(listOf("streaming", "skills", "mcp"), configurable = true))
        assertEquals(listOf("agent_skills", "agent_mcp"), Screens.agentPages(listOf("skills", "mcp"), configurable = false))
        assertEquals(
            listOf("agent_skills", "agent_mcp", "agent_memory", "agent_jobs", "agent_channels", "agent_plugins", "agent_settings"),
            Screens.agentPages(listOf("plugins", "channels", "jobs", "memory", "mcp", "skills"), configurable = true),
        )
    }

    @Test fun `every Android path resolves to its destination`() {
        val android = manifest.getValue("surfaceRoutes").jsonObject.getValue("android").jsonObject
        assertEquals(ids.toSet(), android.keys)
        for ((id, route) in android) {
            val path = route.jsonPrimitive.content.replace(":agentId", "01J8QK3ZR2W7M5N4P6T8V9X0AG")
                .replace("/:sessionId?", "/01J8QK3ZR2W7M5N4P6T8V9X0YA").replace("/:roomId?", "/01J8QK3ZR2W7M5N4P6T8V9X0RM")
            val target = AppPaths.resolve(path)
            assertEquals(path, id, target?.destination)
            val opened = AppPaths.route(target!!, "default")
            assertEquals(path, id, opened?.destination)
        }
        assertEquals(SurfaceRoutes.android.keys, android.keys)
    }

    private fun fakeSession(source: String) = hub.core.client.infrastructure.Serializer.kotlinxSerializationJson.decodeFromString(
        hub.core.client.model.Session.serializer(),
        """{"id":"01J8QK3ZR2W7M5N4P6T8V9X0S1","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-20T10:00:00Z",
           "updated_at":"2026-09-20T10:00:00Z","agent_id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","source":"$source","pinned":false,
           "archived":false,"message_count":0,"status":"idle","notify":false}""",
    )
}

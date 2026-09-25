package hub.core.android.ui

import hub.core.android.ui.screens.ArchiveFilter
import hub.core.android.ui.screens.ChatAgents
import hub.core.android.ui.screens.ChatsList
import hub.core.android.ui.screens.ChatsState
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Agent
import hub.core.client.model.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatsListTest {
    private fun session(id: String, profile: String = "work", source: String = "chat", pinned: Boolean = false, archived: Boolean = false, last: String = "2026-09-21T10:00:00Z") =
        Serializer.kotlinxSerializationJson.decodeFromString(
            Session.serializer(),
            """{"id":"$id","profile":"$profile","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-20T10:00:00Z",
               "updated_at":"2026-09-20T10:00:00Z","agent_id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","title":null,"source":"$source",
               "origin":null,"channel":null,"model":null,"provider":null,"reasoning_effort":null,"working_dir":null,
               "pinned":$pinned,"archived":$archived,"category_id":null,"preview":null,"message_count":0,"usage":null,
               "context":null,"status":"idle","active_run_id":null,"parent_session_id":null,"notify":false,
               "last_message_at":"$last","match":null}""",
        )

    @Test fun `the global agent's conversation never shows in the list`() {
        assertFalse(ChatsList.visible(session("01J8QK3ZR2W7M5N4P6T8V9X0S1", source = "global_agent")))
        val state = ChatsList.upsert(ChatsState(), session("01J8QK3ZR2W7M5N4P6T8V9X0S1", source = "global_agent"))
        assertTrue(state.items.isEmpty())
    }

    @Test fun `pinned first, then the most recent`() {
        val a = session("01J8QK3ZR2W7M5N4P6T8V9X0S1", last = "2026-09-21T09:00:00Z")
        val b = session("01J8QK3ZR2W7M5N4P6T8V9X0S2", last = "2026-09-21T11:00:00Z")
        val c = session("01J8QK3ZR2W7M5N4P6T8V9X0S3", pinned = true, last = "2026-09-20T09:00:00Z")
        assertEquals(listOf(c, b, a).map { it.id }, ChatsList.order(listOf(a, b, c)).map { it.id })
    }

    @Test fun `a live update follows the list's own filters`() {
        val one = ChatsState(profileFilter = "work")
        assertTrue(ChatsList.upsert(one, session("01J8QK3ZR2W7M5N4P6T8V9X0S1", profile = "work")).items.isNotEmpty())
        assertTrue(ChatsList.upsert(one, session("01J8QK3ZR2W7M5N4P6T8V9X0S1", profile = "home")).items.isEmpty())
        val active = ChatsList.upsert(ChatsState(), session("01J8QK3ZR2W7M5N4P6T8V9X0S1"))
        assertTrue(ChatsList.upsert(active, session("01J8QK3ZR2W7M5N4P6T8V9X0S1", archived = true)).items.isEmpty())
        assertTrue(ChatsList.upsert(ChatsState(archive = ArchiveFilter.ARCHIVED), session("01J8QK3ZR2W7M5N4P6T8V9X0S1", archived = true)).items.isNotEmpty())
        assertTrue(ChatsList.remove(active, "01J8QK3ZR2W7M5N4P6T8V9X0S1").items.isEmpty())
    }

    @Test fun `profile badges show only while the list may hold more than one profile`() {
        assertTrue(ChatsList.showsProfiles(ChatsState(profileFilter = null), 2))
        assertFalse(ChatsList.showsProfiles(ChatsState(profileFilter = "work"), 2))
        assertFalse(ChatsList.showsProfiles(ChatsState(profileFilter = null), 1))
    }

    private fun agent(id: String, status: String, enabled: Boolean = true) = Serializer.kotlinxSerializationJson.decodeFromString(
        Agent.serializer(),
        """{"id":"$id","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-20T10:00:00Z",
           "updated_at":"2026-09-20T10:00:00Z","slug":"a$id","name":"A","kind":"hermes","vendor":null,
           "avatar":{"kind":"generated","url":null,"seed":"a"},"status":"$status","enabled":$enabled,
           "install":{"source":"managed","path":null,"package":null,"command":null,"version":null,"latest_version":null,
             "update_available":false,"auto_update":false,"auto_update_supported":false,"checked_at":null,"error":null},
           "runtime":{"state":"running","url":null,"error":null},"capabilities":["streaming"],"sections":[],"limited":false,"default_model":null}""",
    )

    @Test fun `only enabled, installed agents start a chat`() {
        val agents = listOf(
            agent("01J8QK3ZR2W7M5N4P6T8V9X0A1", "available"), agent("01J8QK3ZR2W7M5N4P6T8V9X0A2", "not_installed"),
            agent("01J8QK3ZR2W7M5N4P6T8V9X0A3", "limited"), agent("01J8QK3ZR2W7M5N4P6T8V9X0A4", "available", enabled = false),
            agent("01J8QK3ZR2W7M5N4P6T8V9X0A5", "error"),
        )
        assertEquals(listOf("01J8QK3ZR2W7M5N4P6T8V9X0A1", "01J8QK3ZR2W7M5N4P6T8V9X0A3"), ChatAgents.startable(agents).map { it.id })
    }
}

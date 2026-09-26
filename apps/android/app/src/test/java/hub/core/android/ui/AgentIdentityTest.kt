package hub.core.android.ui

import hub.core.android.ui.components.AgentIdentity
import hub.core.android.ui.components.AgentMarks
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Agent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A reply shows who answered: the registry's name and the agent's own face, never «agent». */
class AgentIdentityTest {
    private fun agent(id: String, slug: String, name: String, avatar: String = """{"kind":"generated","url":null,"seed":"a"}""") =
        Serializer.kotlinxSerializationJson.decodeFromString(
            Agent.serializer(),
            """{"id":"$id","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-20T10:00:00Z",
               "updated_at":"2026-09-20T10:00:00Z","slug":"$slug","name":"$name","kind":"hermes","vendor":null,
               "avatar":$avatar,"status":"available","enabled":true,
               "install":{"source":"managed","path":null,"package":null,"command":null,"version":null,"latest_version":null,
                 "update_available":false,"pinned_version":null,"newer_than_tested":false,"auto_update":false,
                 "auto_update_supported":false,"checked_at":null,"error":null},
               "runtime":{"state":"running","url":null,"error":null},"capabilities":["streaming"],"sections":[],"limited":false,"subagents":"none","default_model":null}""",
        )

    private val hermes = agent("01J8QK3ZR2W7M5N4P6T8V9X0A1", "hermes", "Hermes")
    private val mine = agent("01J8QK3ZR2W7M5N4P6T8V9X0A2", "private-bot", "مساعدي", """{"kind":"image","url":"/api/v1/agents/x/avatar","seed":null}""")

    @Test fun `a chat reply's placeholder name becomes the agent's own`() {
        val who = AgentIdentity.of(hermes.id, "agent", listOf(hermes, mine), "Agent")
        assertEquals("Hermes", who.name)
        assertEquals("hermes", who.slug)
        assertFalse(who.hasPicture)
    }

    @Test fun `a room seat keeps its own name and wears its agent's face`() {
        val who = AgentIdentity.of(hermes.id, "المخطِّط", listOf(hermes), "Agent")
        assertEquals("المخطِّط", who.name)
        assertEquals("hermes", who.slug)
    }

    @Test fun `an agent with a picture of its own shows it, one we do not know falls back`() {
        assertTrue(AgentIdentity.of(mine).hasPicture)
        val unknown = AgentIdentity.of("01J8QK3ZR2W7M5N4P6T8V9X0ZZ", "agent", listOf(hermes), "Agent")
        assertEquals("Agent", unknown.name)
        assertNull(unknown.slug)
    }

    @Test fun `the marks are the web's, by catalog slug`() {
        for (slug in listOf("hermes", "claude-code", "codex", "gemini-cli", "opencode", "qwen-code", "kimi-code", "pi", "direct")) {
            assertTrue(slug, AgentMarks.of(slug) != null)
        }
        assertNull(AgentMarks.of("private-bot"))
        assertNull(AgentMarks.of(null))
    }
}

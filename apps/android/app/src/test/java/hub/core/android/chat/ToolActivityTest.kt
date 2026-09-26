package hub.core.android.chat

import hub.core.client.model.ToolCall
import hub.core.client.model.ToolCallStatus
import java.io.File
import java.time.OffsetDateTime
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone's tool activity rule — the web's `toolActivity` with a window of two (owner, 2026-09-26). */
class ToolActivityTest {
    private fun call(
        id: String,
        name: String = "tool_$id",
        status: ToolCallStatus = ToolCallStatus.SUCCEEDED,
        durationMs: Int? = 120,
        startedAt: String? = null,
        finishedAt: String? = null,
    ) = ToolCall(
        id = id, name = name, status = status, outputTruncated = false, durationMs = durationMs,
        startedAt = startedAt?.let(OffsetDateTime::parse), finishedAt = finishedAt?.let(OffsetDateTime::parse),
    )

    private val six = listOf("a", "b", "c", "d", "e", "f").map { call(it) }

    @Test fun `a live turn shows the last two and counts the rest as earlier`() {
        val activity = ToolActivity.of(six, live = true)
        assertEquals(2, ToolActivity.WINDOW)
        assertFalse(activity.folded)
        assertEquals(listOf("e", "f"), activity.visible.map { it.id })
        assertEquals(4, activity.hidden)
    }

    @Test fun `a failed or still-running call stays in view until the turn ends`() {
        val calls = six.mapIndexed { i, c ->
            when (i) {
                0 -> c.copy(status = ToolCallStatus.FAILED)
                1 -> c.copy(status = ToolCallStatus.RUNNING)
                else -> c
            }
        }
        val activity = ToolActivity.of(calls, live = true)
        assertEquals(listOf("a", "b", "e", "f"), activity.visible.map { it.id })
        assertEquals(2, activity.hidden)
    }

    @Test fun `a call waiting for approval keeps the turn live after the message ended`() {
        assertFalse(ToolActivity.of(listOf(call("a", status = ToolCallStatus.AWAITING_APPROVAL)), live = false).folded)
    }

    @Test fun `a finished turn folds into one summary`() {
        val calls = listOf(
            call("1", "skill_view", startedAt = "2026-09-26T10:00:00Z", finishedAt = "2026-09-26T10:00:05Z"),
            call("2", "vision_analyze", ToolCallStatus.FAILED, startedAt = "2026-09-26T10:00:05Z", finishedAt = "2026-09-26T10:00:40Z"),
            call("3", "terminal", startedAt = "2026-09-26T10:00:40Z", finishedAt = "2026-09-26T10:01:00Z"),
            call("4", "vision_analyze", startedAt = "2026-09-26T10:01:00Z", finishedAt = "2026-09-26T10:01:05Z"),
        )
        val activity = ToolActivity.of(calls, live = false)
        assertTrue(activity.folded)
        assertTrue(activity.visible.isEmpty())
        assertEquals(4, activity.hidden)
        assertEquals(ToolActivitySummary(count = 4, failed = 1, durationMs = 65_000, names = listOf("vision_analyze", "terminal")), activity.summary)
        assertEquals(1L to 5L, ToolActivity.durationParts(65_000))
    }

    @Test fun `without times the durations are summed, and with neither there is no time`() {
        assertEquals(240L, ToolActivity.summarize(listOf(call("1"), call("2"))).durationMs)
        assertNull(ToolActivity.summarize(listOf(call("1", durationMs = null))).durationMs)
        assertEquals(0L to 1L, ToolActivity.durationParts(240))
    }

    /** Arabic has six plural forms; English two. Every tool-activity plural carries all of its language's. */
    @Test fun `the plurals have every form of their language`() {
        val res = File(System.getProperty("user.dir"), "src/main/res")
        fun plurals(dir: String): Map<String, Set<String>> {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "$dir/strings_tool_activity.xml"))
            val nodes = doc.getElementsByTagName("plurals")
            return (0 until nodes.length).associate { i ->
                val node = nodes.item(i) as org.w3c.dom.Element
                val items = node.getElementsByTagName("item")
                node.getAttribute("name") to (0 until items.length).map { (items.item(it) as org.w3c.dom.Element).getAttribute("quantity") }.toSet()
            }
        }
        val en = plurals("values")
        val ar = plurals("values-ar")
        assertEquals(en.keys, ar.keys)
        en.values.forEach { assertEquals(setOf("one", "other"), it) }
        ar.values.forEach { assertEquals(setOf("zero", "one", "two", "few", "many", "other"), it) }
    }
}

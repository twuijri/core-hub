package us.i3u.hermesstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The stale-session path.
 *
 * `requireSocketSessionAccess` in modules/studio/sockets/chat-run.ts rejects
 * `run`, `resume` and `app.resume` with `run.failed: Session not found` for
 * any id the server does not know, and the REST controllers answer 404 with
 * the same wording. The app used to turn every one of those into another red
 * row in the transcript, and it kept reusing the dead id, so opening a new
 * chat showed a banner and a stack of identical rows.
 */
class SessionRecoveryTest {

    @Test
    fun `the servers wording is recognised as a missing session`() {
        assertTrue(isSessionGoneError("Session not found"))
        assertTrue(isSessionGoneError("HTTP 404: Session not found"))
        assertTrue(isSessionGoneError("session not found"))
        assertTrue(isSessionGoneError("HTTP 404: Conversation not found"))
    }

    @Test
    fun `an ordinary failure is not a missing session`() {
        assertFalse(isSessionGoneError(null))
        assertFalse(isSessionGoneError("   "))
        assertFalse(isSessionGoneError("Profile \"barq\" is not available for this user"))
        assertFalse(isSessionGoneError("chat-run failed"))
    }

    @Test
    fun `run failed for a gone session is a state change, not a transcript row`() {
        val event = JSONObject("""{"event":"run.failed","session_id":"s5","error":"Session not found"}""")
        assertSame(RunEvent.SessionGone, runFailureEvent(event))
    }

    @Test
    fun `any other run failure is still reported`() {
        val event = JSONObject("""{"event":"run.failed","session_id":"s1","error":"model refused"}""")
        assertEquals(RunEvent.Failed("model refused", retryableTransport = false), runFailureEvent(event))
        assertEquals(RunEvent.Failed("run failed", retryableTransport = false), runFailureEvent(JSONObject()))
    }

    @Test
    fun `a 404 from a session-scoped endpoint clears the stored id`() {
        assertTrue(HermesException("HTTP 404: Session not found", statusCode = 404).isMissingSession())
        assertTrue(HermesException("Session not found").isMissingSession())
        assertFalse(HermesException("HTTP 500: boom", statusCode = 500).isMissingSession())
        assertFalse(java.io.IOException("offline").isMissingSession())
    }

    @Test
    fun `the open conversation outranks the stored id`() {
        // Store.setSessionFor survives restarts, so a deleted session could
        // outlive the conversation the user is actually looking at.
        assertEquals("open", chatSessionIdFor("open", "stale"))
        assertEquals("stale", chatSessionIdFor(null, "stale"))
        assertEquals("stale", chatSessionIdFor("", "stale"))
    }

    @Test
    fun `a new chat mints an id instead of reusing a cleared one`() {
        // startNewConversation writes "" for the profile; nothing to reuse.
        assertEquals(null, chatSessionIdFor(null, ""))
    }

    @Test
    fun `an identical error is never stacked a second time`() {
        var lines = withErrorLine(emptyList(), "Session not found")
        repeat(5) { lines = withErrorLine(lines, "Session not found") }
        assertEquals(1, lines.count { it.isError })
        assertEquals("Session not found", lines.single().text)
    }

    @Test
    fun `a different error still gets its own row`() {
        val lines = withErrorLine(withErrorLine(emptyList(), "first"), "second")
        assertEquals(listOf("first", "second"), lines.map { it.text })
    }

    @Test
    fun `a blank error adds nothing`() {
        val lines = listOf(ChatLine("hi", fromUser = true))
        assertSame(lines, withErrorLine(lines, "   "))
    }

    @Test
    fun `no per-session socket action is emitted without an id`() {
        // Each of these used to build a payload with an empty session_id,
        // which the server can only answer with "Session not found".
        val socket = File("src/main/java/us/i3u/hermesstudio/ChatSocket.kt").readText()
        assertTrue(
            "the per-session emit helper must drop a blank id",
            socket.contains("if (sessionId.isBlank()) return"),
        )
        listOf("abort", "approval.respond", "clarify.respond", "insert_queued_run", "cancel_queued_run", "steer_queued_run")
            .forEach { event ->
                assertTrue("$event must go through emitForSession", socket.contains("emitForSession(\"$event\""))
            }
        assertTrue(
            "app.resume must not be sent for a session the server was never told about",
            socket.contains("} else if (sessionId.isNotBlank()) {"),
        )
    }

    @Test
    fun `the mock server can reproduce the stale session`() {
        val mock = File("../tools/mock-studio.py").readText()
        assertTrue("the mock needs a deleted session to answer 404", mock.contains("DELETED_SESSION_IDS = {\"s5\"}"))
        assertTrue(mock.contains("\"error\": \"Session not found\""))
        assertTrue("a phone-minted id must 404 on a session write", mock.contains("session_write"))
    }
}

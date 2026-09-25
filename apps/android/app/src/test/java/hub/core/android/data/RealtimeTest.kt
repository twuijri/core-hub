package hub.core.android.data

import hub.core.android.realtime.Envelope
import hub.core.android.realtime.SubscribeAck
import hub.core.android.realtime.envelopeOf
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeTest {
    private val envelope = """{"event":"message.delta","namespace":"/rt/sessions","profile":"work","ts":"2026-09-21T10:15:04Z","seq":8812,
        "payload":{"session_id":"01J8QK3ZR2W7M5N4P6T8V9X0YA","message_id":"01J8QK3ZR2W7M5N4P6T8V9X0MB","run_id":"01J8QK3ZR2W7M5N4P6T8V9X0RN","delta":"x"}}"""

    @Test fun `the envelope is found after the event name the Java client puts first`() {
        val e = envelopeOf(arrayOf("message.delta", JSONObject(envelope)))!!
        assertEquals("message.delta", e.event)
        assertEquals(8812L, e.seq)
        assertEquals("work", e.profile)
        assertNull(envelopeOf(arrayOf("ping")))
    }

    @Test fun `a user-level event has no profile, and a malformed one is not an envelope`() {
        assertNull(Envelope.parse(envelope.replace("\"profile\":\"work\"", "\"profile\":null"))!!.profile)
        assertNull(Envelope.parse("""{"event":"x","namespace":"/rt/sessions"}"""))
        assertNull(Envelope.parse("[]"))
    }

    @Test fun `subscribe acks are read`() {
        assertEquals(SubscribeAck(true, 3, true), SubscribeAck.parse("""{"ok":true,"replayed":3,"truncated":true}"""))
        val refused = SubscribeAck.parse("""{"ok":false,"error":"Not found","code":"not_found"}""")
        assertFalse(refused.ok)
        assertEquals("not_found", refused.code)
        assertTrue(SubscribeAck.parse(null).code == "no_answer")
    }
}

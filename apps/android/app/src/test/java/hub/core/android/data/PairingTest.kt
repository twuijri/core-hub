package hub.core.android.data

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    private val id = "01J8QK3ZR2W7M5N4P6T8V9X0PA"

    @Test fun `a typed address becomes the hub's origin`() {
        assertEquals(HubUrl.Ok("https://hub.example.com"), HubUrl.parse("hub.example.com"))
        assertEquals(HubUrl.Ok("http://192.168.1.10:8787"), HubUrl.parse(" http://192.168.1.10:8787/ "))
        assertEquals(HubUrl.Ok("https://hub.example.com"), HubUrl.parse("HTTPS://Hub.Example.com"))
    }

    @Test fun `anything that is not a hub's address is refused, not trimmed`() {
        listOf("", "ftp://hub", "https://hub.example.com/chat/1", "https://u:p@hub.example.com", "hub .com", "https://hub?x=1")
            .forEach { assertEquals(it, HubUrl.Invalid, HubUrl.parse(it)) }
    }

    @Test fun `the QR the hub draws is claimed as it is`() {
        val qr = """{"type":"corehub.pairing","hub_url":"https://hub.example.com","pairing_id":"$id","code":"ab12-cd34","expires_at":"2026-09-25T10:05:00Z"}"""
        assertEquals(
            PairingRequest("https://hub.example.com", id, "AB12-CD34"),
            PairingInput.parse(qr, Instant.parse("2026-09-25T10:00:00Z")),
        )
    }

    @Test fun `a code from a hub older than the rename still pairs`() {
        val qr = """{"type":"majlis.pairing","hub_url":"http://10.0.0.5:8787","pairing_id":"$id","code":"ABCD"}"""
        assertEquals(PairingRequest("http://10.0.0.5:8787", id, "ABCD"), PairingInput.parse(qr))
    }

    @Test fun `an expired, foreign or broken code is not a pairing`() {
        val now = Instant.parse("2026-09-25T10:10:00Z")
        assertNull(PairingInput.parse("""{"type":"corehub.pairing","hub_url":"https://h.io","pairing_id":"$id","code":"ABCD","expires_at":"2026-09-25T10:05:00Z"}""", now))
        assertNull(PairingInput.parse("""{"type":"wifi","hub_url":"https://h.io","pairing_id":"$id","code":"ABCD"}""", now))
        assertNull(PairingInput.parse("""{"type":"corehub.pairing","hub_url":"https://h.io","pairing_id":"not-a-ulid","code":"ABCD"}""", now))
        assertNull(PairingInput.parse("{not json", now))
        assertNull(PairingInput.parse("https://example.com", now))
    }

    @Test fun `the pair link the web offers pairs too`() {
        val link = "corehub://pair?hub=https%3A%2F%2Fhub.example.com&id=${id.lowercase()}&code=wxyz"
        assertEquals(PairingRequest("https://hub.example.com", id, "WXYZ"), PairingInput.parse(link))
        assertEquals(DeepLink.Pair(PairingRequest("https://hub.example.com", id, "WXYZ")), DeepLink.parse(link))
    }

    @Test fun `other corehub links are read and checked`() {
        assertEquals(DeepLink.Connect("https://hub.example.com"), DeepLink.parse("corehub://connect?hub=hub.example.com"))
        assertEquals(DeepLink.Open("/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA"), DeepLink.parse("corehub://open/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA"))
        assertNull(DeepLink.parse("corehub://open//evil.example.com"))
        assertNull(DeepLink.parse("corehub://open/../settings"))
        assertNull(DeepLink.parse("corehub://erase"))
        assertNull(DeepLink.parse("https://pair?hub=x"))
    }
}

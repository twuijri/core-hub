package hub.core.android.data

import hub.core.android.MemoryPrefs
import hub.core.android.ReversingSealer
import hub.core.android.storedSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class SecureStoreTest {
    @Test fun `values are sealed on disk and read back`() {
        val prefs = MemoryPrefs()
        val store = SecureStore(prefs, ReversingSealer())
        store.putString("token", "secret-token")
        assertFalse((prefs.values["token"] as String).contains("secret"))
        assertEquals("secret-token", store.getString("token"))
        store.putString("token", null)
        assertNull(store.getString("token"))
    }

    @Test fun `a value that no longer opens reads as absent and is dropped`() {
        val prefs = MemoryPrefs()
        val broken = object : Sealer {
            override fun seal(plain: ByteArray) = plain
            override fun open(sealed: ByteArray): ByteArray = throw javax.crypto.AEADBadTagException()
        }
        SecureStore(prefs, ReversingSealer()).putString("session", "x")
        assertNull(SecureStore(prefs, broken).getString("session"))
        assertFalse("session" in prefs.values)
    }

    @Test fun `the session survives a restart and the device key stays the same`() {
        val prefs = MemoryPrefs()
        val first = SessionStore(SecureStore(prefs, ReversingSealer()))
        first.save(storedSession())
        val key = first.deviceKey
        val second = SessionStore(SecureStore(prefs, ReversingSealer()))
        assertEquals(storedSession(), second.current)
        assertEquals(key, second.deviceKey)
        second.save(null)
        assertEquals(key, second.deviceKey)
    }
}

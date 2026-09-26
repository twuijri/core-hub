package hub.core.android.phone

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The relay's device proof: what is signed, and the key and signature in the raw forms the relay
 * reads. The Keystore is Android's; here a software P-256 key plays it.
 */
class DeviceProofTest {
    private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val keys = ProofKeys { pair }
    private fun bytes(base64url: String) = Base64.getUrlDecoder().decode(base64url)

    @Test fun `the proof is what the relay verifies`() {
        val token = "fcm-registration-token-0123456789"
        val proof = DeviceProof.proof(keys, "fcm", token, nowMillis = 1_790_000_123_900) ?: error("no proof")
        assertEquals(1_790_000_123, proof.signedAt)
        val raw = bytes(proof.key)
        val signature = bytes(proof.signature)
        assertEquals(65, raw.size)
        assertEquals(4.toByte(), raw[0])
        assertEquals(64, signature.size)
        listOf(proof.key, proof.signature).forEach { assertFalse(it, it.any { c -> c in "+/=" }) }

        // The point rebuilt from the raw bytes is this install's public key.
        val params = (pair.public as ECPublicKey).params
        val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        val rebuilt = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))
        assertArrayEquals(pair.public.encoded, rebuilt.encoded)

        val message = "corehub-push-bind-v1\nfcm\n$token\n1790000123".toByteArray()
        assertArrayEquals(message, DeviceProof.message("fcm", token, 1_790_000_123))
        fun verifies(signed: ByteArray) = Signature.getInstance("SHA256withECDSAinP1363Format").run {
            initVerify(rebuilt)
            update(signed)
            verify(signature)
        }
        assertTrue(verifies(message))
        assertFalse(verifies(DeviceProof.message("fcm", token, 1_790_000_124)))
        assertFalse(verifies(DeviceProof.message("apns", token, 1_790_000_123)))
    }

    @Test fun `every proof of this install has the same key`() {
        val first = DeviceProof.proof(keys, "fcm", "a", nowMillis = 100_000)!!
        val later = DeviceProof.proof(keys, "fcm", "b", nowMillis = 200_000)!!
        assertEquals(first.key, later.key)
        assertTrue(later.signedAt > first.signedAt)
    }

    @Test fun `no proof when the key cannot be made`() {
        assertNull(DeviceProof.proof({ null }, "fcm", "a"))
    }

    @Test fun `a DER signature becomes raw r and s of 32 bytes each`() {
        // r with its high bit set (DER adds a 0x00), s short (DER drops its leading zero).
        val r = ByteArray(32) { 0xff.toByte() }
        val s = ByteArray(32).also { it[31] = 7 }
        val der = byteArrayOf(0x30, (2 + 33 + 2 + 1).toByte(), 0x02, 33, 0) + r + byteArrayOf(0x02, 1, 7)
        assertArrayEquals(r + s, DeviceProof.rawSignature(der))
    }

    @Test fun `base64url has no padding and no plus or slash`() {
        assertEquals("-__-", DeviceProof.base64url(byteArrayOf(0xfb.toByte(), 0xff.toByte(), 0xfe.toByte())))
        assertEquals("AQID_w", DeviceProof.base64url(byteArrayOf(1, 2, 3, 0xff.toByte())))
    }
}

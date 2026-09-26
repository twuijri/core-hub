package hub.core.android.phone

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import hub.core.client.model.PushRelayProof
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * The push relay's device proof (ADR 0024 §6, the contract's `PushRelayProof`). A hub with no FCM
 * key of its own pushes through the Core Hub relay, which binds this phone's token to the first
 * hub that asks. When the phone signs in to another hub without signing out of the first, this
 * proof moves the token at once instead of after 30 days: a P-256 key made once for this install,
 * kept in the Android Keystore (its private half never leaves it), signs `corehub-push-bind-v1`,
 * the platform, the token and the time; the hub forwards it to the relay unread. The relay moves a
 * binding only for a newer proof from the key it recorded first.
 */
fun interface ProofKeys {
    /** This install's key pair, made the first time and the same after; null when it cannot be. */
    fun keyPair(): KeyPair?
}

/** The Android Keystore: the key is made there and only used there. */
class KeystoreProofKeys(private val alias: String = "corehub.push-proof") : ProofKeys {
    override fun keyPair(): KeyPair? = runCatching {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val kept = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        if (kept != null) {
            KeyPair(kept.certificate.publicKey, kept.privateKey)
        } else {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
                initialize(
                    KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .build(),
                )
                generateKeyPair()
            }
        }
    }.getOrNull()

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
    }
}

object DeviceProof {
    /** The relay's prefix (packages/push-relay/src/relay.ts `PROOF_PREFIX`). */
    const val PREFIX = "corehub-push-bind-v1"

    /** What is signed: the prefix, the platform (`fcm`), the token and the unix time, one a line. */
    fun message(platform: String, token: String, signedAt: Long): ByteArray =
        listOf(PREFIX, platform, token, signedAt.toString()).joinToString("\n").toByteArray(Charsets.UTF_8)

    /**
     * The proof for one registration: the raw public point (65 bytes) and the raw `r || s`
     * signature (64 bytes), both base64url. Null when the key cannot be made or used; the phone
     * then registers without one, as an older app does.
     */
    fun proof(keys: ProofKeys, platform: String, token: String, nowMillis: Long = System.currentTimeMillis()): PushRelayProof? =
        runCatching {
            val pair = keys.keyPair() ?: return null
            val public = pair.public as? ECPublicKey ?: return null
            val signedAt = nowMillis / 1000
            val der = Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private)
                update(message(platform, token, signedAt))
                sign()
            }
            PushRelayProof(
                key = base64url(rawPublicKey(public)),
                signedAt = signedAt.toInt(),
                signature = base64url(rawSignature(der)),
            )
        }.getOrNull()

    /** The uncompressed point `04 || x || y`, each coordinate 32 bytes. */
    fun rawPublicKey(key: ECPublicKey): ByteArray =
        byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)

    /** Java signs ECDSA as DER `SEQUENCE { INTEGER r, INTEGER s }`; the relay reads raw `r || s`. */
    fun rawSignature(der: ByteArray): ByteArray {
        var at = 0
        fun length(): Int {
            val first = der[at++].toInt() and 0xff
            if (first < 0x80) return first
            var value = 0
            repeat(first and 0x7f) { value = (value shl 8) or (der[at++].toInt() and 0xff) }
            return value
        }
        fun integer(): BigInteger {
            require(der[at++].toInt() == 0x02) { "not a DER integer" }
            val size = length()
            return BigInteger(1, der.copyOfRange(at, at + size)).also { at += size }
        }
        require(der[at++].toInt() == 0x30) { "not a DER sequence" }
        length()
        return fixed(integer()) + fixed(integer())
    }

    fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun fixed(value: BigInteger): ByteArray {
        val bytes = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
        require(bytes.size <= 32) { "a P-256 value is 32 bytes" }
        return ByteArray(32 - bytes.size) + bytes
    }
}

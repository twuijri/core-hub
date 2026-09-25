package hub.core.android.data

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Seals and opens bytes. The app's one implementation keeps its key in the Android Keystore. */
interface Sealer {
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

/**
 * AES-256-GCM with a key generated inside the Android Keystore: the key never leaves the
 * secure hardware (or the Keystore daemon where there is none), so the tokens written to
 * disk are unreadable without this device and this app. The output is the 12-byte IV
 * followed by the ciphertext and its tag.
 */
class KeystoreSealer(private val alias: String = "corehub.tokens") : Sealer {
    private val key: SecretKey by lazy { existing() ?: create() }

    private fun existing(): SecretKey? {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        return (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.secretKey
    }

    private fun create(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return cipher.iv + cipher.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

/** Base64 without Android's own class, so the store works in JVM unit tests too. */
internal object B64 {
    fun encode(bytes: ByteArray): String = java.util.Base64.getEncoder().encodeToString(bytes)
    fun decode(text: String): ByteArray = java.util.Base64.getDecoder().decode(text)
}

/**
 * String values sealed before they reach [SharedPreferences]. A value that no longer opens
 * (the Keystore key was wiped, say by a backup restored onto another phone) reads as absent,
 * so the person is asked to connect again instead of the app crashing.
 */
class SecureStore(private val prefs: SharedPreferences, private val sealer: Sealer) {
    fun getString(key: String): String? {
        val stored = prefs.getString(key, null) ?: return null
        return try {
            String(sealer.open(B64.decode(stored)), Charsets.UTF_8)
        } catch (_: Exception) {
            prefs.edit().remove(key).apply()
            null
        }
    }

    fun putString(key: String, value: String?) {
        val editor = prefs.edit()
        if (value == null) editor.remove(key)
        else editor.putString(key, B64.encode(sealer.seal(value.toByteArray(Charsets.UTF_8))))
        editor.apply()
    }
}

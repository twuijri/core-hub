package hub.core.android

import android.content.SharedPreferences
import hub.core.android.data.Sealer
import hub.core.android.data.SecureStore
import hub.core.android.data.SessionStore
import hub.core.android.data.StoredSession
import hub.core.android.data.StoredUser
import hub.core.android.data.TokenKind
import java.io.File

/** The repository root, handed to the tests by Gradle (`corehub.repoRoot`). */
val repoRoot: File = File(System.getProperty("corehub.repoRoot") ?: "../../..").absoluteFile

/** An in-memory [SharedPreferences] for JVM tests. */
class MemoryPrefs : SharedPreferences {
    val values = mutableMapOf<String, Any?>()

    override fun getAll(): MutableMap<String, *> = values
    override fun getString(key: String, defValue: String?) = values[key] as String? ?: defValue
    override fun getStringSet(key: String, defValues: MutableSet<String>?) = defValues
    override fun getInt(key: String, defValue: Int) = values[key] as Int? ?: defValue
    override fun getLong(key: String, defValue: Long) = values[key] as Long? ?: defValue
    override fun getFloat(key: String, defValue: Float) = values[key] as Float? ?: defValue
    override fun getBoolean(key: String, defValue: Boolean) = values[key] as Boolean? ?: defValue
    override fun contains(key: String) = key in values
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        val pending = mutableMapOf<String, Any?>()
        val removed = mutableSetOf<String>()
        override fun putString(key: String, value: String?) = apply { pending[key] = value }
        override fun putStringSet(key: String, values: MutableSet<String>?) = apply { pending[key] = values }
        override fun putInt(key: String, value: Int) = apply { pending[key] = value }
        override fun putLong(key: String, value: Long) = apply { pending[key] = value }
        override fun putFloat(key: String, value: Float) = apply { pending[key] = value }
        override fun putBoolean(key: String, value: Boolean) = apply { pending[key] = value }
        override fun remove(key: String) = apply { removed += key }
        override fun clear() = apply { removed += values.keys }
        override fun commit(): Boolean { apply(); return true }
        override fun apply() {
            removed.forEach { values.remove(it) }
            values.putAll(pending)
        }
    }
    override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
}

/** Reverses the bytes: enough to prove nothing is stored in the clear, without a Keystore. */
class ReversingSealer : Sealer {
    override fun seal(plain: ByteArray) = plain.reversedArray()
    override fun open(sealed: ByteArray) = sealed.reversedArray()
}

fun memoryStore(): SessionStore = SessionStore(SecureStore(MemoryPrefs(), ReversingSealer()))

fun storedSession(
    hub: String = "http://hub.test",
    kind: TokenKind = TokenKind.SESSION,
    token: String = "access-1",
    refresh: String? = "refresh-1",
    expiresAt: Long? = null,
    ttlMs: Long? = null,
) = StoredSession(
    hub = hub, kind = kind, accessToken = token, refreshToken = refresh, expiresAt = expiresAt, ttlMs = ttlMs,
    user = StoredUser("01J8QK3ZR2W7M5N4P6T8V9X0HM", "tariq", "طارق", "owner", listOf("default", "work"), "default"),
    profile = "default",
)

/** A contract `User` as the hub sends it, for token answers in the refresh tests. */
fun userJson(profiles: String = "\"default\",\"work\"") = """
    {"id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","username":"tariq","display_name":"طارق","role":"owner","status":"active",
     "locale":"ar","avatar":{"kind":"generated","url":null,"seed":"t"},"profiles":[$profiles],"default_profile":"default",
     "last_login_at":null,"created_at":"2026-09-21T10:00:00Z","updated_at":"2026-09-21T10:00:00Z"}
""".trimIndent()

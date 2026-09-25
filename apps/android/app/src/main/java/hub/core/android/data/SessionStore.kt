package hub.core.android.data

import hub.core.client.model.User
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A web session (access + rotating refresh token) or an app token from QR pairing. */
@Serializable
enum class TokenKind { SESSION, APP }

/** The signed-in person as the app needs them between launches. */
@Serializable
data class StoredUser(
    val id: String,
    val username: String,
    val displayName: String,
    val role: String,
    val profiles: List<String>,
    val defaultProfile: String,
) {
    val isAdmin: Boolean get() = role == "owner" || role == "admin"

    companion object {
        fun from(user: User) = StoredUser(
            id = user.id,
            username = user.username,
            displayName = user.displayName,
            role = user.role.value,
            profiles = user.profiles,
            defaultProfile = user.defaultProfile,
        )
    }
}

/**
 * Everything the app keeps to talk to a hub. [expiresAt] is epoch milliseconds; for an app
 * token [ttlMs] is how long the hub gave it when it was issued, so a renewal can move the
 * expiry forward by the same amount (the refresh answer does not repeat it).
 */
@Serializable
data class StoredSession(
    val hub: String,
    val kind: TokenKind,
    val accessToken: String,
    val refreshToken: String? = null,
    val expiresAt: Long? = null,
    val ttlMs: Long? = null,
    val user: StoredUser,
    /** The profile the top selector is on: always one concrete profile (ADR 0016). */
    val profile: String,
)

/** The one place the session lives; [session] is what the UI observes. */
class SessionStore(private val secure: SecureStore) {
    private val json = Json { ignoreUnknownKeys = true }
    private val state = MutableStateFlow(load())
    val session: StateFlow<StoredSession?> = state.asStateFlow()
    val current: StoredSession? get() = state.value

    private fun load(): StoredSession? =
        secure.getString(KEY_SESSION)?.let { runCatching { json.decodeFromString<StoredSession>(it) }.getOrNull() }

    @Synchronized
    fun save(session: StoredSession?) {
        secure.putString(KEY_SESSION, session?.let { json.encodeToString(StoredSession.serializer(), it) })
        state.value = session
    }

    @Synchronized
    fun update(transform: (StoredSession) -> StoredSession) {
        current?.let { save(transform(it)) }
    }

    /** Stable id this install presents when pairing, so re-pairing updates the same device row. */
    val deviceKey: String
        @Synchronized get() = secure.getString(KEY_DEVICE) ?: UUID.randomUUID().toString().also {
            secure.putString(KEY_DEVICE, it)
        }

    /** The last hub this install talked to, offered again on the connect screen. */
    var lastHub: String?
        get() = secure.getString(KEY_LAST_HUB)
        set(value) = secure.putString(KEY_LAST_HUB, value)

    private companion object {
        const val KEY_SESSION = "session"
        const val KEY_DEVICE = "device_key"
        const val KEY_LAST_HUB = "last_hub"
    }
}

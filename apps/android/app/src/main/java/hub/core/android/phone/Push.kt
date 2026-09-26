package hub.core.android.phone

import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.SessionStore
import hub.core.android.data.StoredSession
import hub.core.android.data.TokenKind
import hub.core.android.data.hubCall
import hub.core.client.model.DevicePatch
import hub.core.client.model.DeviceRegistration
import hub.core.client.model.Locale
import hub.core.client.model.PushProvider
import hub.core.client.model.PushRegistration
import hub.core.client.model.PushRelayProof

/**
 * Push on this phone (docs/changes/2026-09-25-twuijri-devices-push.md, "what the apps call"):
 * the app registers its FCM token with the hub, and while that holds, the hub's pushes carry the
 * notices and the 15-minute background check stops. Anything else keeps the check.
 */
enum class PushState {
    /** This build has no Firebase project (no `google-services.json`): the app polls. */
    NOT_IN_BUILD,

    /** Not signed in, or not tried yet. */
    IDLE,

    /** The hub has no FCM sender set up (Device connections → Push senders): the app polls. */
    NO_SENDER,

    /** The hub has this phone's token: pushes arrive, the background check is off. */
    ACTIVE,

    /** Firebase or the hub could not be reached or refused: the app polls and tries again later. */
    FAILED,
}

/** What a push from the hub carries in FCM `data` (all strings, per the contract's devices section). */
object PushPayload {
    const val TYPE = "type"
    const val NOTICE_ID = "notice_id"
    const val PROFILE = "profile"
    const val RESOURCE_KIND = "resource_kind"
    const val RESOURCE_ID = "resource_id"
    val KEYS = listOf(TYPE, NOTICE_ID, PROFILE, RESOURCE_KIND, RESOURCE_ID)

    /** A notice push (the only kind the hub sends today; a test push also says `notice`). */
    fun isNotice(data: Map<String, String?>): Boolean = data[TYPE] == "notice"

    /** The in-app path a tap opens, the same as a notice in the inbox; null for anything else. */
    fun path(data: Map<String, String?>): String? =
        if (!isNotice(data)) null else NoticeTracker.path(data[RESOURCE_KIND], data[RESOURCE_ID], data[PROFILE])
}

/**
 * Registers and removes this phone's FCM token with the signed-in hub, only through the
 * generated client. The device the token belongs to:
 * - paired by QR (an app token): the device the pairing made, whose id the claim returned
 *   (older installs look it up as `this_device`);
 * - signed in with a password: this install registers itself (`devices.register`, its stable
 *   `device_key`), and the hub answers with the same row every time.
 * The id is kept with the session and goes when the session goes. Each registration carries the
 * push relay's device proof for the token when this install can make one (DeviceProof.kt).
 */
class PushRegistrar(
    private val store: SessionStore,
    private val apis: (StoredSession) -> HubApis,
    private val proof: (token: String) -> PushRelayProof? = { null },
    private val describe: () -> DeviceRegistration,
) {
    sealed interface Outcome {
        data class Registered(val deviceId: String) : Outcome
        data object NoSender : Outcome
        data object SignedOut : Outcome
        data class Failed(val error: HubError) : Outcome
    }

    suspend fun register(token: String, locale: String): Outcome {
        val session = store.current ?: return Outcome.SignedOut
        val api = apis(session)
        val config = hubCall { api.devices.devicesGetPushConfig() }.getOrElse { return Outcome.Failed(it as HubError) }
        if (PushProvider.FCM !in config.providers) return Outcome.NoSender
        val body = PushRegistration(
            provider = PushRegistration.Provider.FCM,
            token = token,
            locale = if (locale == "ar") Locale.AR else Locale.EN,
            relayProof = proof(token),
        )
        var retried = false
        while (true) {
            val id = deviceId(session, api).getOrElse { return Outcome.Failed(it as HubError) }
            val result = hubCall { api.devices.devicesRegisterPush(id, body) }
            if (result.isSuccess) return Outcome.Registered(id)
            val error = result.exceptionOrNull() as HubError
            if (error.status == 409) return Outcome.NoSender
            // A device row that is gone (removed on the web): a password session registers again, once.
            if (error.status == 404 && session.kind == TokenKind.SESSION && !retried) {
                retried = true
                remember(session, null)
                continue
            }
            return Outcome.Failed(error)
        }
    }

    /**
     * At each launch (and after the notification permission is answered): tells the hub what
     * this phone is now — model, Android and app versions, what stops push. A password sign-in
     * that has no device row yet registers one, which says all of it; a row removed on the web
     * is registered again, once. Best effort: nothing waits for it.
     */
    suspend fun report(patch: DevicePatch): Boolean {
        val session = store.current ?: return false
        val api = apis(session)
        var retried = false
        while (true) {
            val known = store.current?.takeIf { same(it, session) }?.deviceId
            if (known == null && session.kind == TokenKind.SESSION) return deviceId(session, api).isSuccess
            val id = deviceId(session, api).getOrElse { return false }
            val result = hubCall { api.devices.devicesUpdate(id, patch) }
            if (result.isSuccess) return true
            val error = result.exceptionOrNull() as? HubError
            if (error?.status == 404 && session.kind == TokenKind.SESSION && !retried) {
                retried = true
                remember(session, null)
                continue
            }
            return false
        }
    }

    /** Stops pushes to this phone. Best effort: signing out goes on whatever the hub answers. */
    suspend fun unregister(session: StoredSession) {
        val id = session.deviceId ?: return
        hubCall { apis(session).devices.devicesUnregisterPush(id) }
    }

    private suspend fun deviceId(session: StoredSession, api: HubApis): Result<String> {
        store.current?.takeIf { same(it, session) }?.deviceId?.let { return Result.success(it) }
        val found = when (session.kind) {
            TokenKind.APP -> hubCall { thisDevice(api) ?: throw HubError(404, "not_found", null) }
            TokenKind.SESSION -> hubCall { api.devices.devicesRegister(describe()).id }
        }
        found.onSuccess { remember(session, it) }
        return found
    }

    private suspend fun thisDevice(api: HubApis): String? {
        var cursor: String? = null
        repeat(20) {
            val page = api.devices.devicesList(cursor = cursor, limit = 100)
            page.items.firstOrNull { it.thisDevice }?.let { return it.id }
            cursor = page.nextCursor ?: return null
        }
        return null
    }

    private fun remember(session: StoredSession, id: String?) =
        store.update { if (same(it, session)) it.copy(deviceId = id) else it }

    private fun same(a: StoredSession, b: StoredSession) = a.hub == b.hub && a.user.id == b.user.id && a.kind == b.kind
}

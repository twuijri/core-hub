package hub.core.android.ui.screens

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import hub.core.android.AppGraph
import hub.core.android.BuildConfig
import hub.core.android.data.HubError
import hub.core.android.data.HubUrl
import hub.core.android.data.PairingRequest
import hub.core.android.data.StoredSession
import hub.core.android.data.StoredUser
import hub.core.android.data.TokenKind
import hub.core.android.data.hubCall
import hub.core.client.api.AuthApi
import hub.core.client.model.DeviceKind
import hub.core.client.model.DevicePlatform
import hub.core.client.model.DeviceRegistration
import hub.core.client.model.LoginRequest
import hub.core.client.model.PairingClaim
import hub.core.client.model.SetupRequest
import hub.core.client.model.User
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The pre-auth steps: the hub's address, then sign-in or first-run setup; or a QR pairing. */
enum class ConnectStep { HUB, LOGIN, SETUP }

data class ConnectState(
    val step: ConnectStep = ConnectStep.HUB,
    val hubText: String = "",
    val hub: String? = null,
    val hubName: String? = null,
    /** First-run setup is open without the claim token right now (ADR 0019). */
    val setupOpen: Boolean = false,
    val busy: Boolean = false,
    val error: HubError? = null,
    /** The typed address is not a hub address. */
    val invalidHub: Boolean = false,
    /** A scanned or pasted code that is not a Core Hub pairing (or has expired). */
    val invalidPairing: Boolean = false,
)

class ConnectViewModel(private val graph: AppGraph) : ViewModel() {
    private val _state = MutableStateFlow(ConnectState(hubText = graph.store.lastHub.orEmpty()))
    val state: StateFlow<ConnectState> = _state.asStateFlow()

    fun setHubText(text: String) = _state.update { it.copy(hubText = text, invalidHub = false, error = null) }

    fun backToHub() = _state.update { it.copy(step = ConnectStep.HUB, error = null) }

    /** Checks the address answers as a Core Hub (`meta.get`) and whether it still needs its owner. */
    fun continueToHub() {
        val parsed = HubUrl.parse(_state.value.hubText) as? HubUrl.Ok
        if (parsed == null) {
            _state.update { it.copy(invalidHub = true) }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            hubCall { graph.anonymous(parsed.origin).meta.metaGet() }
                .onSuccess { meta ->
                    graph.store.lastHub = parsed.origin
                    _state.update {
                        it.copy(
                            busy = false, hub = parsed.origin, hubName = meta.name,
                            step = if (meta.setupRequired) ConnectStep.SETUP else ConnectStep.LOGIN,
                            setupOpen = meta.setupOpen,
                        )
                    }
                }
                .onFailure { e -> _state.update { it.copy(busy = false, error = e as HubError) } }
        }
    }

    private fun language() = if (graph.prefs.effectiveLanguage.tag == "ar") "ar" else "en"

    fun signIn(username: String, password: String) {
        val hub = _state.value.hub ?: return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            hubCall {
                graph.anonymous(hub).auth.authLogin(
                    LoginRequest(username.trim(), password),
                    AuthApi.AcceptLanguageAuthLogin.entries.first { it.value == language() },
                )
            }.onSuccess { pair ->
                store(hub, TokenKind.SESSION, pair.accessToken, pair.refreshToken, pair.expiresIn * 1000L, pair.user, ttl = null)
            }.onFailure { e -> _state.update { it.copy(busy = false, error = e as HubError) } }
        }
    }

    fun completeSetup(username: String, displayName: String, password: String, token: String) {
        val hub = _state.value.hub ?: return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            hubCall {
                graph.anonymous(hub).auth.authCompleteSetup(
                    SetupRequest(
                        username = username.trim(),
                        password = password,
                        token = token.trim().ifEmpty { null },
                        displayName = displayName.trim().ifEmpty { null },
                    ),
                    AuthApi.AcceptLanguageAuthCompleteSetup.entries.first { it.value == language() },
                )
            }.onSuccess { pair ->
                store(hub, TokenKind.SESSION, pair.accessToken, pair.refreshToken, pair.expiresIn * 1000L, pair.user, ttl = null)
            }.onFailure { e -> _state.update { it.copy(busy = false, error = e as HubError) } }
        }
    }

    /** Claims a pairing a signed-in client drew as a QR: this phone becomes one of the person's devices. */
    fun claim(request: PairingRequest?, deviceName: String) {
        if (request == null) {
            _state.update { it.copy(invalidPairing = true) }
            return
        }
        _state.update { it.copy(busy = true, error = null, invalidPairing = false) }
        viewModelScope.launch {
            val registration = DeviceRegistration(
                deviceKey = graph.store.deviceKey,
                name = deviceName.take(80),
                platform = DevicePlatform.ANDROID,
                kind = DeviceKind.PHONE,
                brand = Build.MANUFACTURER,
                model = Build.MODEL,
                appVersion = BuildConfig.VERSION_NAME,
                capabilities = emptyList(),
            )
            hubCall {
                graph.anonymous(request.hub).auth.authClaimPairing(request.pairingId, PairingClaim(request.code, registration))
            }.onSuccess { result ->
                graph.store.lastHub = request.hub
                val now = System.currentTimeMillis()
                val expires = result.expiresAt?.toInstant()?.toEpochMilli()
                store(request.hub, TokenKind.APP, result.appToken, null, expires?.minus(now), result.user, ttl = expires?.minus(now))
            }.onFailure { e -> _state.update { it.copy(busy = false, error = e as HubError) } }
        }
    }

    fun rejectPairing() = _state.update { it.copy(invalidPairing = true) }

    private fun store(hub: String, kind: TokenKind, token: String, refresh: String?, lifetimeMs: Long?, user: User, ttl: Long?) {
        val stored = StoredUser.from(user)
        val profile = stored.defaultProfile.takeIf { it in stored.profiles } ?: stored.profiles.firstOrNull() ?: stored.defaultProfile
        graph.store.save(
            StoredSession(
                hub = hub,
                kind = kind,
                accessToken = token,
                refreshToken = refresh,
                expiresAt = lifetimeMs?.let { System.currentTimeMillis() + it },
                ttlMs = ttl,
                user = stored,
                profile = profile,
            ),
        )
        _state.update { it.copy(busy = false) }
    }
}

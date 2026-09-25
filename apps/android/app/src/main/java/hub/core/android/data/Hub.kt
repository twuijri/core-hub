package hub.core.android.data

import hub.core.client.api.AgentsApi
import hub.core.client.api.AuditApi
import hub.core.client.api.AuthApi
import hub.core.client.api.DevicesApi
import hub.core.client.api.MetaApi
import hub.core.client.api.ModelsApi
import hub.core.client.api.NotifyApi
import hub.core.client.api.RoomsApi
import hub.core.client.api.SchedulesApi
import hub.core.client.api.SessionsApi
import hub.core.client.api.TasksApi
import hub.core.client.api.UpdatesApi
import hub.core.client.infrastructure.ClientError
import hub.core.client.infrastructure.ClientException
import hub.core.client.infrastructure.ServerError
import hub.core.client.infrastructure.ServerException
import hub.core.client.model.RefreshRequest
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** The API base of a hub: the contract's `servers[0]`, as the generated client carries it. */
fun apiBase(hub: String) = hub + MetaApi.defaultBasePath

/**
 * Every operation the app calls, all generated from the contract (ADR 0003). One instance per
 * hub; every scoped call names its profile explicitly (`X-Hub-Profile`), so acting on an item
 * from another profile never moves the top selector (ADR 0016).
 */
class HubApis(hub: String, client: OkHttpClient) {
    private val base = apiBase(hub)
    val meta = MetaApi(base, client)
    val auth = AuthApi(base, client)
    val sessions = SessionsApi(base, client)
    val agents = AgentsApi(base, client)
    val tasks = TasksApi(base, client)
    val schedules = SchedulesApi(base, client)
    val notify = NotifyApi(base, client)
    val rooms = RoomsApi(base, client)
    val updates = UpdatesApi(base, client)
    val devices = DevicesApi(base, client)
    val audit = AuditApi(base, client)
    /** Speech: whether the profile's STT / TTS providers are ready, transcribing, speaking. */
    val models = ModelsApi(base, client)
}

/** A failed call, with the hub's own `{ error, code }` when it sent one. */
data class HubError(
    val status: Int,
    val code: String?,
    val text: String?,
    /** `details.reason`, where the hub names why (e.g. `no_speech` for a silent recording). */
    val reason: String? = null,
    /** `details.max_bytes` of a `413`: the most the hub takes. */
    val maxBytes: Long? = null,
) : Exception(text ?: code) {
    val offline: Boolean get() = status == 0

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun bodyFields(body: String?): Pair<String?, String?> {
            val obj = body?.let { runCatching { json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
            fun str(key: String) = (obj?.get(key) as? JsonPrimitive)?.contentOrNull
            return str("code") to str("error")
        }

        fun reasonOf(body: String?): String? {
            val obj = body?.let { runCatching { json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
            return ((obj?.get("details") as? JsonObject)?.get("reason") as? JsonPrimitive)?.contentOrNull
        }

        fun maxBytesOf(body: String?): Long? {
            val obj = body?.let { runCatching { json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
            return ((obj?.get("details") as? JsonObject)?.get("max_bytes") as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
        }

        fun from(error: Throwable): HubError = when (error) {
            is HubError -> error
            is ClientException -> {
                val body = (error.response as? ClientError<*>)?.body as? String
                val (code, text) = bodyFields(body)
                HubError(error.statusCode, code, text, reasonOf(body), maxBytesOf(body))
            }
            is ServerException -> {
                val (code, text) = bodyFields((error.response as? ServerError<*>)?.body as? String)
                HubError(error.statusCode, code, text)
            }
            is IOException -> HubError(0, "offline", null)
            else -> HubError(-1, null, error.message)
        }
    }
}

/** Runs a call and turns any failure into a [HubError]. */
suspend fun <T> hubCall(block: suspend () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Throwable) {
        Result.failure(HubError.from(e))
    }

/** How early a token is renewed: a web session 30 s before it lapses, an app token 7 days. */
object RefreshPolicy {
    const val SESSION_MARGIN_MS = 30_000L
    const val APP_MARGIN_MS = 7L * 24 * 60 * 60 * 1000

    fun due(session: StoredSession, now: Long): Boolean {
        val expires = session.expiresAt ?: return false
        val margin = if (session.kind == TokenKind.SESSION) SESSION_MARGIN_MS else APP_MARGIN_MS
        return expires - now < margin
    }
}

/**
 * Renews the stored token with `auth.refresh`, once at a time: concurrent requests that find
 * the same expired token wait for one refresh instead of each rotating the refresh token (a
 * second rotation of the same token would sign the person out).
 */
class TokenRefresher(
    private val store: SessionStore,
    private val plain: OkHttpClient,
    private val clock: () -> Long = System::currentTimeMillis,
    private val onSignedOut: (reason: String?) -> Unit,
) {
    private val lock = Any()

    /** A session whose token works, `used` again when the hub could not be reached, or null when refused. */
    fun refresh(used: StoredSession): StoredSession? = synchronized(lock) {
        val latest = store.current ?: return null
        if (latest.accessToken != used.accessToken || latest.refreshToken != used.refreshToken) return latest
        try {
            val renewed = runBlocking {
                when (latest.kind) {
                    TokenKind.SESSION -> {
                        val refreshToken = latest.refreshToken ?: throw HubError(401, "unauthorized", null)
                        val pair = AuthApi(apiBase(latest.hub), plain).authRefresh(RefreshRequest(refreshToken))
                        latest.copy(
                            accessToken = pair.accessToken,
                            refreshToken = pair.refreshToken ?: refreshToken,
                            expiresAt = clock() + pair.expiresIn * 1000L,
                            user = StoredUser.from(pair.user),
                        )
                    }
                    TokenKind.APP -> {
                        val bearer = plain.newBuilder().addInterceptor(BearerInterceptor(latest.accessToken)).build()
                        val pair = AuthApi(apiBase(latest.hub), bearer).authRefresh(null)
                        latest.copy(
                            expiresAt = latest.ttlMs?.let { clock() + it } ?: latest.expiresAt,
                            user = StoredUser.from(pair.user),
                        )
                    }
                }
            }
            store.save(renewed)
            renewed
        } catch (e: Throwable) {
            val error = HubError.from(e)
            if (error.status == 401 || error.status == 403) {
                store.save(null)
                onSignedOut(error.code)
                null
            } else {
                latest
            }
        }
    }
}

private class BearerInterceptor(private val token: String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response =
        chain.proceed(chain.request().newBuilder().header("Authorization", "Bearer $token").build())
}

/**
 * Adds the bearer and the UI language to every request, renews a token that is about to
 * lapse, and on `401 token_expired` refreshes once and retries. Any other 401 means access was
 * taken away (sign-out elsewhere, a revoked device): the app forgets the session.
 */
class AuthInterceptor(
    private val store: SessionStore,
    private val refresher: TokenRefresher,
    private val language: () -> String,
    private val clock: () -> Long = System::currentTimeMillis,
    private val onSignedOut: (reason: String?) -> Unit,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request().withLanguage()
        var session = store.current ?: return chain.proceed(original)
        if (RefreshPolicy.due(session, clock())) session = refresher.refresh(session) ?: return chain.proceed(original)
        val response = chain.proceed(original.withBearer(session.accessToken))
        if (response.code != 401) return response
        val (code, _) = HubError.bodyFields(response.peekBody(8_192).string())
        if (code == "token_expired") {
            val renewed = refresher.refresh(session) ?: return response
            if (renewed.accessToken == session.accessToken && renewed.kind == TokenKind.SESSION) return response
            response.close()
            return chain.proceed(original.withBearer(renewed.accessToken))
        }
        if (store.current?.accessToken == session.accessToken) {
            store.save(null)
            onSignedOut(code)
        }
        return response
    }

    private fun Request.withBearer(token: String) = newBuilder().header("Authorization", "Bearer $token").build()

    private fun Request.withLanguage(): Request =
        if (header("Accept-Language") != null) this else newBuilder().header("Accept-Language", language()).build()
}

/** The HTTP clients of the app: `plain` has no credentials (sign-in, pairing), `authed` does. */
class HttpClients(store: SessionStore, language: () -> String, onSignedOut: (String?) -> Unit) {
    val plain: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val request = chain.request()
            chain.proceed(
                if (request.header("Accept-Language") != null) request
                else request.newBuilder().header("Accept-Language", language()).build(),
            )
        }
        .build()
    private val refresher = TokenRefresher(store, plain, onSignedOut = onSignedOut)
    val authed: OkHttpClient = plain.newBuilder()
        .addInterceptor(AuthInterceptor(store, refresher, language, onSignedOut = onSignedOut))
        .build()
}

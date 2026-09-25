package hub.core.android.data

import hub.core.android.memoryStore
import hub.core.android.storedSession
import hub.core.android.userJson
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The token rules of the contract, against a scripted hub. */
class AuthTest {
    private val server = MockWebServer()
    private val store = memoryStore()
    private val signedOut = mutableListOf<String?>()
    private var now = 1_000_000L
    private lateinit var client: OkHttpClient
    private val refreshes = java.util.concurrent.atomic.AtomicInteger()

    private fun tokenPair(access: String, refresh: String?) = MockResponse().setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody("""{"access_token":"$access","refresh_token":${refresh?.let { "\"$it\"" } ?: "null"},"expires_in":900,"user":${userJson()}}""")

    private fun expired() = MockResponse().setResponseCode(401).setBody("""{"error":"Token expired","code":"token_expired"}""")

    @Before fun start() {
        server.start()
        val plain = OkHttpClient()
        val refresher = TokenRefresher(store, plain, { now }) { signedOut += it }
        client = plain.newBuilder().addInterceptor(AuthInterceptor(store, refresher, { "ar" }, { now }) { signedOut += it }).build()
    }

    @After fun stop() = server.shutdown()

    private fun hub() = server.url("/").toString().trimEnd('/')
    private fun get() = client.newCall(Request.Builder().url(server.url("/api/v1/auth/me")).build()).execute()

    @Test fun `an expired web session refreshes once and the request is retried`() {
        store.save(storedSession(hub = hub(), token = "old", refresh = "r1", expiresAt = now + 600_000))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v1/auth/refresh" -> {
                    refreshes.incrementAndGet()
                    assertTrue(request.body.readUtf8().contains("\"refresh_token\":\"r1\""))
                    tokenPair("new", "r2")
                }
                request.getHeader("Authorization") == "Bearer old" -> expired()
                else -> MockResponse().setBody(userJson())
            }
        }
        get().use { assertEquals(200, it.code) }
        assertEquals("new", store.current!!.accessToken)
        assertEquals("r2", store.current!!.refreshToken)
        assertEquals(1, refreshes.get())
        assertEquals("ar", server.takeRequest().getHeader("Accept-Language"))
    }

    @Test fun `concurrent requests that find the same expired token share one refresh`() {
        store.save(storedSession(hub = hub(), token = "old", refresh = "r1", expiresAt = now + 600_000))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v1/auth/refresh" -> {
                    refreshes.incrementAndGet()
                    Thread.sleep(100)
                    tokenPair("new", "r2")
                }
                request.getHeader("Authorization") == "Bearer old" -> expired()
                else -> MockResponse().setBody("{}")
            }
        }
        val pool = Executors.newFixedThreadPool(4)
        val done = CountDownLatch(4)
        val codes = java.util.concurrent.ConcurrentLinkedQueue<Int>()
        repeat(4) { pool.execute { get().use { codes += it.code }; done.countDown() } }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(listOf(200, 200, 200, 200), codes.toList())
        assertEquals(1, refreshes.get())
    }

    @Test fun `a session about to lapse is renewed before the request`() {
        store.save(storedSession(hub = hub(), token = "old", refresh = "r1", expiresAt = now + 10_000))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path == "/api/v1/auth/refresh") tokenPair("fresh", "r2") else MockResponse().setBody("{}")
        }
        get().use { assertEquals(200, it.code) }
        server.takeRequest()
        assertEquals("Bearer fresh", server.takeRequest().getHeader("Authorization"))
        assertEquals(now + 900_000, store.current!!.expiresAt)
    }

    @Test fun `an app token renews with the bearer and no body, and keeps itself`() {
        store.save(storedSession(hub = hub(), kind = TokenKind.APP, token = "app-token", refresh = null, expiresAt = now + 1_000, ttlMs = 90L * 86_400_000))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path == "/api/v1/auth/refresh") {
                    assertEquals("Bearer app-token", request.getHeader("Authorization"))
                    assertEquals(0L, request.bodySize)
                    tokenPair("jwt-not-kept", null)
                } else MockResponse().setBody("{}")
        }
        get().use { assertEquals(200, it.code) }
        assertEquals("app-token", store.current!!.accessToken)
        assertEquals(now + 90L * 86_400_000, store.current!!.expiresAt)
    }

    @Test fun `a refused refresh signs the person out`() {
        store.save(storedSession(hub = hub(), token = "old", refresh = "stale", expiresAt = now + 600_000))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path == "/api/v1/auth/refresh") MockResponse().setResponseCode(401).setBody("""{"error":"no","code":"unauthorized"}""")
                else expired()
        }
        get().use { assertEquals(401, it.code) }
        assertNull(store.current)
        assertEquals(listOf<String?>("unauthorized"), signedOut)
    }

    @Test fun `a revoked token signs the person out without a refresh`() {
        store.save(storedSession(hub = hub(), token = "revoked", expiresAt = now + 600_000))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Token revoked","code":"unauthorized"}"""))
        get().use { assertEquals(401, it.code) }
        assertNull(store.current)
        assertEquals(1, server.requestCount)
    }

    @Test fun `an unreachable hub during a refresh keeps the session`() {
        store.save(storedSession(hub = "http://127.0.0.1:1", token = "old", expiresAt = now + 1_000))
        val refresher = TokenRefresher(store, OkHttpClient(), { now }) { signedOut += it }
        assertEquals("old", refresher.refresh(store.current!!)!!.accessToken)
        assertEquals(emptyList<String?>(), signedOut)
    }

    @Test fun `the hub's error envelope is read`() {
        assertEquals("token_expired" to "Token expired", HubError.bodyFields("""{"error":"Token expired","code":"token_expired"}"""))
        assertEquals(null to null, HubError.bodyFields("<html>"))
    }
}

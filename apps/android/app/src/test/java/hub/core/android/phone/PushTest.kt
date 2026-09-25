package hub.core.android.phone

import hub.core.android.data.HubApis
import hub.core.android.data.TokenKind
import hub.core.android.memoryStore
import hub.core.android.storedSession
import hub.core.client.model.DeviceKind
import hub.core.client.model.DevicePlatform
import hub.core.client.model.DeviceRegistration
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
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

/** FCM registration against a scripted hub, and where a tapped push leads. */
class PushTest {
    private val server = MockWebServer()
    private val store = memoryStore()
    private val calls = mutableListOf<String>()
    private val bodies = mutableMapOf<String, String>()
    private var providers = """["webpush","fcm"]"""
    private var registerPushStatus = 200
    private val devices = mutableListOf<String>()

    private val registrar = PushRegistrar(store, { HubApis(it.hub, OkHttpClient()) }) {
        DeviceRegistration("key-1", "Pixel 9", DevicePlatform.ANDROID, DeviceKind.PHONE)
    }

    private fun json(body: String, status: Int = 200) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    private fun device(id: String, thisDevice: Boolean) = """
        {"id":"$id","user_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","device_key":"key-1","name":"Pixel 9","platform":"android",
         "kind":"phone","brand":null,"model":null,"app_version":null,"connection":"lan","online":false,
         "last_seen_at":null,"app_token_id":null,"capabilities":[],"push":null,"this_device":$thisDevice,
         "created_at":"2026-09-24T20:00:00Z","updated_at":"2026-09-25T09:00:00Z"}
    """.trimIndent()

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val call = "${request.method} ${request.path}"
                calls += call
                bodies[call] = request.body.readUtf8()
                return when {
                    call == "GET /api/v1/push/config" -> json("""{"webpush_public_key":null,"providers":$providers}""")
                    call == "POST /api/v1/devices" -> {
                        val id = "01J8QK3ZR2W7M5N4P6T8V9X0D${devices.size}"
                        devices += id
                        json(device(id, thisDevice = true), 201)
                    }
                    call.startsWith("GET /api/v1/devices") -> json(
                        """{"items":[${device("01J8QK3ZR2W7M5N4P6T8V9X0XX", false)},${device("01J8QK3ZR2W7M5N4P6T8V9X0ME", true)}],"next_cursor":null}""",
                    )
                    call.startsWith("PUT /api/v1/devices/") && call.endsWith("/push") -> when (registerPushStatus) {
                        200 -> json("""{"provider":"fcm","locale":"ar","registered_at":"2026-09-26T10:00:00Z"}""")
                        409 -> json("""{"error":"Not configured","code":"conflict","details":{"reason":"sender_not_configured"}}""", 409)
                        else -> json("""{"error":"Not found","code":"not_found"}""", registerPushStatus).also { registerPushStatus = 200 }
                    }
                    call.startsWith("DELETE /api/v1/devices/") -> MockResponse().setResponseCode(204)
                    else -> json("""{"error":"unexpected $call"}""", 500)
                }
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun hub() = server.url("/").toString().trimEnd('/')

    @Test fun `a password sign-in registers this phone as a device once, then its FCM token`() = runTest {
        store.save(storedSession(hub = hub()))
        val outcome = registrar.register("fcm-token-1", "ar")
        assertEquals(PushRegistrar.Outcome.Registered("01J8QK3ZR2W7M5N4P6T8V9X0D0"), outcome)
        assertEquals(
            listOf("GET /api/v1/push/config", "POST /api/v1/devices", "PUT /api/v1/devices/01J8QK3ZR2W7M5N4P6T8V9X0D0/push"),
            calls,
        )
        assertTrue(bodies.getValue("POST /api/v1/devices").contains("\"device_key\":\"key-1\""))
        val push = bodies.getValue("PUT /api/v1/devices/01J8QK3ZR2W7M5N4P6T8V9X0D0/push")
        assertTrue(push, push.contains("\"provider\":\"fcm\"") && push.contains("\"token\":\"fcm-token-1\"") && push.contains("\"locale\":\"ar\""))
        assertEquals("01J8QK3ZR2W7M5N4P6T8V9X0D0", store.current!!.deviceId)

        // A rotated token (onNewToken) goes to the same device, without registering it again.
        calls.clear()
        registrar.register("fcm-token-2", "en")
        assertEquals(listOf("GET /api/v1/push/config", "PUT /api/v1/devices/01J8QK3ZR2W7M5N4P6T8V9X0D0/push"), calls)
        assertTrue(bodies.getValue(calls.last()).contains("\"locale\":\"en\""))
    }

    @Test fun `a paired phone registers against the device its pairing made`() = runTest {
        store.save(storedSession(hub = hub(), kind = TokenKind.APP, refresh = null).copy(deviceId = "01J8QK3ZR2W7M5N4P6T8V9X0DV"))
        registrar.register("fcm-token", "ar")
        assertEquals(listOf("GET /api/v1/push/config", "PUT /api/v1/devices/01J8QK3ZR2W7M5N4P6T8V9X0DV/push"), calls)
    }

    @Test fun `a phone paired before the id was kept finds itself in the device list`() = runTest {
        store.save(storedSession(hub = hub(), kind = TokenKind.APP, refresh = null))
        val outcome = registrar.register("fcm-token", "ar")
        assertEquals(PushRegistrar.Outcome.Registered("01J8QK3ZR2W7M5N4P6T8V9X0ME"), outcome)
        assertTrue(calls.none { it.startsWith("POST") })
        assertEquals("01J8QK3ZR2W7M5N4P6T8V9X0ME", store.current!!.deviceId)
    }

    @Test fun `a hub without an FCM sender leaves the phone polling`() = runTest {
        store.save(storedSession(hub = hub()))
        providers = """["webpush"]"""
        assertEquals(PushRegistrar.Outcome.NoSender, registrar.register("fcm-token", "ar"))
        assertEquals(listOf("GET /api/v1/push/config"), calls)

        providers = """["webpush","fcm"]"""
        registerPushStatus = 409
        assertEquals(PushRegistrar.Outcome.NoSender, registrar.register("fcm-token", "ar"))
    }

    @Test fun `a device removed on the web is registered again, once`() = runTest {
        store.save(storedSession(hub = hub()).copy(deviceId = "01J8QK3ZR2W7M5N4P6T8V9X0GN"))
        registerPushStatus = 404
        val outcome = registrar.register("fcm-token", "ar")
        assertEquals(PushRegistrar.Outcome.Registered("01J8QK3ZR2W7M5N4P6T8V9X0D0"), outcome)
        assertEquals(
            listOf(
                "GET /api/v1/push/config",
                "PUT /api/v1/devices/01J8QK3ZR2W7M5N4P6T8V9X0GN/push",
                "POST /api/v1/devices",
                "PUT /api/v1/devices/01J8QK3ZR2W7M5N4P6T8V9X0D0/push",
            ),
            calls,
        )
    }

    @Test fun `signing out removes the push registration, and nothing is sent without a device`() = runTest {
        registrar.unregister(storedSession(hub = hub()))
        assertTrue(calls.isEmpty())
        registrar.unregister(storedSession(hub = hub()).copy(deviceId = "01J8QK3ZR2W7M5N4P6T8V9X0D0"))
        assertEquals(listOf("DELETE /api/v1/devices/01J8QK3ZR2W7M5N4P6T8V9X0D0/push"), calls)
    }

    @Test fun `signed out, nothing is registered`() = runTest {
        assertEquals(PushRegistrar.Outcome.SignedOut, registrar.register("fcm-token", "ar"))
        assertTrue(calls.isEmpty())
    }

    @Test fun `a tapped push opens what the notice is about`() {
        fun data(vararg pairs: Pair<String, String?>) = mapOf("type" to "notice", "notice_id" to "N1", "kind" to "run_completed") + pairs
        assertEquals(
            "/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA?profile=work",
            PushPayload.path(data("resource_kind" to "session", "resource_id" to "01J8QK3ZR2W7M5N4P6T8V9X0YA", "profile" to "work")),
        )
        assertEquals("/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA", PushPayload.path(data("resource_kind" to "session", "resource_id" to "01J8QK3ZR2W7M5N4P6T8V9X0YA")))
        assertEquals("/tasks", PushPayload.path(data("resource_kind" to "task", "resource_id" to "T")))
        assertEquals("/schedules", PushPayload.path(data("resource_kind" to "workflow_run", "resource_id" to "R")))
        assertEquals("/settings/notifications", PushPayload.path(data()))
        assertEquals("/settings/notifications", PushPayload.path(data("resource_kind" to "session")))
        // An id that is not a plain id cannot break out of the path.
        assertEquals("/chat/a%2F..%2Fb", PushPayload.path(data("resource_kind" to "session", "resource_id" to "a/../b")))
        assertNull(PushPayload.path(mapOf("resource_kind" to "session", "resource_id" to "X")))
        assertNull(PushPayload.path(mapOf("type" to "other")))
    }
}

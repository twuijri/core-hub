package hub.core.android.parity

import hub.core.android.MemoryPrefs
import hub.core.android.data.HubApis
import hub.core.android.phone.LocationChoice
import hub.core.android.phone.LocationChoices
import hub.core.android.phone.LocationRequests
import hub.core.android.phone.Locating
import hub.core.android.realtime.Envelope
import hub.core.android.storedSession
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.CapabilityKind
import hub.core.client.model.DeviceRequest
import java.time.OffsetDateTime
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** An agent asks where the phone is (§103): what the phone does with the request, and what it sends. */
class LocateTest {
    private val json = Serializer.kotlinxSerializationJson

    private fun requestJson(capability: String = "location", status: String = "pending", expires: String = "2099-01-01T00:00:00Z") = """
        {"id":"01J8QK3ZR2W7M5N4P6T8V9X0RQ","profile":"work","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","created_at":"2026-09-26T09:00:00Z",
         "updated_at":"2026-09-26T09:00:00Z","device_id":"01J8QK3ZR2W7M5N4P6T8V9X0DV","session_id":null,"run_id":"01J8QK3ZR2W7M5N4P6T8V9X0RN",
         "job_id":"01J8QK3ZR2W7M5N4P6T8V9X0JB","capability":"$capability","purpose":"أقرب صيدلية","params":{},"status":"$status",
         "expires_at":"$expires","result":null,"error":null}
    """.trimIndent()

    private fun request(capability: String = "location", status: String = "pending", expires: String = "2099-01-01T00:00:00Z") =
        json.decodeFromString(DeviceRequest.serializer(), requestJson(capability, status, expires))

    @Test fun `the first time the person is asked, their always or never is kept`() {
        assertEquals(Locating.Next.ASK, Locating.next(request(), LocationChoice.ASK))
        assertEquals(Locating.Next.ANSWER, Locating.next(request(), LocationChoice.ALWAYS))
        assertEquals(Locating.Next.DENY, Locating.next(request(), LocationChoice.NEVER))
        assertEquals(Locating.Next.IGNORE, Locating.next(request(capability = "camera"), LocationChoice.ALWAYS))
        assertEquals(Locating.Next.IGNORE, Locating.next(request(status = "expired"), LocationChoice.ALWAYS))
        assertEquals(Locating.Next.IGNORE, Locating.next(request(expires = "2026-01-01T00:00:00Z"), LocationChoice.ASK, OffsetDateTime.parse("2026-09-26T09:00:00Z")))
        assertTrue(Locating.capability(LocationChoice.ASK).enabled)
        assertFalse(Locating.capability(LocationChoice.NEVER).enabled)
        assertEquals(CapabilityKind.LOCATION, Locating.capability(LocationChoice.NEVER).kind)
    }

    @Test fun `a location is the one shape the hub takes`() {
        val r = Locating.result(24.7136, 46.6753, -3.0, 1_790_000_000_000)
        assertEquals("24.7136", r.getValue("latitude").toString())
        assertEquals("0.0", r.getValue("accuracy_m").toString())
        assertEquals("\"2026-09-21T14:13:20Z\"", r.getValue("captured_at").toString())
    }

    @Test fun `only a request made for this phone on the devices socket is heard`() {
        val payload = JsonObject(mapOf("request" to json.parseToJsonElement(requestJson())))
        assertEquals("01J8QK3ZR2W7M5N4P6T8V9X0RQ", Locating.requestOf(Envelope("request.created", "/rt/devices", "work", 3, "t", payload))?.id)
        assertNull(Locating.requestOf(Envelope("request.completed", "/rt/devices", "work", 3, "t", payload)))
        assertNull(Locating.requestOf(Envelope("request.created", "/rt/sessions", "work", 3, "t", payload)))
    }

    // ------------------------------------------------------------------ what it sends

    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.requestUrl!!.encodedPath
                val body = when {
                    path.endsWith("/respond") -> requestJson(status = "fulfilled")
                    path.endsWith("/device-requests") -> """{"items":[${requestJson()}],"next_cursor":null}"""
                    else -> return MockResponse().setResponseCode(404)
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun locations(choice: LocationChoice, place: Boolean = true): LocationRequests {
        val choices = LocationChoices(MemoryPrefs()).apply { set(choice) }
        val session = storedSession(hub = server.url("/").toString().trimEnd('/')).copy(deviceId = "01J8QK3ZR2W7M5N4P6T8V9X0DV")
        return LocationRequests({ HubApis(session.hub, OkHttpClient()) to session }, choices) {
            if (place) Locating.result(24.7, 46.7, 12.0, 1_790_000_000_000) else null
        }
    }

    @Test fun `asked once, a yes sends the place and a remembered no says so from then on`() = runTest {
        val l = locations(LocationChoice.ASK)
        l.catchUp()
        val list = requests.first()
        assertEquals("01J8QK3ZR2W7M5N4P6T8V9X0DV", list.requestUrl!!.queryParameter("device_id"))
        assertEquals("pending", list.requestUrl!!.queryParameter("status"))
        assertEquals(1, l.waiting.value.size)

        l.decide(l.waiting.value.first(), allow = true, remember = false)
        assertTrue(l.waiting.value.isEmpty())
        val answer = requests.last()
        assertEquals("work", answer.getHeader("X-Hub-Profile"))
        val body = json.parseToJsonElement(answer.body.readUtf8()).jsonObject
        assertEquals("\"fulfilled\"", body.getValue("status").toString())
        assertEquals("46.7", body.getValue("result").jsonObject.getValue("longitude").toString())

        val never = locations(LocationChoice.NEVER)
        never.heard(request())
        val no = json.parseToJsonElement(requests.last().body.readUtf8()).jsonObject
        assertEquals("\"denied\"", no.getValue("status").toString())
        assertEquals("\"permission_denied\"", no.getValue("error").jsonObject.getValue("code").toString())
        assertTrue(never.waiting.value.isEmpty())
    }

    @Test fun `always answers without asking, and a phone that cannot read its place says it failed`() = runTest {
        locations(LocationChoice.ALWAYS, place = false).heard(request())
        val body = json.parseToJsonElement(requests.last().body.readUtf8()).jsonObject
        assertEquals("\"failed\"", body.getValue("status").toString())
    }
}

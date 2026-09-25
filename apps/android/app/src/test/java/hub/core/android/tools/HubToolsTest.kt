package hub.core.android.tools

import hub.core.android.data.HubApis
import hub.core.client.model.LogLine
import java.time.OffsetDateTime
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Logs and Performance on the phone read the live endpoints (§51), against a scripted hub. */
class HubToolsTest {
    private val server = MockWebServer()
    private val requests = mutableListOf<RecordedRequest>()
    private var logs: (RecordedRequest) -> MockResponse = { json(page(listOf(line(1, "info", "hub started")), 1)) }
    private var performance: () -> MockResponse = { json(LIVE) }

    private fun json(body: String, status: Int = 200) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    private fun line(seq: Int, level: String, message: String, source: String = "hub", profile: String? = null) =
        """{"seq":$seq,"at":"2026-09-26T10:00:0${seq % 10}Z","level":"$level","source":"$source",
            "profile":${profile?.let { "\"$it\"" } ?: "null"},"message":"$message"}"""

    private fun page(lines: List<String>, last: Int) =
        """{"lines":[${lines.joinToString(",")}],"last_seq":$last,"capacity":5000,
            "sources":[{"source":"hub","profile":null,"lines":${lines.size}}]}"""

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.path.orEmpty()
                return when {
                    path.startsWith("/api/v1/audit/logs/lines") -> logs(request)
                    path == "/api/v1/audit/performance/live" -> performance()
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun audit() = HubApis(server.url("/").toString().trimEnd('/'), OkHttpClient()).audit

    private fun RecordedRequest.query(name: String): String? = requestUrl?.queryParameter(name)

    @Test fun errorsOnlyCarriesNoLevel_andEveryOtherSourceDoes() {
        val errors = Logs.query(LogsState(source = LogSource.ERRORS, level = LogLevel.WARN))
        assertNull(errors.level)
        assertEquals(LogSource.ERRORS, errors.source)
        assertEquals(Logs.LIMIT, errors.limit)
        assertEquals(LogLevel.WARN, Logs.query(LogsState(source = LogSource.HERMES, level = LogLevel.WARN)).level)
        assertEquals(7, Logs.query(LogsState(), after = 7).after)
    }

    @Test fun newerLinesGoUnderTheShownOnes_onceEach_andOnlyTheNewestStay() {
        fun l(seq: Int) = LogLine(seq, OffsetDateTime.parse("2026-09-26T10:00:00Z"), LogLine.Level.INFO, LogLine.Source.HUB, "m$seq")
        val shown = listOf(l(1), l(2), l(3))
        assertEquals(listOf(1, 2, 3, 4), Logs.append(shown, listOf(l(3), l(4))).map { it.seq })
        assertEquals(listOf(3, 4, 5), Logs.append(shown, listOf(l(4), l(5)), limit = 3).map { it.seq })
    }

    @Test fun loadsTheNewestLines_thenRefreshAsksOnlyForNewerOnes() = runTest {
        val model = LogsModel(::audit)
        model.load()
        val first = requests.single()
        assertEquals("/api/v1/audit/logs/lines", first.requestUrl!!.encodedPath)
        assertEquals("all", first.query("source"))
        assertEquals("debug", first.query("level"))
        assertEquals("200", first.query("limit"))
        assertNull(first.query("after"))
        assertEquals(listOf("hub started"), model.state.value.lines.map { it.message })
        assertFalse(model.state.value.loading)

        logs = { json(page(listOf(line(2, "error", "gateway exited", "hermes", "work")), 2)) }
        model.refresh()
        assertEquals("1", requests.last().query("after"))
        val state = model.state.value
        assertEquals(listOf(1, 2), state.lines.map { it.seq })
        assertEquals(2, state.lastSeq)
        assertEquals(LogLine.Source.HERMES, state.lines.last().source)
        assertEquals("work", state.lines.last().profile)
    }

    @Test fun aNewFilterIsANewPage_andErrorsOnlySendsNoLevel() = runTest {
        val model = LogsModel(::audit)
        model.load()
        model.setLevel(LogLevel.WARN)
        assertEquals("warn", requests.last().query("level"))
        assertNull(requests.last().query("after"))

        logs = { json(page(listOf(line(9, "error", "boom")), 9)) }
        model.setSource(LogSource.ERRORS)
        val sent = requests.last()
        assertEquals("errors", sent.query("source"))
        assertNull(sent.query("level"))
        assertEquals(listOf(9), model.state.value.lines.map { it.seq })
    }

    @Test fun aMemberIsToldWhyNotShownNothing() = runTest {
        logs = { json("""{"error":"Only owners and admins can do this.","code":"forbidden"}""", 403) }
        val model = LogsModel(::audit)
        model.load()
        val state = model.state.value
        assertEquals(403, state.error?.status)
        assertEquals("forbidden", state.error?.code)
        assertTrue(state.lines.isEmpty())
        assertFalse(state.loading)
    }

    @Test fun performanceReadsOneMeasurement_nullsStayNull_andTheHubSetsThePace() = runTest {
        val model = PerformanceModel(::audit)
        assertEquals(PerformanceModel.DEFAULT_INTERVAL_SECONDS * 1000L, model.intervalMs)
        model.refresh()
        val live = model.state.value.live!!
        assertEquals("proc", live.host.measuredFrom.value)
        assertEquals(8, live.host.cpuCount)
        assertEquals("12.5", live.host.cpuPercent!!.toPlainString())
        assertEquals(2, live.processes.size)
        // A process the host could not measure has no numbers, never zeros.
        assertNull(live.processes[1].cpuPercent)
        assertNull(live.processes[1].rssBytes)
        assertEquals("work", live.profiles.single().profile)
        assertEquals(3_000L, model.intervalMs)

        // A failed look keeps the last measurement, with the reason.
        performance = { MockResponse().setResponseCode(503).setBody("""{"error":"down","code":"unavailable"}""") }
        model.refresh()
        assertEquals(503, model.state.value.error?.status)
        assertNotNull(model.state.value.live)
    }

    private companion object {
        val LIVE = """
            {"at":"2026-09-26T10:00:05Z","interval_seconds":3,
             "host":{"platform":"linux","measured_from":"proc","cpu_count":8,"cpu_percent":12.5,
                     "memory_total_bytes":16777216000,"memory_used_bytes":6442450944,"load":[0.42,0.51,0.6]},
             "hub":{"pid":1,"cpu_percent":1.8,"rss_bytes":184549376,"heap_used_bytes":71303168,
                    "event_loop_lag_ms":1.2,"uptime_seconds":86400,"node_version":"v24.8.0"},
             "processes":[
               {"kind":"tui_gateway","profile":null,"pid":58,"state":"running","cpu_percent":0.4,"rss_bytes":227540992,"uptime_seconds":3600},
               {"kind":"gateway","profile":"work","pid":null,"state":"starting","cpu_percent":null,"rss_bytes":null,"uptime_seconds":null}
             ],
             "profiles":[{"profile":"work","active_runs":1,"sessions":42,"sockets":2}],
             "history":[]}
        """.trimIndent()
    }
}

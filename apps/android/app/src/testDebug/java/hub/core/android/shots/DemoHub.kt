package hub.core.android.shots

import hub.core.android.repoRoot
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.io.File

/**
 * The iOS app's demo hub (apps/ios/CoreHub/Demo), served to the Android app over a local
 * MockWebServer: the same conversation, chats, agents and tasks the App Store screenshots show,
 * read from the generated `DemoFixtures.swift` (itself checked against the contract by
 * apps/ios/scripts/demo-fixtures.mjs), so the two apps' pictures show the same data side by side.
 * [extra] answers what the iOS demo has no page for yet (schedules, rooms, devices), in the
 * contract's shapes.
 */
class DemoHub(private val extra: Map<String, String> = emptyMap()) {
    private data class Route(val method: String, val pattern: Regex, val operation: String)

    private val source = File(repoRoot, "apps/ios/CoreHub/Demo/DemoFixtures.swift").readText()
    private val routes = Regex("""Route\(method: "(\w+)", pattern: #"(.+?)"#, operation: "([\w.]+)"\)""")
        .findAll(source).map { Route(it.groupValues[1], Regex(it.groupValues[2]), it.groupValues[3]) }.toList()
    private val answers: Map<String, String> = Regex("""^\s*"((?:en|ar) [^"]+)": ##"(.*)"##,?\s*$""", RegexOption.MULTILINE)
        .findAll(source).associate { it.groupValues[1] to it.groupValues[2] }

    val chatId: String = Regex("""static let chatID = "(\w+)"""").find(source)!!.groupValues[1]
    val server = MockWebServer()
    val base: String get() = server.url("/").toString().trimEnd('/')

    /** Operation → path pattern, for the extras (`GET ^/schedules$`). */
    private val extraRoutes = listOf(
        Route("GET", Regex("^/schedules$"), "schedules.list"),
        Route("GET", Regex("^/rooms$"), "rooms.list"),
        Route("GET", Regex("^/notify/notices$"), "notify.listNotices"),
    )

    fun start(): DemoHub {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath.orEmpty().removePrefix(API_BASE)
                val language = if (request.getHeader("Accept-Language")?.startsWith("ar") == true) "ar" else "en"
                for (route in routes + extraRoutes) {
                    if (route.method != request.method) continue
                    val match = route.pattern.find(path) ?: continue
                    val parameter = match.groupValues.getOrNull(1)
                    val keys = listOfNotNull(parameter?.let { "$language ${route.operation} $it" }, "$language ${route.operation}")
                    for (key in keys) {
                        (answers[key] ?: extra[key])?.let { return json(200, it) }
                    }
                }
                return json(404, """{"error":"Not in the demo hub.","code":"not_found"}""")
            }
        }
        server.start()
        return this
    }

    fun stop() = runCatching { server.shutdown() }

    private fun json(status: Int, body: String) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

    companion object {
        /** The contract's base path under the hub (the generated client's `defaultBasePath`). */
        const val API_BASE = "/api/v1"
    }
}

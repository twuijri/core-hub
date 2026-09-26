package hub.core.android.shots

import hub.core.android.repoRoot
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
 * What the iOS demo has no page for yet (schedules, rooms, devices…) is answered from [extra],
 * else from the contract's own example for that operation (packages/contracts/openapi.yaml).
 */
class DemoHub(private val extra: Map<String, String> = emptyMap()) {
    private data class Route(val method: String, val pattern: Regex, val operation: String)

    private val source = File(repoRoot, "apps/ios/CoreHub/Demo/DemoFixtures.swift").readText()
    private val routes = Regex("""Route\(method: "(\w+)", pattern: #"(.+?)"#, operation: "([\w.]+)"\)""")
        .findAll(source).map { Route(it.groupValues[1], Regex(it.groupValues[2]), it.groupValues[3]) }.toList()
    private val answers: Map<String, String> = Regex("""^\s*"((?:en|ar) [^"]+)": ##"(.*)"##,?\s*$""", RegexOption.MULTILINE)
        .findAll(source).associate { it.groupValues[1] to it.groupValues[2] }

    /**
     * The board as Android asks for it (`tasks.getColumns`), made from the same tasks the iOS demo
     * lists (`tasks.listTasks`), in the board's column order.
     */
    private val columns: Map<String, String> = listOf("en", "ar").mapNotNull { language ->
        val list = answers["$language tasks.listTasks"] ?: return@mapNotNull null
        val items = kotlinx.serialization.json.Json.parseToJsonElement(list).jsonObject.getValue("items").jsonArray
        val order = listOf("triage", "todo", "ready", "scheduled", "running", "blocked", "review", "done")
        val byStatus = items.groupBy { it.jsonObject.getValue("status").jsonPrimitive.content }
        val cols = order.joinToString(",", "[", "]") { status ->
            val tasks = byStatus[status].orEmpty()
            """{"status":"$status","count":${tasks.size},"tasks":${kotlinx.serialization.json.JsonArray(tasks)}}"""
        }
        val counts = order.joinToString(",", "{", "}") { "\"$it\":${byStatus[it].orEmpty().size}" }
        "$language tasks.getColumns" to """{"columns":$cols,"counts":{"total":${items.size},"by_status":$counts},"project_id":null}"""
    }.toMap()

    /** A test's own answer for a request (bytes, a changed page), before the fixtures; null to fall through. */
    @Volatile var raw: ((RecordedRequest) -> MockResponse?)? = null

    /** The fixture's answer for a key (`"en sessions.listMessages <id>"`), for a test to change. */
    fun answer(key: String): String? = answers[key]

    val chatId: String = Regex("""static let chatID = "(\w+)"""").find(source)!!.groupValues[1]
    val server = MockWebServer()

    /** What the app asked that no fixture answers (printed by the tests, to grow [extra]). */
    val missed: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    val base: String get() = server.url("/").toString().trimEnd('/')

    /** Every operation of the contract with the first example of its success response. */
    private val contract: List<Pair<Route, String>> = run {
        @Suppress("UNCHECKED_CAST")
        val doc = org.yaml.snakeyaml.Yaml().load<Map<String, Any?>>(File(repoRoot, "packages/contracts/openapi.yaml").readText())
        @Suppress("UNCHECKED_CAST")
        val paths = doc["paths"] as Map<String, Map<String, Any?>>
        buildList {
            for ((path, item) in paths) for ((method, opAny) in item) {
                val op = opAny as? Map<*, *> ?: continue
                val id = op["operationId"] as? String ?: continue
                val responses = op["responses"] as? Map<*, *> ?: continue
                val media = responses.entries.firstOrNull { it.key.toString().startsWith("2") }?.value
                    ?.let { ((it as? Map<*, *>)?.get("content") as? Map<*, *>)?.get("application/json") as? Map<*, *> } ?: continue
                val example = media["example"] ?: (media["examples"] as? Map<*, *>)?.values?.firstOrNull()?.let { (it as? Map<*, *>)?.get("value") } ?: continue
                val pattern = "^" + path.replace(Regex("\\{[^}]+}"), "([^/]+)") + "$"
                add(Route(method.uppercase(), Regex(pattern), id) to toJson(example))
            }
        }
    }

    private fun toJson(value: Any?): String = when (value) {
        null -> "null"
        is String -> kotlinx.serialization.json.JsonPrimitive(value).toString()
        is java.util.Date -> "\"" + value.toInstant().toString() + "\""
        is Number, is Boolean -> value.toString()
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") { (k, v) -> toJson(k.toString()) + ":" + toJson(v) }
        is List<*> -> value.joinToString(",", "[", "]") { toJson(it) }
        else -> toJson(value.toString())
    }

    fun start(): DemoHub {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                raw?.invoke(request)?.let { return it }
                val path = request.requestUrl?.encodedPath.orEmpty().removePrefix(API_BASE)
                val language = if (request.getHeader("Accept-Language")?.startsWith("ar") == true) "ar" else "en"
                for (route in routes) {
                    if (route.method != request.method) continue
                    val match = route.pattern.find(path) ?: continue
                    val parameter = match.groupValues.getOrNull(1)
                    val keys = listOfNotNull(parameter?.let { "$language ${route.operation} $it" }, "$language ${route.operation}")
                    for (key in keys) {
                        (answers[key] ?: extra[key] ?: columns[key])?.let { return json(200, it) }
                    }
                }
                // What the iOS demo has no page for: the extras here, else the contract's own example.
                for ((route, example) in contract) {
                    if (route.method != request.method || route.pattern.find(path) == null) continue
                    return json(200, extra["$language ${route.operation}"] ?: extra[route.operation] ?: columns["$language ${route.operation}"] ?: example)
                }
                missed += "${request.method} $path"
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
        /** The contract's base path under the hub: the generated client's own, never typed here (ADR 0003). */
        val API_BASE: String = hub.core.client.api.MetaApi.defaultBasePath.trimEnd('/')
    }
}

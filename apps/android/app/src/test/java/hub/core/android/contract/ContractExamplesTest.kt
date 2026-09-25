package hub.core.android.contract

import hub.core.android.repoRoot
import hub.core.client.infrastructure.Serializer
import java.io.File
import java.util.Date
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer
import org.junit.Assert.assertTrue
import org.junit.Test
import org.yaml.snakeyaml.Yaml

/**
 * Every JSON example the contract gives for a response is decoded by the generated Kotlin
 * client. This is what proves the generator's output reads what the hub really sends — the
 * nulls, the free-form tool arguments, the content blocks (packages/contracts/scripts/
 * kotlin-openapi.mjs makes those readable; without it most of these fail).
 */
class ContractExamplesTest {
    @Suppress("UNCHECKED_CAST")
    private val doc = Yaml().load<Map<String, Any?>>(File(repoRoot, "packages/contracts/openapi.yaml").readText())

    private fun toJson(value: Any?): String = when (value) {
        null -> "null"
        is String -> JsonPrimitive(value).toString()
        is Date -> "\"" + value.toInstant().toString() + "\""
        is Number, is Boolean -> value.toString()
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") { (k, v) -> toJson(k.toString()) + ":" + toJson(v) }
        is List<*> -> value.joinToString(",", "[", "]") { toJson(it) }
        else -> toJson(value.toString())
    }

    private fun className(operationId: String, code: String, schema: Map<*, *>): String? {
        (schema["\$ref"] as? String)?.let { return it.substringAfterLast('/') }
        // Inline response shapes are named after the operation: sessions.list 200 → SessionsList200Response.
        val op = operationId.split('.').joinToString("") { part -> part.replaceFirstChar(Char::uppercase) }
        return "${op}${code}Response"
    }

    @Test fun `every response example in the contract decodes`() {
        var decoded = 0
        val failures = mutableListOf<String>()
        @Suppress("UNCHECKED_CAST")
        val paths = doc["paths"] as Map<String, Map<String, Any?>>
        for ((path, item) in paths) for ((method, opAny) in item) {
            val op = opAny as? Map<*, *> ?: continue
            val operationId = op["operationId"] as? String ?: continue
            val responses = op["responses"] as? Map<*, *> ?: continue
            for ((code, responseAny) in responses) {
                if (!code.toString().startsWith("2")) continue
                val media = ((responseAny as? Map<*, *>)?.get("content") as? Map<*, *>)?.get("application/json") as? Map<*, *> ?: continue
                val schema = media["schema"] as? Map<*, *> ?: continue
                val examples = buildList {
                    if (media.containsKey("example")) add(media["example"])
                    (media["examples"] as? Map<*, *>)?.values?.forEach { add((it as? Map<*, *>)?.get("value")) }
                }
                if (examples.isEmpty()) continue
                val name = className(operationId, code.toString(), schema) ?: continue
                val type = runCatching { Class.forName("hub.core.client.model.$name") }.getOrNull() ?: continue
                for (example in examples) {
                    try {
                        Serializer.kotlinxSerializationJson.decodeFromString(serializer(type), toJson(example))
                        decoded++
                    } catch (e: Exception) {
                        failures += "${method.uppercase()} $path ($name): ${e.message?.lineSequence()?.first()}"
                    }
                }
            }
        }
        println("contract examples decoded: $decoded")
        assertTrue("no example could be decoded:\n" + failures.joinToString("\n"), failures.isEmpty())
        assertTrue("only $decoded examples decoded", decoded >= 50)
    }
}

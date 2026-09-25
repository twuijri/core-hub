package hub.core.android.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every user string exists in Arabic and English, with the same placeholders (AGENTS.md). */
class StringsParityTest {
    private val res = File(System.getProperty("user.dir"), "src/main/res")

    private fun strings(dir: String): Map<String, String> {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "$dir/strings.xml"))
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val n = nodes.item(i)
            n.attributes.getNamedItem("name").nodeValue to n.textContent
        }
    }

    private fun placeholders(text: String) = Regex("%\\d+\\$(\\.\\d+)?[sdf]").findAll(text).map { it.value }.sorted().toList()

    @Test fun `arabic and english have the same keys and placeholders`() {
        val en = strings("values")
        val ar = strings("values-ar")
        assertEquals(en.keys.sorted(), ar.keys.sorted())
        for ((key, value) in en) {
            assertEquals("placeholders of $key", placeholders(value), placeholders(ar.getValue(key)))
            assertTrue("$key is empty", value.isNotBlank() && ar.getValue(key).isNotBlank())
        }
    }

    @Test fun `the ui says profile, never workspace`() {
        val all = strings("values") + strings("values-ar").mapKeys { "ar:" + it.key }
        for ((key, value) in all) {
            assertTrue("$key says workspace", !value.contains("workspace", ignoreCase = true) && !value.contains("مساحة العمل"))
        }
    }
}

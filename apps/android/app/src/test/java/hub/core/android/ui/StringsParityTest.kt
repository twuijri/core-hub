package hub.core.android.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every user string exists in Arabic and English, with the same placeholders (AGENTS.md). */
class StringsParityTest {
    private val res = File(System.getProperty("user.dir"), "src/main/res")

    /** Every `strings*.xml` of a folder (a task may keep its strings in a file of its own). */
    private fun strings(dir: String): Map<String, String> =
        File(res, dir).listFiles { f -> f.name.startsWith("strings") && f.name.endsWith(".xml") }!!.sorted().flatMap { file ->
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val nodes = doc.getElementsByTagName("string")
            (0 until nodes.length).map { i ->
                val n = nodes.item(i)
                n.attributes.getNamedItem("name").nodeValue to n.textContent
            }
        }.toMap()

    @Test fun `the phone-parity strings are read too`() {
        assertTrue(strings("values").containsKey("workflows_run"))
        assertTrue(strings("values-ar").containsKey("workflows_run"))
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

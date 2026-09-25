package hub.core.android.markdown

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.unit.LayoutDirection
import hub.core.android.ui.components.ContentDirection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    private val colors = MdColors(Color.Black, Color.LightGray, Color.Blue)
    private fun parse(s: String) = Markdown.parse(s, colors)

    @Test fun `paragraphs, headings and inline styles`() {
        val blocks = parse("# العنوان\n\nنص **عريض** و`كود` و[رابط](https://example.com).")
        assertEquals(2, blocks.size)
        assertEquals(MdBlock.Heading(1, (blocks[0] as MdBlock.Heading).text), blocks[0])
        val p = (blocks[1] as MdBlock.Paragraph).text
        assertEquals("نص عريض وكود ورابط.", p.text)
        val link = p.getLinkAnnotations(0, p.length).single().item as LinkAnnotation.Url
        assertEquals("https://example.com", link.url)
        assertTrue(p.spanStyles.isNotEmpty())
    }

    @Test fun `a fenced code block keeps its language and its text exactly`() {
        val block = parse("```kotlin\nval x = 1\n  indented()\n```").single() as MdBlock.Code
        assertEquals("kotlin", block.language)
        assertEquals("val x = 1\n  indented()", block.code)
        assertNull((parse("    plain code").single() as MdBlock.Code).language)
    }

    @Test fun `lists keep their numbering and nesting`() {
        val list = parse("3. three\n4. four\n   - nested").single() as MdBlock.Items
        assertTrue(list.ordered)
        assertEquals(3, list.start)
        assertEquals(2, list.items.size)
        assertTrue(list.items[1].any { it is MdBlock.Items })
    }

    @Test fun `tables, quotes and rules`() {
        val blocks = parse("| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n---")
        val table = blocks[0] as MdBlock.Table
        assertEquals(listOf("a", "b"), table.header.map { it.text })
        assertEquals(listOf(listOf("1", "2")), table.rows.map { r -> r.map { it.text } })
        assertTrue(blocks[1] is MdBlock.Quote)
        assertEquals(MdBlock.Rule, blocks[2])
    }

    @Test fun `raw html is shown as text, never interpreted`() {
        val p = parse("<script>alert(1)</script>").single() as MdBlock.Paragraph
        assertEquals("<script>alert(1)</script>", p.text.text)
    }

    @Test fun `content decides its own direction from its first strong letter`() {
        assertEquals(LayoutDirection.Rtl, ContentDirection.of("  123 مرحبا hello"))
        assertEquals(LayoutDirection.Ltr, ContentDirection.of("hello مرحبا"))
        assertNull(ContentDirection.of("123 !?"))
    }
}

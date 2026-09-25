package hub.core.android.markdown

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/** The colours inline Markdown is drawn with; they come from the theme's tokens. */
data class MdColors(val code: Color, val codeBackground: Color, val link: Color)

/** A block of a rendered message. Every text block decides its own direction when drawn. */
sealed interface MdBlock {
    data class Paragraph(val text: AnnotatedString) : MdBlock
    data class Heading(val level: Int, val text: AnnotatedString) : MdBlock
    data class Code(val language: String?, val code: String) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class Items(val ordered: Boolean, val start: Int, val items: List<List<MdBlock>>) : MdBlock
    data class Table(val header: List<AnnotatedString>, val rows: List<List<AnnotatedString>>) : MdBlock
    data object Rule : MdBlock
}

/**
 * CommonMark with GitHub tables and strikethrough, turned into [MdBlock]s. Raw HTML is shown
 * as text, never interpreted: an agent's reply is not trusted markup. Links keep their URL
 * and open outside the app when tapped.
 */
object Markdown {
    private val extensions = listOf(TablesExtension.create(), StrikethroughExtension.create())
    private val parser: Parser = Parser.builder().extensions(extensions).build()

    fun parse(source: String, colors: MdColors): List<MdBlock> = blocks(parser.parse(source), colors)

    private fun children(node: Node): List<Node> = generateSequence(node.firstChild) { it.next }.toList()

    private fun blocks(parent: Node, colors: MdColors): List<MdBlock> = children(parent).mapNotNull { block(it, colors) }

    private fun block(node: Node, colors: MdColors): MdBlock? = when (node) {
        is Paragraph -> MdBlock.Paragraph(inline(node, colors))
        is Heading -> MdBlock.Heading(node.level, inline(node, colors))
        is FencedCodeBlock -> MdBlock.Code(node.info?.trim()?.substringBefore(' ')?.ifEmpty { null }, node.literal.trimEnd('\n'))
        is IndentedCodeBlock -> MdBlock.Code(null, node.literal.trimEnd('\n'))
        is BlockQuote -> MdBlock.Quote(blocks(node, colors))
        is BulletList -> MdBlock.Items(false, 1, children(node).filterIsInstance<ListItem>().map { blocks(it, colors) })
        is OrderedList -> MdBlock.Items(true, node.markerStartNumber ?: 1, children(node).filterIsInstance<ListItem>().map { blocks(it, colors) })
        is ThematicBreak -> MdBlock.Rule
        is HtmlBlock -> MdBlock.Paragraph(AnnotatedString(node.literal.trimEnd('\n')))
        is TableBlock -> table(node, colors)
        else -> null
    }

    private fun table(node: TableBlock, colors: MdColors): MdBlock.Table {
        var header = emptyList<AnnotatedString>()
        val rows = mutableListOf<List<AnnotatedString>>()
        fun cells(row: Node) = children(row).filterIsInstance<TableCell>().map { inline(it, colors) }
        for (section in children(node)) {
            val sectionRows = children(section).filterIsInstance<TableRow>()
            if (section is TableHead) header = sectionRows.firstOrNull()?.let(::cells).orEmpty()
            else rows += sectionRows.map(::cells)
        }
        return MdBlock.Table(header, rows)
    }

    private fun inline(node: Node, colors: MdColors): AnnotatedString = buildAnnotatedString {
        fun walk(n: Node) {
            when (n) {
                is Text -> append(n.literal)
                is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = colors.code, background = colors.codeBackground)) { append(n.literal) }
                is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children(n).forEach(::walk) }
                is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { children(n).forEach(::walk) }
                is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { children(n).forEach(::walk) }
                is Link -> withLink(
                    LinkAnnotation.Url(n.destination, TextLinkStyles(SpanStyle(color = colors.link, textDecoration = TextDecoration.Underline))),
                ) { children(n).forEach(::walk) }
                is Image -> {
                    // A picture in a reply is shown as its description, linked; the app does not fetch remote images.
                    withLink(LinkAnnotation.Url(n.destination, TextLinkStyles(SpanStyle(color = colors.link)))) {
                        append(children(n).joinToString("") { (it as? Text)?.literal.orEmpty() }.ifEmpty { n.destination })
                    }
                }
                is SoftLineBreak -> append('\n')
                is HardLineBreak -> append('\n')
                is HtmlInline -> append(n.literal)
                else -> children(n).forEach(::walk)
            }
        }
        children(node).forEach(::walk)
    }

    /** The plain text of a reply (what Copy puts on the clipboard is the Markdown itself). */
    fun plain(blocks: List<MdBlock>): String = blocks.joinToString("\n") { b ->
        when (b) {
            is MdBlock.Paragraph -> b.text.text
            is MdBlock.Heading -> b.text.text
            is MdBlock.Code -> b.code
            is MdBlock.Quote -> plain(b.blocks)
            is MdBlock.Items -> b.items.joinToString("\n") { plain(it) }
            is MdBlock.Table -> (listOf(b.header) + b.rows).joinToString("\n") { row -> row.joinToString(" | ") { it.text } }
            MdBlock.Rule -> "---"
        }
    }
}

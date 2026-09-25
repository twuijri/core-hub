package hub.core.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.markdown.MdBlock
import hub.core.android.markdown.MdColors
import hub.core.android.markdown.Markdown
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.Mono

/**
 * The direction a piece of content reads in, from its first strong character — what the web
 * gets from `dir="auto"`. Content decides its own direction; the UI language does not.
 */
object ContentDirection {
    fun of(text: CharSequence): LayoutDirection? {
        for (ch in text) {
            when (Character.getDirectionality(ch)) {
                Character.DIRECTIONALITY_RIGHT_TO_LEFT, Character.DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC -> return LayoutDirection.Rtl
                Character.DIRECTIONALITY_LEFT_TO_RIGHT -> return LayoutDirection.Ltr
            }
        }
        return null
    }
}

/** Lays [content] out in the direction of [text] (the UI's own when the text has no letters). */
@Composable
fun InContentDirection(text: CharSequence, content: @Composable () -> Unit) {
    val direction = ContentDirection.of(text) ?: LocalLayoutDirection.current
    CompositionLocalProvider(LocalLayoutDirection provides direction, content = content)
}

private val contentText = TextStyle(textDirection = TextDirection.Content)

/** A reply rendered from Markdown: paragraphs, lists, quotes, tables and code blocks. */
@Composable
fun MarkdownView(source: String, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    val colors = MdColors(code = t.codeText, codeBackground = t.codeBg, link = t.link)
    val blocks = remember(source, colors) { Markdown.parse(source, colors) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { MdBlockView(it) }
    }
}

@Composable
private fun MdBlockView(block: MdBlock) {
    val t = LocalTokens.current
    val body = MaterialTheme.typography.bodyLarge.merge(contentText)
    when (block) {
        is MdBlock.Paragraph -> InContentDirection(block.text) { Text(block.text, style = body, modifier = Modifier.fillMaxWidth()) }
        is MdBlock.Heading -> InContentDirection(block.text) {
            val style = when (block.level) {
                1 -> MaterialTheme.typography.titleLarge
                2 -> MaterialTheme.typography.titleMedium
                else -> MaterialTheme.typography.titleSmall
            }
            Text(block.text, style = style.merge(contentText), modifier = Modifier.fillMaxWidth())
        }
        is MdBlock.Code -> CodeBlock(block.language, block.code)
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(t.borderStrong))
            Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                block.blocks.forEach { MdBlockView(it) }
            }
        }
        is MdBlock.Items -> {
            val first = block.items.firstOrNull()?.let { Markdown.plain(it) }.orEmpty()
            InContentDirection(first) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEachIndexed { index, item ->
                        Row {
                            Text(
                                if (block.ordered) "${block.start + index}." else "•",
                                style = body, color = t.textMuted, modifier = Modifier.widthIn(min = 20.dp),
                            )
                            Column(Modifier.padding(start = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                item.forEach { MdBlockView(it) }
                            }
                        }
                    }
                }
            }
        }
        is MdBlock.Table -> Table(block.header, block.rows)
        MdBlock.Rule -> HorizontalDivider(color = t.border)
    }
}

/** A code block: solid, monospace, never wrapped (it scrolls sideways), with Copy. Always LTR. */
@Composable
fun CodeBlock(language: String?, code: String) {
    val t = LocalTokens.current
    val clipboard = LocalClipboardManager.current
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Column(
            Modifier.fillMaxWidth().background(t.codeBg, MaterialTheme.shapes.medium)
                .border(0.5.dp, t.border, MaterialTheme.shapes.medium),
        ) {
            Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text(language.orEmpty(), style = MaterialTheme.typography.labelSmall, color = t.textMuted, modifier = Modifier.weight(1f))
                IconButton(onClick = { clipboard.setText(AnnotatedString(code)) }) {
                    Icon(Glyphs.Copy, contentDescription = stringResource(R.string.chat_copy_code), modifier = Modifier.size(16.dp), tint = t.textMuted)
                }
            }
            Text(
                code,
                fontFamily = Mono,
                color = t.codeText,
                style = MaterialTheme.typography.bodyMedium.copy(textDirection = TextDirection.Ltr),
                softWrap = false,
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
            )
        }
    }
}

@Composable
private fun Table(header: List<AnnotatedString>, rows: List<List<AnnotatedString>>) {
    val t = LocalTokens.current
    val columns = maxOf(header.size, rows.maxOfOrNull { it.size } ?: 0)
    InContentDirection(header.firstOrNull() ?: rows.firstOrNull()?.firstOrNull() ?: AnnotatedString("")) {
        Column(Modifier.horizontalScroll(rememberScrollState()).border(0.5.dp, t.border, MaterialTheme.shapes.small)) {
            (listOf(header) + rows).forEachIndexed { r, row ->
                Row(if (r == 0) Modifier.background(t.surface2) else Modifier) {
                    for (c in 0 until columns) {
                        Text(
                            row.getOrNull(c) ?: AnnotatedString(""),
                            style = MaterialTheme.typography.bodyMedium.merge(contentText),
                            fontWeight = if (r == 0) FontWeight.SemiBold else null,
                            modifier = Modifier.width(140.dp).padding(8.dp),
                        )
                    }
                }
                if (r < rows.size) HorizontalDivider(color = t.border)
            }
        }
    }
}

package us.i3u.hermesstudio

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection

/**
 * Content direction, the Android half of `docs/CONTENT-DIRECTION.md`.
 *
 * The interface language is not the conversation language. The owner writes
 * Arabic into an English app and picks English options in an Arabic one, so
 * every piece of human text decides its own direction from its own first
 * strong character — the Unicode rule the web client gets from `dir="auto"`
 * and `unicode-bidi: plaintext`, not a guess about which language "dominates".
 *
 * Two questions, and they have different answers:
 *
 *  - **Which way does this paragraph read?** Per paragraph, first strong
 *    character, falling back to the surrounding direction. Android's
 *    `StaticLayout` already does exactly this for every `\n`-separated
 *    paragraph when the text style asks for [TextDirection.Content], which is
 *    why displayed text needs nothing more than that.
 *  - **Which edge does the box start at?** That is the element's own
 *    direction — `dir="auto"` on the web — and Compose takes it from
 *    [LocalLayoutDirection], which follows the *interface* language and knows
 *    nothing about what was typed. Alignment, the caret at rest, the
 *    placeholder and the selection handles all hang off it, so a text field
 *    holding Arabic inside an English app has to be given a direction of its
 *    own. That is [ContentDirections.ofText].
 *
 * Nothing here rewrites the text, reverses it, or injects bidi controls.
 */
enum class ContentDirection {
    Ltr,
    Rtl,

    /** Digits, punctuation, emoji, an empty string: no evidence either way. */
    Neutral,
}

object ContentDirections {

    /** U+2066 LRI, U+2067 RLI, U+2068 FSI: everything up to the matching PDI is skipped. */
    private const val ISOLATE_FIRST = '⁦'
    private const val ISOLATE_LAST = '⁨'
    private const val POP_ISOLATE = '⁩'

    /** U+202A LRE … U+202E RLO, closed by U+202C PDF. */
    private const val EMBED_FIRST = '‪'
    private const val EMBED_LAST = '‮'
    private const val POP_EMBED = '‬'

    /**
     * The paragraphs of [text], split the way the bidi algorithm splits them:
     * on the newline, which is a paragraph separator. Empty paragraphs are
     * kept so an index into this list still means something.
     */
    fun paragraphs(text: String): List<String> = text.split('\n')

    /**
     * Rules P2 and P3 of the Unicode Bidirectional Algorithm over one
     * paragraph: the first strong character decides, and characters inside an
     * isolate or an embedding are skipped, because that is the entire point of
     * wrapping a foreign name in U+2068…U+2069 before dropping it into a
     * sentence. A number is not evidence; neither is punctuation.
     *
     * Walks whole code points, not `char`s: an emoji is a surrogate pair, and
     * an unpaired surrogate is classed left-to-right, so scanning `char` by
     * `char` reads a smiley as evidence of an English sentence.
     */
    fun firstStrong(paragraph: String): ContentDirection {
        var index = 0
        while (index < paragraph.length) {
            val char = paragraph[index]
            if (char in ISOLATE_FIRST..ISOLATE_LAST) {
                index = skipTo(paragraph, index + 1, POP_ISOLATE, ISOLATE_FIRST..ISOLATE_LAST)
                continue
            }
            if (char in EMBED_FIRST..EMBED_LAST) {
                index = skipTo(paragraph, index + 1, POP_EMBED, EMBED_FIRST..EMBED_LAST)
                continue
            }
            val codePoint = paragraph.codePointAt(index)
            when (Character.getDirectionality(codePoint)) {
                Character.DIRECTIONALITY_LEFT_TO_RIGHT -> return ContentDirection.Ltr
                Character.DIRECTIONALITY_RIGHT_TO_LEFT,
                Character.DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC,
                -> return ContentDirection.Rtl
            }
            index += Character.charCount(codePoint)
        }
        return ContentDirection.Neutral
    }

    /**
     * Past the matching terminator, counting nested initiators of the same
     * kind. The terminator is tested first because U+202C PDF sits inside the
     * U+202A…U+202E range it closes.
     */
    private fun skipTo(text: String, from: Int, terminator: Char, initiators: CharRange): Int {
        var depth = 1
        var index = from
        while (index < text.length && depth > 0) {
            val char = text[index]
            if (char == terminator) depth-- else if (char in initiators) depth++
            index++
        }
        return index
    }

    /**
     * The direction of the whole value — what `dir="auto"` gives an element:
     * the first paragraph that has any evidence decides for the box, and a
     * value with no strong character anywhere decides nothing.
     */
    fun ofText(text: String): ContentDirection {
        paragraphs(text).forEach { paragraph ->
            val direction = firstStrong(paragraph)
            if (direction != ContentDirection.Neutral) return direction
        }
        return ContentDirection.Neutral
    }
}

/** The layout direction for a box holding this content; [fallback] is the interface's. */
fun ContentDirection.layoutDirection(fallback: LayoutDirection): LayoutDirection = when (this) {
    ContentDirection.Ltr -> LayoutDirection.Ltr
    ContentDirection.Rtl -> LayoutDirection.Rtl
    ContentDirection.Neutral -> fallback
}

/**
 * The paragraph direction for a `TextStyle`. [TextDirection.Content] is not a
 * cop-out here: it is the platform's own per-paragraph first-strong pass, and
 * once the box direction above is right it resolves neutral paragraphs the way
 * `unicode-bidi: plaintext` does.
 */
fun ContentDirection.textDirection(): TextDirection = when (this) {
    ContentDirection.Ltr -> TextDirection.Ltr
    ContentDirection.Rtl -> TextDirection.Rtl
    ContentDirection.Neutral -> TextDirection.Content
}

/** The layout direction a box holding [text] should use, given the interface's. */
@Composable
fun contentLayoutDirection(text: String): LayoutDirection =
    ContentDirections.ofText(text).layoutDirection(LocalLayoutDirection.current)

/**
 * Lays [content] out in the direction of [text] rather than the interface's.
 *
 * Wrap the smallest thing that holds one piece of human text — a text field,
 * not a row and never a screen. A row wrapped in this would move buttons
 * around, which is an interface decision and not a content one.
 */
@Composable
fun ContentDirectionBox(text: String, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalLayoutDirection provides contentLayoutDirection(text), content = content)
}

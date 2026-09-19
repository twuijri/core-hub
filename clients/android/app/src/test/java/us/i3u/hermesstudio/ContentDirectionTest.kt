package us.i3u.hermesstudio

import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The reported bug: Arabic typed into the composer of an English app started
 * somewhere in the middle of the line instead of at the right edge.
 *
 * Two separate rules had to hold, and neither did:
 *
 *  - the direction of a piece of content comes from the content, per
 *    paragraph, first strong character — `docs/CONTENT-DIRECTION.md`, which
 *    the web gets from `dir="auto"` and `unicode-bidi: plaintext`;
 *  - the *box* holding it has to start at the edge that direction implies,
 *    which on Compose means both the layout direction and the full width.
 *
 * The first is checked here against the three cases the brief names. The
 * second is a layout constraint, so it is checked where it is written.
 */
class ContentDirectionTest {

    // ── the three cases from the brief ───────────────────────────────────

    @Test
    fun `a mixed Arabic and Latin string takes the direction of what comes first`() {
        // Arabic first: the Latin inside it does not turn the line around.
        assertEquals(ContentDirection.Rtl, ContentDirections.ofText("مرحبا Core Hub كيف الحال"))
        // Latin first: and the Arabic inside it does not either. This is the
        // Unicode rule, not a vote about which language there is more of.
        assertEquals(ContentDirection.Ltr, ContentDirections.ofText("Core Hub مرحبا بك"))
    }

    @Test
    fun `a Latin-only string stays left-to-right, whatever language the app is in`() {
        // Nothing here consults the interface: an Arabic UI is a fallback for
        // content that has no direction of its own, never an override.
        assertEquals(ContentDirection.Ltr, ContentDirections.ofText("Deploy the test stack"))
        assertEquals(
            LayoutDirection.Ltr,
            ContentDirections.ofText("Deploy the test stack").layoutDirection(LayoutDirection.Rtl),
        )
        assertEquals(TextDirection.Ltr, ContentDirections.ofText("Deploy the test stack").textDirection())
    }

    @Test
    fun `an Arabic-only string is right-to-left inside an English interface`() {
        assertEquals(ContentDirection.Rtl, ContentDirections.ofText("السلام عليكم ورحمة الله"))
        // The composer bug in one line: the box must flip, not just the glyphs.
        assertEquals(
            LayoutDirection.Rtl,
            ContentDirections.ofText("السلام عليكم").layoutDirection(LayoutDirection.Ltr),
        )
        assertEquals(TextDirection.Rtl, ContentDirections.ofText("السلام عليكم").textDirection())
    }

    // ── per paragraph, the way plaintext does it ─────────────────────────

    @Test
    fun `each paragraph answers for itself`() {
        val draft = "Deploy the test stack\nثم أخبرني بالنتيجة\n123"
        val paragraphs = ContentDirections.paragraphs(draft)
        assertEquals(3, paragraphs.size)
        assertEquals(ContentDirection.Ltr, ContentDirections.firstStrong(paragraphs[0]))
        assertEquals(ContentDirection.Rtl, ContentDirections.firstStrong(paragraphs[1]))
        // Digits are not evidence, so this paragraph decides nothing and
        // inherits whatever is around it.
        assertEquals(ContentDirection.Neutral, ContentDirections.firstStrong(paragraphs[2]))
    }

    @Test
    fun `the box takes the first paragraph that has any evidence at all`() {
        // Leading blank lines, digits and punctuation say nothing; the first
        // real sentence decides where the field starts.
        assertEquals(ContentDirection.Rtl, ContentDirections.ofText("\n\n123 — \nمرحبا"))
        assertEquals(ContentDirection.Ltr, ContentDirections.ofText("\n\n123 — \nhello"))
    }

    // ── what is and is not evidence ──────────────────────────────────────

    @Test
    fun `nothing strong means nothing is decided, and the interface answers`() {
        listOf("", "   ", "1234", "…!?", "٤٢", "🙂").forEach { text ->
            assertEquals(text, ContentDirection.Neutral, ContentDirections.ofText(text))
        }
        // Arabic-Indic digits are digits: they carry a number's direction, not
        // a language's, which is why the fallback has to be consulted.
        assertEquals(LayoutDirection.Rtl, ContentDirections.ofText("٤٢").layoutDirection(LayoutDirection.Rtl))
        assertEquals(LayoutDirection.Ltr, ContentDirections.ofText("٤٢").layoutDirection(LayoutDirection.Ltr))
    }

    @Test
    fun `an isolated run does not decide the direction, which is why it was isolated`() {
        // SpeechLanguages.isolate wraps a language name in U+2068…U+2069 so it
        // can sit in a sentence of the other script. If that run decided the
        // sentence's direction, the isolation would have achieved nothing.
        val sentence = "${SpeechLanguages.isolate("English")} هي لغة التطبيق"
        assertEquals(ContentDirection.Rtl, ContentDirections.ofText(sentence))

        val english = "${SpeechLanguages.isolate("العربية")} is the app language"
        assertEquals(ContentDirection.Ltr, ContentDirections.ofText(english))

        // An isolate that is never closed swallows the rest, which is the
        // Unicode behaviour and not something to paper over.
        assertEquals(ContentDirection.Neutral, ContentDirections.ofText("⁨مرحبا"))
    }

    @Test
    fun `an embedding is skipped too, and its terminator does not read as a nested one`() {
        // U+202C PDF sits inside the U+202A…U+202E range it closes, so a naive
        // scan never finds its way out of the first embedding.
        val sentence = "‫English‬ hello"
        assertEquals(ContentDirection.Ltr, ContentDirections.ofText(sentence))
    }

    @Test
    fun `the chat markdown blocks use the very same rule`() {
        assertEquals(TextDirection.Rtl, chatTextDirection("مرحبا Core Hub"))
        assertEquals(TextDirection.Ltr, chatTextDirection("Core Hub مرحبا"))
        assertEquals(TextDirection.Content, chatTextDirection("42"))
    }

    // ── the composer, where the misplacement actually happened ───────────

    private val composer =
        File("src/main/java/us/i3u/hermesstudio/ui/chat/Composer.kt").readText()

    @Test
    fun `the composer field runs in the direction of its own content`() {
        // Without this the field inherits the interface language and an
        // Arabic draft in an English app is anchored to the wrong edge.
        assertEquals(
            "wrap the composer's BasicTextField in ContentDirectionBox(field.text)",
            true,
            composer.contains("ContentDirectionBox(field.text)"),
        )
    }

    @Test
    fun `the composer field is measured at the full width of the card`() {
        // A Box drops the incoming minimum width, so the text field inside the
        // decoration box was only as wide as its own glyphs and pinned to the
        // layout's start. A right-aligned Arabic paragraph then began at the
        // end of that narrow run — the middle of the composer.
        assertEquals(
            "the decorationBox must propagate its minimum width to the inner text field",
            true,
            composer.contains("propagateMinConstraints = true"),
        )
    }
}

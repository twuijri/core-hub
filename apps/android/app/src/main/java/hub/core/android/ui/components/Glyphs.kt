package hub.core.android.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * The few glyphs the core icon set lacks, drawn here as simple strokes on a 24-unit grid
 * (our own drawings, not copied from an icon font). Tinted by the `Icon` that shows them.
 */
object Glyphs {
    private fun glyph(name: String, fill: Boolean = false, block: PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            path(
                fill = if (fill) SolidColor(Color.Black) else null,
                stroke = if (fill) null else SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathBuilder = block,
            )
        }.build()

    val Stop: ImageVector = glyph("stop", fill = true) {
        moveTo(8f, 6f); lineTo(16f, 6f); arcTo(2f, 2f, 0f, false, true, 18f, 8f); lineTo(18f, 16f)
        arcTo(2f, 2f, 0f, false, true, 16f, 18f); lineTo(8f, 18f); arcTo(2f, 2f, 0f, false, true, 6f, 16f)
        lineTo(6f, 8f); arcTo(2f, 2f, 0f, false, true, 8f, 6f); close()
    }

    val Copy: ImageVector = glyph("copy") {
        moveTo(9f, 9f); lineTo(19f, 9f); lineTo(19f, 19f); lineTo(9f, 19f); close()
        moveTo(5f, 15f); lineTo(5f, 5f); lineTo(15f, 5f)
    }

    val Qr: ImageVector = glyph("qr") {
        moveTo(4f, 4f); lineTo(10f, 4f); lineTo(10f, 10f); lineTo(4f, 10f); close()
        moveTo(14f, 4f); lineTo(20f, 4f); lineTo(20f, 10f); lineTo(14f, 10f); close()
        moveTo(4f, 14f); lineTo(10f, 14f); lineTo(10f, 20f); lineTo(4f, 20f); close()
        moveTo(14f, 14f); lineTo(14f, 16f); moveTo(18f, 14f); lineTo(20f, 14f)
        moveTo(14f, 20f); lineTo(16f, 20f); moveTo(18f, 18f); lineTo(20f, 20f)
    }

    val Mic: ImageVector = glyph("mic") {
        moveTo(12f, 3f); arcTo(3f, 3f, 0f, false, true, 15f, 6f); lineTo(15f, 11f)
        arcTo(3f, 3f, 0f, false, true, 9f, 11f); lineTo(9f, 6f); arcTo(3f, 3f, 0f, false, true, 12f, 3f); close()
        moveTo(5f, 11f); arcTo(7f, 7f, 0f, false, false, 19f, 11f)
        moveTo(12f, 18f); lineTo(12f, 21f)
    }

    val Sun: ImageVector = glyph("sun") {
        moveTo(12f, 8f); arcTo(4f, 4f, 0f, true, true, 11.99f, 8f); close()
        moveTo(12f, 2f); lineTo(12f, 4f); moveTo(12f, 20f); lineTo(12f, 22f)
        moveTo(2f, 12f); lineTo(4f, 12f); moveTo(20f, 12f); lineTo(22f, 12f)
        moveTo(4.9f, 4.9f); lineTo(6.3f, 6.3f); moveTo(17.7f, 17.7f); lineTo(19.1f, 19.1f)
        moveTo(4.9f, 19.1f); lineTo(6.3f, 17.7f); moveTo(17.7f, 6.3f); lineTo(19.1f, 4.9f)
    }

    val Moon: ImageVector = glyph("moon") {
        moveTo(20f, 14f); arcTo(8f, 8f, 0f, true, true, 10f, 4f); arcTo(6f, 6f, 0f, false, false, 20f, 14f); close()
    }

    val Screen: ImageVector = glyph("screen") {
        moveTo(3f, 5f); lineTo(21f, 5f); lineTo(21f, 16f); lineTo(3f, 16f); close()
        moveTo(8f, 20f); lineTo(16f, 20f); moveTo(12f, 16f); lineTo(12f, 20f)
    }

    val Tool: ImageVector = glyph("tool") {
        moveTo(4f, 17f); lineTo(10f, 11f); moveTo(14f, 4f); arcTo(4f, 4f, 0f, true, false, 20f, 10f)
        lineTo(17f, 10f); lineTo(14f, 7f); close()
    }

    val Help: ImageVector = glyph("help") {
        moveTo(12f, 3f); arcTo(9f, 9f, 0f, true, true, 11.99f, 3f); close()
        moveTo(9.5f, 9.5f); arcTo(2.5f, 2.5f, 0f, true, true, 12f, 12f); lineTo(12f, 14f)
        moveTo(12f, 17f); lineTo(12f, 17.01f)
    }
}

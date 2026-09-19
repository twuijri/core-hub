package us.i3u.hermesstudio.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The web client's line icons (24 viewBox, stroke 1.8, round caps and joins),
 * path data copied from DESIGN-SPEC.md. Built once; the tint comes from the
 * `Icon` call. Icons that imply a reading direction auto-mirror in RTL.
 */
object CoreHubIcons {

    private const val STROKE = 1.8f

    private fun circle(cx: Float, cy: Float, r: Float): String =
        "M${cx - r} $cy a$r $r 0 1 0 ${2 * r} 0 a$r $r 0 1 0 ${-2 * r} 0"

    /** Builds a stroked icon from one or more SVG path strings. */
    private fun line(name: String, vararg paths: String, mirror: Boolean = false): ImageVector =
        ImageVector.Builder(
            name = "CoreHub.$name",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
            autoMirror = mirror,
        ).apply {
            paths.forEach { data ->
                addPath(
                    pathData = addPathNodes(data),
                    fill = null,
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = STROKE,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val NewChat: ImageVector by lazy { line("NewChat", "M12 5v14 M5 12h14") }
    val Search: ImageVector by lazy { line("Search", circle(11f, 11f, 7f), "M20 20l-3.5-3.5") }
    val DeviceConnections: ImageVector by lazy {
        line(
            "DeviceConnections",
            circle(18f, 5f, 2.5f), circle(6f, 12f, 2.5f), circle(18f, 19f, 2.5f),
            "M8.2 10.7l7.6-4.4 M8.2 13.3l7.6 4.4",
        )
    }
    val AgentManager: ImageVector by lazy {
        line(
            "AgentManager",
            "M12 8V4H8",
            "M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z",
            "M2 14h2 M20 14h2 M9 13v2 M15 13v2",
        )
    }
    val Models: ImageVector by lazy {
        line(
            "Models",
            circle(12f, 12f, 3f),
            "M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9L7 7 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1",
        )
    }
    val Chat: ImageVector by lazy {
        line("Chat", "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", mirror = true)
    }
    val Group: ImageVector by lazy {
        line(
            "Group",
            "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
            circle(9f, 7f, 4f),
            "M22 21v-2a4 4 0 0 0-3-3.87",
            "M16 3.13a4 4 0 0 1 0 7.75",
            mirror = true,
        )
    }
    val Workflow: ImageVector by lazy {
        line(
            "Workflow",
            circle(5f, 12f, 3f), circle(19f, 6f, 3f), circle(19f, 18f, 3f),
            "M8 12h3a4 4 0 0 0 4-4V6",
            "M8 12h3a4 4 0 0 1 4 4v2",
            mirror = true,
        )
    }
    val History: ImageVector by lazy { line("History", circle(12f, 12f, 9f), "M12 7v5l3 2") }
    val Settings: ImageVector by lazy {
        line(
            "Settings",
            circle(12f, 12f, 3f),
            "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
        )
    }
    val Menu: ImageVector by lazy { line("Menu", "M4 6h16 M4 12h16 M4 18h16") }
    val More: ImageVector by lazy {
        line("More", circle(12f, 5f, 1f), circle(12f, 12f, 1f), circle(12f, 19f, 1f))
    }
    val Pin: ImageVector by lazy { line("Pin", "M12 17v5 M9 3h6l-1 6 3 3H7l3-3z") }
    val Folder: ImageVector by lazy {
        line("Folder", "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")
    }
    val Close: ImageVector by lazy { line("Close", "M18 6L6 18 M6 6l12 12") }

    /** Attachment sheet: take a photo, pick one from the library, pick any file. */
    val Camera: ImageVector by lazy {
        line(
            "Camera",
            "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
            circle(12f, 13f, 3f),
        )
    }
    val Image: ImageVector by lazy {
        line(
            "Image",
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
            circle(9f, 9f, 2f),
            "M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21",
        )
    }
    val Paperclip: ImageVector by lazy {
        line(
            "Paperclip",
            "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
        )
    }
    val ChevronRight: ImageVector by lazy { line("ChevronRight", "M9 6l6 6-6 6", mirror = true) }
    val Back: ImageVector by lazy { line("Back", "M19 12H5 M12 19l-7-7 7-7", mirror = true) }
    val Logout: ImageVector by lazy {
        line("Logout", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5 M21 12H9", mirror = true)
    }
    val Language: ImageVector by lazy {
        line(
            "Language",
            circle(12f, 12f, 10f),
            "M2 12h20",
            "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
        )
    }
}

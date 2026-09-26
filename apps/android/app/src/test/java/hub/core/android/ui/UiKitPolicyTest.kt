package hub.core.android.ui

import hub.core.android.repoRoot
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The phone's side of DESIGN.md's UI policy: every control a screen draws comes from `ui/kit`,
 * painted by the tokens, and every icon is Lucide. A screen that imports a Material control or
 * the Material icon set fails here, so the stock look cannot creep back one screen at a time.
 */
class UiKitPolicyTest {
    private val source = File(repoRoot, "apps/android/app/src/main/java")

    /** Material controls whose look is Material's own; `ui/kit` wraps the few it builds on. */
    private val banned = listOf(
        "Button", "OutlinedButton", "TextButton", "FilledIconButton", "IconButton", "FilterChip", "AssistChip",
        "OutlinedTextField", "TextField", "Switch", "Checkbox", "RadioButton", "AlertDialog", "DropdownMenu",
        "DropdownMenuItem", "ModalBottomSheet", "Card", "ElevatedCard", "SegmentedButton", "NavigationDrawerItem",
        "CircularProgressIndicator", "LinearProgressIndicator", "TopAppBar", "Scaffold", "Badge", "BadgedBox",
        "PrimaryScrollableTabRow", "Tab", "Snackbar",
    )

    @Test fun `screens draw controls from the kit and icons from Lucide`() {
        val offences = source.walkTopDown().filter { it.extension == "kt" && !it.path.contains("/ui/kit/") }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                val text = line.trim()
                val bad = text.contains("androidx.compose.material.icons") ||
                    banned.any { name -> text == "import androidx.compose.material3.$name" || text.contains("androidx.compose.material3.$name(") }
                if (bad) "${file.relativeTo(source)}:${i + 1}: $text" else null
            }
        }.toList()
        assertTrue("use ui/kit and Lucide instead:\n" + offences.joinToString("\n"), offences.isEmpty())
    }
}

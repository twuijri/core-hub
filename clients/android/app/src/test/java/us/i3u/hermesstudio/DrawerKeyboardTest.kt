package us.i3u.hermesstudio

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Opening the drawer with the composer focused left the soft keyboard on
 * screen, covering the drawer's lower half — the profile row, Sign Out and
 * the settings item. The keyboard has to go on the open transition itself
 * (not after a delay), the composer has to lose focus so Android does not
 * bring it straight back, and the drawer body has to survive a keyboard that
 * is up anyway.
 *
 * Compose behaviour cannot be asserted from a JVM unit test, so this pins the
 * wiring the same way NavigationStructureTest pins the information
 * architecture.
 */
class DrawerKeyboardTest {

    private val drawer = File("src/main/java/us/i3u/hermesstudio/ui/navigation/CoreHubDrawer.kt").readText()

    @Test
    fun theDrawerDismissesTheKeyboardOnTheOpenTransition() {
        assertTrue(
            "the drawer host must hold the keyboard controller",
            drawer.contains("val keyboard = LocalSoftwareKeyboardController.current"),
        )
        assertTrue(
            "the drawer host must hold the focus manager",
            drawer.contains("val focusManager = LocalFocusManager.current"),
        )
        assertTrue(
            "the keyboard must be dismissed by the open transition, not a timer",
            Regex("""LaunchedEffect\(open\)\s*\{\s*if \(open\)\s*\{\s*keyboard\?\.hide\(\)\s*focusManager\.clearFocus\(force = true\)""")
                .containsMatchIn(drawer),
        )
    }

    @Test
    fun noTimerStandsInForTheTransition() {
        // BackHandler is Compose's back-gesture API, not a message queue.
        listOf("delay(", "postDelayed", "Timer(", """(?<!Back)Handler\(""").forEach { smell ->
            assertTrue(
                "the drawer must not wait on $smell to hide the keyboard",
                !Regex(smell.takeIf { it.startsWith("(?<") } ?: Regex.escape(smell)).containsMatchIn(drawer),
            )
        }
    }

    @Test
    fun theDrawerBodyRespectsTheImeInset() {
        assertTrue(
            "the drawer footer must clear a keyboard that is still up",
            drawer.contains("WindowInsets.navigationBars.union(WindowInsets.ime)"),
        )
        assertTrue(
            "the inset must be applied to the drawer column",
            drawer.contains(".windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))"),
        )
    }
}

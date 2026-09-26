package hub.core.android.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LocalContentColor
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import hub.core.android.generated.DarkTokens
import hub.core.android.generated.LightTokens
import androidx.compose.material3.Text
import androidx.compose.ui.unit.sp
import hub.core.android.ui.theme.CoreHubTheme
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.ThemeChoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Text drawn without a colour of its own is legible in both themes (owner, 2026-09-27: the top
 * bar's «New chat» and the new chat's headline were near-black on the dark background). The
 * theme hands every screen the token text colour, and a top bar title really paints light pixels
 * on the dark background.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w400dp-h200dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThemeContrastTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun `the content colour is the token text colour in both themes`() {
        var dark = Color.Unspecified
        var light = Color.Unspecified
        compose.setContent {
            CoreHubTheme(ThemeChoice.DARK) { dark = LocalContentColor.current }
            CoreHubTheme(ThemeChoice.LIGHT) { light = LocalContentColor.current }
        }
        compose.waitForIdle()
        assertEquals(DarkTokens.text, dark)
        assertEquals(LightTokens.text, light)
    }

    @Test fun `text with no colour of its own is light on the dark background`() {
        compose.setContent {
            CoreHubTheme(ThemeChoice.DARK) {
                Box(Modifier.fillMaxSize().background(LocalTokens.current.bg)) { Text("What shall we work on?", fontSize = 28.sp) }
            }
        }
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        // The brightest pixel: the text's own colour (the background is near-black).
        var brightest = 0f
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            brightest = maxOf(brightest, Color(bitmap.getPixel(x, y)).luminance())
        }
        assertTrue("the text's brightest pixel has luminance $brightest", brightest > 0.6f)
    }
}

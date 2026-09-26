package hub.core.android.ui.theme

import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import hub.core.android.generated.DarkTokens
import hub.core.android.generated.FontTokens
import hub.core.android.generated.Glass
import hub.core.android.generated.LightTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.generated.TokenColors

/** The three choices of the footer's theme chip (a local preference, NAVIGATION.md §1). */
enum class ThemeChoice { LIGHT, DARK, SYSTEM }

/** The token colours of the theme in use; every screen paints from these, never a literal. */
val LocalTokens = staticCompositionLocalOf { LightTokens }

/** The glass level floating chrome uses here: 0 when the person asked for less transparency. */
val LocalGlassLevel = staticCompositionLocalOf { Glass.DEFAULT }

/** True while the dark tokens are in use (status-bar icons, images that need a dark variant). */
val LocalDarkTheme = staticCompositionLocalOf { false }

/** True when the person turned animations off; the thinking dots stop, the count does not. */
val LocalReducedMotion = staticCompositionLocalOf { false }

private fun reducedMotion(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

/**
 * Android has no "reduce transparency" switch; high-contrast text is the closest thing a
 * person turns on for legibility, so it drops the glass to solid, as the web does for
 * `prefers-reduced-transparency`.
 */
private fun reducedTransparency(context: Context): Boolean =
    Settings.Secure.getInt(context.contentResolver, "high_text_contrast_enabled", 0) == 1

@Composable
fun CoreHubTheme(choice: ThemeChoice, content: @Composable () -> Unit) {
    val dark = when (choice) {
        ThemeChoice.SYSTEM -> isSystemInDarkTheme()
        ThemeChoice.DARK -> true
        ThemeChoice.LIGHT -> false
    }
    val t = if (dark) DarkTokens else LightTokens
    val scheme = if (dark) {
        darkColorScheme(
            primary = t.accent, onPrimary = t.accentText, primaryContainer = t.accentSoft,
            onPrimaryContainer = t.accentSoftText, secondary = t.accentStrong, onSecondary = t.accentText,
            secondaryContainer = t.accentSoft, onSecondaryContainer = t.accentSoftText,
            background = t.bg, onBackground = t.text, surface = t.surface, onSurface = t.text,
            surfaceVariant = t.surface2, onSurfaceVariant = t.textMuted, surfaceContainerLowest = t.bg,
            surfaceContainerLow = t.bgRaised, surfaceContainer = t.surface, surfaceContainerHigh = t.surface2,
            surfaceContainerHighest = t.surface3, outline = t.borderStrong, outlineVariant = t.border,
            error = t.danger, onError = t.dangerText, errorContainer = t.dangerSoft,
            onErrorContainer = t.dangerSoftText, scrim = t.scrim,
        )
    } else {
        lightColorScheme(
            primary = t.accent, onPrimary = t.accentText, primaryContainer = t.accentSoft,
            onPrimaryContainer = t.accentSoftText, secondary = t.accentStrong, onSecondary = t.accentText,
            secondaryContainer = t.accentSoft, onSecondaryContainer = t.accentSoftText,
            background = t.bg, onBackground = t.text, surface = t.surface, onSurface = t.text,
            surfaceVariant = t.surface2, onSurfaceVariant = t.textMuted, surfaceContainerLowest = t.surface,
            surfaceContainerLow = t.bgRaised, surfaceContainer = t.surface, surfaceContainerHigh = t.surface2,
            surfaceContainerHighest = t.surface3, outline = t.borderStrong, outlineVariant = t.border,
            error = t.danger, onError = t.dangerText, errorContainer = t.dangerSoft,
            onErrorContainer = t.dangerSoftText, scrim = t.scrim,
        )
    }
    val base = TextStyle(textDirection = TextDirection.Content, lineHeight = FontTokens.leadingNormal.em)
    val typography = Typography(
        headlineSmall = base.copy(fontSize = FontTokens.size2xl.sp, fontWeight = FontWeight.SemiBold, lineHeight = FontTokens.leadingTight.em),
        titleLarge = base.copy(fontSize = FontTokens.sizeXl.sp, fontWeight = FontWeight.SemiBold, lineHeight = FontTokens.leadingTight.em),
        titleMedium = base.copy(fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold, lineHeight = FontTokens.leadingTight.em),
        titleSmall = base.copy(fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = base.copy(fontSize = FontTokens.sizeMd.sp),
        bodyMedium = base.copy(fontSize = FontTokens.sizeSm.sp),
        bodySmall = base.copy(fontSize = FontTokens.sizeXs.sp),
        labelLarge = base.copy(fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium),
        labelMedium = base.copy(fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.Medium),
        labelSmall = base.copy(fontSize = FontTokens.sizeXs.sp),
    )
    val shapes = Shapes(
        extraSmall = RoundedCornerShape(RadiusTokens.sm.dp),
        small = RoundedCornerShape(RadiusTokens.sm.dp),
        medium = RoundedCornerShape(RadiusTokens.md.dp),
        large = RoundedCornerShape(RadiusTokens.lg.dp),
        extraLarge = RoundedCornerShape(RadiusTokens.xl.dp),
    )
    val context = LocalContext.current
    val motion = remember { reducedMotion(context) }
    val glass = remember { if (reducedTransparency(context)) 0 else Glass.DEFAULT }
    CompositionLocalProvider(
        LocalTokens provides t,
        LocalDarkTheme provides dark,
        LocalReducedMotion provides motion,
        LocalGlassLevel provides glass,
    ) {
        MaterialTheme(colorScheme = scheme, typography = typography, shapes = shapes) {
            // Text drawn outside a Surface takes LocalContentColor, which Compose leaves black:
            // on the dark tokens every such title vanished (owner, 2026-09-27). The theme gives
            // every screen the token text colour, and the selection handles the accent.
            CompositionLocalProvider(
                LocalContentColor provides t.text,
                LocalTextSelectionColors provides TextSelectionColors(handleColor = t.accent, backgroundColor = t.accent.copy(alpha = 0.3f)),
                content = content,
            )
        }
    }
}

/** Monospace for code, commands and tool output. */
val Mono = FontFamily.Monospace

/**
 * Glass for floating chrome only (top bar, composer, drawer, sheets): the tint at the level's
 * alpha with a hairline border. Content surfaces — bubbles, cards — stay solid (DESIGN.md).
 * Android cannot blur what scrolls behind a view before API 31 and not cheaply after, so the
 * phone keeps the translucency and the border and leaves the blur out, which DESIGN's
 * reasons (battery, legibility of Arabic) favour on a phone anyway.
 */
fun Modifier.glass(tokens: TokenColors, level: Int, shape: Shape): Modifier {
    val l = Glass.levels[level.coerceIn(0, Glass.levels.lastIndex)]
    return this
        .background(tokens.glassTint.copy(alpha = l.alpha), shape)
        .border(0.5.dp, tokens.border.copy(alpha = l.borderAlpha), shape)
}

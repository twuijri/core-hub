package us.i3u.hermesstudio.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The single source of design values for Core Hub Mobile.
 *
 * Every number here is copied from docs/mobile/DESIGN-SPEC.md, which in turn is
 * extracted from the web client (`packages/client/src/styles/variables.scss`).
 * Screens must read these tokens (directly or through Material roles mapped in
 * [CoreHubTheme]) instead of carrying their own colours, radii or sizes.
 */
object CoreHubTokens {

    /** "Pure Ink": a greyscale base palette with no hue, in a light and a dark edition. */
    @Immutable
    data class Palette(
        val bgPrimary: Color,
        val bgSecondary: Color,
        val bgSidebar: Color,
        val bgCard: Color,
        val bgCardHover: Color,
        val bgInput: Color,
        /** The composer card; the same as [bgInput] in light mode, one step lighter in dark mode. */
        val bgComposer: Color,
        val border: Color,
        val borderLight: Color,
        val accent: Color,
        val accentHover: Color,
        val accentMuted: Color,
        val textPrimary: Color,
        val textSecondary: Color,
        val textMuted: Color,
        val success: Color,
        val error: Color,
        val warning: Color,
        val info: Color,
        val msgUser: Color,
        val msgAssistant: Color,
        val codeBg: Color,
        val textOnAccent: Color,
        /** Launch/splash ground and system bars. */
        val splash: Color,
        val isDark: Boolean,
    ) {
        /** hover = accent @ 6 %. */
        val hover: Color get() = accent.copy(alpha = Alpha.HOVER)

        /** active/selected = accent @ 12 %. */
        val selected: Color get() = accent.copy(alpha = Alpha.SELECTED)

        /** Idle input border = accent @ 18 %. */
        val inputBorder: Color get() = accent.copy(alpha = Alpha.INPUT_BORDER)

        /** Hovered input border = accent @ 32 %. */
        val inputBorderHover: Color get() = accent.copy(alpha = Alpha.INPUT_BORDER_HOVER)

        /** Text selection = accent @ 30 %. */
        val textSelection: Color get() = accent.copy(alpha = Alpha.TEXT_SELECTION)

        /** Error rows sit on error @ 6 %. */
        val errorSurface: Color get() = error.copy(alpha = Alpha.HOVER)

        /** Category tag background: #7f7f7f @ 12 %. */
        val tagBackground: Color get() = Color(0xFF7F7F7F).copy(alpha = Alpha.SELECTED)

        /** Segmented-control track: accent @ 5 %. */
        val segmentTrack: Color get() = accent.copy(alpha = Alpha.SEGMENT_TRACK)
    }

    val Light = Palette(
        bgPrimary = Color(0xFFFAFAFA),
        bgSecondary = Color(0xFFF0F0F0),
        bgSidebar = Color(0xFFF5F5F5),
        bgCard = Color(0xFFFFFFFF),
        bgCardHover = Color(0xFFFAFAFA),
        bgInput = Color(0xFFFFFFFF),
        bgComposer = Color(0xFFFFFFFF),
        border = Color(0xFFE0E0E0),
        borderLight = Color(0xFFEBEBEB),
        accent = Color(0xFF333333),
        accentHover = Color(0xFF1A1A1A),
        accentMuted = Color(0xFF888888),
        textPrimary = Color(0xFF1A1A1A),
        textSecondary = Color(0xFF666666),
        textMuted = Color(0xFF999999),
        success = Color(0xFF2E7D32),
        error = Color(0xFFC62828),
        warning = Color(0xFFF57F17),
        info = Color(0xFF4A90D9),
        msgUser = Color(0xFFF5F5F5),
        msgAssistant = Color(0xFFF5F5F5),
        codeBg = Color(0xFFF4F4F4),
        textOnAccent = Color(0xFFFFFFFF),
        splash = Color(0xFFF7F7F4),
        isDark = false,
    )

    val Dark = Palette(
        bgPrimary = Color(0xFF1A1A1A),
        bgSecondary = Color(0xFF252525),
        bgSidebar = Color(0xFF202020),
        bgCard = Color(0xFF2A2A2A),
        bgCardHover = Color(0xFF333333),
        bgInput = Color(0xFF2A2A2A),
        bgComposer = Color(0xFF333333),
        border = Color(0xFF3A3A3A),
        borderLight = Color(0xFF333333),
        accent = Color(0xFFE0E0E0),
        accentHover = Color(0xFFF5F5F5),
        accentMuted = Color(0xFF888888),
        textPrimary = Color(0xFFE0E0E0),
        textSecondary = Color(0xFFA0A0A0),
        textMuted = Color(0xFF888888),
        success = Color(0xFF66BB6A),
        error = Color(0xFFEF5350),
        warning = Color(0xFFFFB74D),
        info = Color(0xFF6BA3D6),
        msgUser = Color(0xFF292929),
        msgAssistant = Color(0xFF292929),
        codeBg = Color(0xFF1E1E1E),
        textOnAccent = Color(0xFF1A1A1A),
        splash = Color(0xFF1A1A1A),
        isDark = true,
    )

    /** State formulas, as alpha applied to the accent (or error) colour. */
    object Alpha {
        const val SEGMENT_TRACK = 0.05f
        const val HOVER = 0.06f
        const val SELECTED = 0.12f
        const val INPUT_BORDER = 0.18f
        const val TEXT_SELECTION = 0.30f
        const val INPUT_BORDER_HOVER = 0.32f

        /** The session-row delete ✕ is visible at half strength on touch. */
        const val DELETE_AFFORDANCE = 0.5f

        /** Unread halo around the 6 px dot. */
        const val UNREAD_HALO = SELECTED
    }

    /** Type ramp. Inter/system sans for text, JetBrains Mono/monospace for code. */
    object Type {
        val sans: FontFamily = FontFamily.SansSerif
        val mono: FontFamily = FontFamily.Monospace

        /** Base size; the web lets the user adjust 12–20. */
        val base: TextUnit = 14.sp
        val bodyLineHeight: TextUnit = 22.sp // 14 × 1.6
        val message: TextUnit = 14.sp
        val messageLineHeight: TextUnit = 23.sp // 14 × 1.65

        /** Page and chat titles: 16 / 600. */
        val title: TextUnit = 16.sp
        val titleWeight: FontWeight = FontWeight.SemiBold

        /** Sidebar nav item. */
        val navItem: TextUnit = 14.sp

        /** Page-sidebar tab and session title. */
        val navTab: TextUnit = 13.sp
        val sessionTitle: TextUnit = 13.sp

        /** Author name above a message. */
        val author: TextUnit = 12.sp

        /** Time, meta, tool line. */
        val meta: TextUnit = 11.sp

        /** Group header: 10 / 600 uppercase, +0.5 letter-spacing. */
        val groupHeader: TextUnit = 10.sp
        val groupHeaderWeight: FontWeight = FontWeight.SemiBold
        val groupHeaderLetterSpacing: TextUnit = 0.5.sp

        val categoryTag: TextUnit = 10.sp

        /** Code: 13 / 1.5 mono. */
        val code: TextUnit = 13.sp
        val codeLineHeight: TextUnit = 20.sp

        /** Thinking block: 13 italic at 85 % opacity. */
        val thinking: TextUnit = 13.sp
        const val thinkingAlpha: Float = 0.85f

        /** Inputs never render below 16 sp on phones (no zoom). */
        val inputMin: TextUnit = 16.sp

        val selectedWeight: FontWeight = FontWeight.Medium
    }

    /** Corner radii. */
    object Radius {
        /** Buttons, nav items, tool rows, code block, session row. */
        val small: Dp = 6.dp

        /** Naive default; tool summary header. */
        val medium: Dp = 8.dp

        /** Message bubble. */
        val bubble: Dp = 10.dp

        /** Cards: sidebar, session list, chat main. */
        val card: Dp = 14.dp

        /** Composer card. */
        val composer: Dp = 18.dp

        /** Pills. */
        val pill: Dp = 999.dp

        /** Category tag, workspace chip. */
        val tag: Dp = 4.dp

        /** Segmented tab. */
        val segment: Dp = 5.dp
    }

    /**
     * Shadows. Compose has no blur/offset shadow primitive on Material
     * surfaces; the elevation approximates "0 8 24 rgba(0,0,0,.10)" etc.
     */
    object Shadow {
        val card: Dp = 8.dp
        val composer: Dp = 8.dp
        val composerFocused: Dp = 10.dp
        val cardAlphaLight = 0.10f
        val composerAlphaLight = 0.08f
        val composerAlphaDark = 0.32f
        val focusedAlpha = 0.11f
    }

    /** Durations and layout metrics. */
    object Metrics {
        const val transitionFastMs = 150
        const val transitionMs = 250

        /** Drawer slide. */
        const val drawerSlideMs = 250
        const val scrimAlpha = 0.40f

        val sidebarWidth: Dp = 240.dp
        val sidebarCollapsed: Dp = 64.dp

        /** Off-canvas drawer on phones (sidebar width plus its padding). */
        val drawerWidth: Dp = 300.dp
        val headerHeight: Dp = 60.dp
        val breakpoint: Dp = 768.dp

        val segmentHeight: Dp = 30.dp
        val sessionRowPaddingV: Dp = 8.dp
        val sessionRowPaddingH: Dp = 10.dp
        val pinSize: Dp = 11.dp
        val unreadDot: Dp = 6.dp
        val agentAvatar: Dp = 18.dp
        val profileChipAvatar: Dp = 16.dp
        val groupChevron: Dp = 10.dp
        val messageAvatar: Dp = 22.dp
        val actionButton: Dp = 24.dp
        val composerButton: Dp = 30.dp
        val composerMinHeight: Dp = 150.dp
        val contextBarWidth: Dp = 42.dp
        val contextBarHeight: Dp = 4.dp
        val workspaceIcon: Dp = 12.dp

        /**
         * Bottom sheets (the composer's attachment sheet first): a 36 × 4
         * handle, a 20 dp gutter, rows at least 56 dp tall so a thumb never
         * misses, a 40 dp icon tile holding a 20 dp icon, and an 18 dp
         * trailing chevron.
         */
        val sheetHandleWidth: Dp = 36.dp
        val sheetHandleHeight: Dp = 4.dp
        val sheetPadding: Dp = 20.dp
        val sheetRowMinHeight: Dp = 56.dp
        val sheetRowGap: Dp = 14.dp
        val sheetIconTile: Dp = 40.dp
        val sheetIcon: Dp = 20.dp
        val sheetTrailingIcon: Dp = 18.dp
        val sheetButtonHeight: Dp = 44.dp

        /** Long-press before the session context menu opens. */
        const val longPressMs = 500L

        /** Session list "Recent" group defaults and bounds. */
        const val recentDefault = 10
        const val recentMin = 1
        const val recentMax = 100

        /** Context indicator turns amber above this share. */
        const val contextWarnRatio = 0.80f
        val contextWarn: Color = Color(0xFFE8A735)
    }
}

val LocalCoreHubPalette = staticCompositionLocalOf { CoreHubTokens.Light }

/** Shorthand for the palette in effect. */
object CoreHub {
    val palette: CoreHubTokens.Palette
        @Composable
        @ReadOnlyComposable
        get() = LocalCoreHubPalette.current
}

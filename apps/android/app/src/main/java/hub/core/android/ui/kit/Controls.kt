package hub.core.android.ui.kit

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.generated.ControlTokens
import hub.core.android.generated.FontTokens
import hub.core.android.generated.TokenColors
import hub.core.android.ui.theme.LocalReducedMotion
import hub.core.android.ui.theme.LocalTokens

/*
 * The phone's control kit (docs/clients/DESIGN.md «UI policy»): the same controls as the web's
 * `src/ui/` and the iOS app, painted by the tokens alone. A screen never draws a Material button,
 * chip or field of its own — restyling a control is one edit here, for the whole app.
 *
 * Three heights and nothing invents a fourth (`control.height-sm|md|lg`); the item radius is the
 * track's minus its padding, so corners stay concentric.
 */

/** The three control heights of tokens.json. */
enum class ControlSize(val height: Dp, val pad: Dp, val font: TextUnit, val icon: Dp) {
    Sm(ControlTokens.heightSm.dp, ControlTokens.padSm.dp, FontTokens.sizeXs.sp, 14.dp),
    Md(ControlTokens.heightMd.dp, ControlTokens.padMd.dp, FontTokens.sizeSm.sp, 16.dp),
    Lg(ControlTokens.heightLg.dp, ControlTokens.padLg.dp, FontTokens.sizeMd.sp, 18.dp),
}

/** The radius of an item inside a track (buttons, chips, a segment). */
val ItemShape = RoundedCornerShape(ControlTokens.itemRadius.dp)

/** A Lucide icon ([Lucide]), tinted like text. */
@Composable
fun LucideIcon(
    icon: Int,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    size: Dp = 20.dp,
    tint: Color = LocalContentColor.current,
) {
    Icon(painterResource(icon), contentDescription, modifier.size(size), tint = tint)
}

/** The web's five button variants (`Button`): primary, secondary, ghost, subtle, danger. */
enum class ButtonKind { Primary, Secondary, Ghost, Subtle, Danger }

private data class Paint(val bg: Color, val fg: Color, val border: Color)

private fun paint(t: TokenColors, kind: ButtonKind): Paint = when (kind) {
    ButtonKind.Primary -> Paint(t.accent, t.accentText, t.accent)
    ButtonKind.Secondary -> Paint(t.surface, t.text, t.border)
    ButtonKind.Ghost -> Paint(Color.Transparent, t.textMuted, Color.Transparent)
    ButtonKind.Subtle -> Paint(t.accentSoft, t.accentSoftText, Color.Transparent)
    ButtonKind.Danger -> Paint(t.dangerSoft, t.dangerSoftText, Color.Transparent)
}

/**
 * A button: a label, an optional leading icon, and a spinner while [loading]. Disabled buttons
 * fade to half, as on the web.
 */
@Composable
fun HubButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.Primary,
    size: ControlSize = ControlSize.Lg,
    icon: Int? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    fill: Boolean = false,
) {
    val t = LocalTokens.current
    val p = paint(t, kind)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val bg = if (pressed && kind == ButtonKind.Primary) t.accentStrong else if (pressed && kind != ButtonKind.Danger) t.surface2 else p.bg
    Row(
        modifier
            .defaultMinSize(minHeight = size.height)
            .height(size.height)
            .alpha(if (enabled) 1f else 0.5f)
            .clip(ItemShape)
            .background(bg, ItemShape)
            .border(1.dp, p.border, ItemShape)
            .clickable(
                interactionSource = interaction,
                indication = ripple(),
                enabled = enabled && !loading,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = size.pad),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp, if (fill) Alignment.CenterHorizontally else Alignment.Start),
    ) {
        CompositionLocalProvider(LocalContentColor provides p.fg) {
            if (loading) Spinner(size.icon) else if (icon != null) LucideIcon(icon, null, size = size.icon)
            Text(text, fontSize = size.font, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** How an icon-only button is painted: bare (a toolbar's), a soft disc, or the accent disc (Send). */
enum class IconKind { Plain, Soft, Accent, Danger, Glass }

/**
 * An icon-only control: always named for TalkBack ([label]); a long press says the name too, as
 * the web's tooltip does.
 */
@Composable
fun HubIconButton(
    icon: Int,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: IconKind = IconKind.Plain,
    size: Dp = ControlTokens.heightLg.dp,
    iconSize: Dp = 20.dp,
    tint: Color? = null,
    enabled: Boolean = true,
    onLongClick: (() -> Unit)? = null,
    shape: Shape = CircleShape,
) {
    val t = LocalTokens.current
    val (bg, fg) = when (kind) {
        IconKind.Plain -> Color.Transparent to t.textMuted
        IconKind.Soft -> t.surface2 to t.text
        IconKind.Accent -> (if (enabled) t.accent else t.surface3) to (if (enabled) t.accentText else t.textFaint)
        IconKind.Danger -> t.danger to t.dangerText
        IconKind.Glass -> t.glassTint.copy(alpha = 0.78f) to t.text
    }
    Box(
        modifier
            .size(size)
            .clip(shape)
            .background(bg, shape)
            .then(if (kind == IconKind.Glass) Modifier.border(0.5.dp, t.border, shape) else Modifier)
            .combinedClickable(
                enabled = enabled || kind == IconKind.Accent && onLongClick != null,
                role = Role.Button,
                onClickLabel = label,
                onLongClick = onLongClick,
                onClick = { if (enabled) onClick() },
            )
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        LucideIcon(icon, null, size = iconSize, tint = tint ?: fg)
    }
}

/** A small tinted pill (the web's `Badge`): a state, a profile, a count. */
enum class BadgeTone { Neutral, Accent, Success, Warning, Danger, Info, Review }

@Composable
fun Badge(text: String, modifier: Modifier = Modifier, tone: BadgeTone = BadgeTone.Neutral, dot: Boolean = false) {
    val t = LocalTokens.current
    val (bg, fg) = badgeColors(t, tone)
    Row(
        modifier.background(bg, CircleShape).padding(horizontal = 8.dp, vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (dot) Box(Modifier.size(6.dp).background(fg, CircleShape))
        Text(text, fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.Medium, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

fun badgeColors(t: TokenColors, tone: BadgeTone): Pair<Color, Color> = when (tone) {
    BadgeTone.Neutral -> t.surface2 to t.textMuted
    BadgeTone.Accent -> t.accentSoft to t.accentSoftText
    BadgeTone.Success -> t.successSoft to t.successSoftText
    BadgeTone.Warning -> t.warningSoft to t.warningSoftText
    BadgeTone.Danger -> t.dangerSoft to t.dangerSoftText
    BadgeTone.Info -> t.infoSoft to t.infoSoftText
    BadgeTone.Review -> t.reviewSoft to t.reviewSoftText
}

/**
 * A state as a dot, not a word (owner, 2026-09-27: «نقطة خضراء بدل كلمة أونلاين»): the colour
 * says it at a glance, [label] says it to TalkBack.
 */
@Composable
fun StatusDot(color: Color, label: String?, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    Box(
        modifier.size(size).background(color, CircleShape)
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier),
    )
}

/** The one waiting glyph: a ring with a gap that turns (slower when motion is reduced). */
@Composable
fun Spinner(size: Dp = 18.dp, color: Color = LocalContentColor.current, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val turn = rememberInfiniteTransition(label = "spinner")
    val angle by turn.animateFloat(
        0f, 360f,
        infiniteRepeatable(tween(if (reduced) 2400 else 700, easing = LinearEasing), RepeatMode.Restart),
        label = "angle",
    )
    Canvas(modifier.size(size).rotate(angle)) {
        val stroke = 2.dp.toPx()
        drawArc(
            color, startAngle = 0f, sweepAngle = 270f, useCenter = false,
            topLeft = Offset(stroke / 2, stroke / 2), size = Size(this.size.width - stroke, this.size.height - stroke),
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
    }
}

/** A hairline in the border colour. */
@Composable
fun Hairline(modifier: Modifier = Modifier, color: Color = LocalTokens.current.border) {
    Box(modifier.height(0.5.dp).background(color))
}

package hub.core.android.ui.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.ui.theme.LocalTokens

val CardShape = RoundedCornerShape(RadiusTokens.lg.dp)

/** A solid content card (DESIGN.md: content stays solid, only chrome is glass). */
@Composable
fun HubCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    padding: Dp = 14.dp,
    color: Color? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val t = LocalTokens.current
    Column(
        modifier.fillMaxWidth().clip(CardShape).background(color ?: t.surface, CardShape).border(0.5.dp, t.border, CardShape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(padding),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

/** A small caption above a group of rows or cards («Management», «To do · 1»). */
@Composable
fun SectionTitle(
    text: String,
    modifier: Modifier = Modifier,
    leading: (@Composable RowScope.() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    val t = LocalTokens.current
    Row(
        modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 16.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        leading?.invoke(this)
        Text(text, fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.SemiBold, color = t.textMuted, modifier = Modifier.weight(1f))
        trailing?.invoke(this)
    }
}

/**
 * An inset group of rows (iOS's grouped list, the web's settings panel): one card, rows separated
 * by hairlines that start after the icon. Every row draws the hairline above it; the group hides
 * the first one.
 */
@Composable
fun GroupedList(modifier: Modifier = Modifier, title: String? = null, content: @Composable GroupScope.() -> Unit) {
    val t = LocalTokens.current
    Column(modifier.fillMaxWidth()) {
        if (title != null) SectionTitle(title)
        Column(Modifier.fillMaxWidth().clip(CardShape).background(t.surface, CardShape).border(0.5.dp, t.border, CardShape)) {
            Column(
                Modifier.fillMaxWidth().layout { measurable, constraints ->
                    val placeable = measurable.measure(constraints)
                    val cut = 1.dp.roundToPx().coerceAtMost(placeable.height)
                    layout(placeable.width, placeable.height - cut) { placeable.place(0, -cut) }
                },
            ) { GroupScope.content() }
        }
    }
}

/** Rows of a [GroupedList]. */
object GroupScope

/**
 * One row of a group: an icon, a title and a line under it, and something at its end (a value, a
 * badge, a chevron when it opens a page).
 */
@Composable
fun GroupScope.Item(
    title: String,
    modifier: Modifier = Modifier,
    icon: Int? = null,
    subtitle: String? = null,
    value: String? = null,
    chevron: Boolean = false,
    danger: Boolean = false,
    tag: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    accent: Boolean = false,
) = ListRow(title, modifier, icon, subtitle, value, chevron, danger, tag, onClick, trailing, divider = true, accent = accent)

/** Any content as a row of a group, under the same hairline. */
@Composable
fun GroupScope.Custom(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth()) {
        Hairline(Modifier.fillMaxWidth().padding(start = 14.dp))
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

/** The row itself, usable outside a group too (a plain list). */
@Composable
fun ListRow(
    title: String,
    modifier: Modifier = Modifier,
    icon: Int? = null,
    subtitle: String? = null,
    value: String? = null,
    chevron: Boolean = false,
    danger: Boolean = false,
    tag: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    divider: Boolean = false,
    /** A link-like row (iOS's «Back to chats»): the words and the icon in the accent. */
    accent: Boolean = false,
) {
    val t = LocalTokens.current
    Column(modifier.fillMaxWidth()) {
        if (divider) Hairline(Modifier.fillMaxWidth().padding(start = if (icon != null) 48.dp else 14.dp))
        Row(
            Modifier.fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .then(if (tag != null) Modifier.testTag(tag) else Modifier)
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val tone = when {
                danger -> t.danger
                accent -> t.accent
                else -> null
            }
            if (icon != null) LucideIcon(icon, null, size = 20.dp, tint = tone ?: t.textMuted)
            Column(Modifier.weight(1f)) {
                Text(
                    title, fontSize = FontTokens.sizeMd.sp, color = tone ?: t.text,
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
            if (value != null) Text(value, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, maxLines = 1)
            trailing?.invoke(this)
            if (chevron) LucideIcon(Lucide.ChevronRight, null, size = 16.dp, tint = t.textFaint)
        }
    }
}

/** A page with nothing to show yet: an icon, what it is, and the one thing to do. */
@Composable
fun EmptyState(
    title: String,
    modifier: Modifier = Modifier,
    body: String? = null,
    icon: Int? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val t = LocalTokens.current
    Column(
        modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) {
            Box(Modifier.size(48.dp).background(t.surface2, RoundedCornerShape(RadiusTokens.lg.dp)), contentAlignment = Alignment.Center) {
                LucideIcon(icon, null, size = 24.dp, tint = t.textMuted)
            }
        }
        Text(title, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold, color = t.text, textAlign = TextAlign.Center)
        if (body != null) Text(body, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, textAlign = TextAlign.Center)
        if (action != null) Box(Modifier.padding(top = 8.dp)) { action() }
    }
}

/** A tinted notice (information, success, warning, danger) on a solid surface, with its icon. */
@Composable
fun NoticeBox(text: String, tone: BadgeTone, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val t = LocalTokens.current
    val (bg, fg) = badgeColors(t, tone)
    val icon = when (tone) {
        BadgeTone.Danger -> Lucide.CircleX
        BadgeTone.Warning -> Lucide.TriangleAlert
        BadgeTone.Success -> Lucide.CircleCheck
        else -> Lucide.Info
    }
    Row(
        modifier.fillMaxWidth().background(bg, RoundedCornerShape(RadiusTokens.md.dp)).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        CompositionLocalProvider(LocalContentColor provides fg) {
            LucideIcon(icon, null, size = 18.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(text, fontSize = FontTokens.sizeSm.sp, style = androidx.compose.ui.text.TextStyle(textDirection = TextDirection.Content))
                action?.invoke()
            }
        }
    }
}


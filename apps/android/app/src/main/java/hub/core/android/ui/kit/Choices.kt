package hub.core.android.ui.kit

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import hub.core.android.generated.ControlTokens
import hub.core.android.generated.FontTokens
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.unit.sp
import hub.core.android.ui.theme.LocalTokens

/** One option of a [Segmented] control. */
data class Segment<T>(val value: T, val label: String, val icon: Int? = null, val tag: String? = null)

/**
 * The one row-of-choices (the web's `Segmented`, iOS's segmented picker): a sunken track with the
 * chosen item raised on it. [fill] spreads the items over the whole width.
 */
@Composable
fun <T> Segmented(
    options: List<Segment<T>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    size: ControlSize = ControlSize.Md,
    fill: Boolean = true,
) {
    val t = LocalTokens.current
    val track = RoundedCornerShape(ControlTokens.trackRadius.dp)
    Row(
        modifier.height(size.height).background(t.controlTrack, track).border(0.5.dp, t.border, track).padding(ControlTokens.trackPad.dp),
        horizontalArrangement = Arrangement.spacedBy(ControlTokens.gap.dp),
    ) {
        options.forEach { option ->
            val on = option.value == selected
            val bg by animateColorAsState(if (on) t.controlRaised else Color.Transparent, label = "segment")
            Row(
                (if (fill) Modifier.weight(1f) else Modifier).fillMaxHeight()
                    .then(if (on) Modifier.shadow(1.dp, ItemShape) else Modifier)
                    .clip(ItemShape).background(bg, ItemShape)
                    .selectable(on, role = Role.Tab) { onSelect(option.value) }
                    .padding(horizontal = size.pad)
                    .then(if (option.tag != null) Modifier.testTag(option.tag) else Modifier),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            ) {
                CompositionLocalProvider(LocalContentColor provides if (on) t.text else t.textMuted) {
                    option.icon?.let { LucideIcon(it, null, size = size.icon) }
                    Text(
                        option.label, fontSize = size.font, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * A choice chip (agent picker, filters): a capsule, raised in the accent's soft tint when chosen,
 * as on iOS and the web.
 */
@Composable
fun Chip(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: ControlSize = ControlSize.Md,
    leading: (@Composable RowScope.() -> Unit)? = null,
) {
    val t = LocalTokens.current
    Row(
        modifier.height(size.height).clip(CircleShape)
            .background(if (selected) t.accentSoft else t.surface, CircleShape)
            .border(1.dp, if (selected) t.accent else t.border, CircleShape)
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = size.pad),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        leading?.invoke(this)
        Text(
            text, fontSize = size.font, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) t.accentSoftText else t.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A switch in the tokens: the accent track when on. */
@Composable
fun HubSwitch(checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val t = LocalTokens.current
    val knob by animateDpAsState(if (checked) 18.dp else 2.dp, label = "knob")
    val track by animateColorAsState(if (checked) t.accent else t.surface3, label = "track")
    Box(
        modifier.width(40.dp).height(24.dp).clip(CircleShape).background(track, CircleShape)
            .toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
    ) {
        Box(
            Modifier.offset { androidx.compose.ui.unit.IntOffset(knob.roundToPx(), 0) }.align(Alignment.CenterStart).size(20.dp)
                .shadow(1.dp, CircleShape).background(if (checked) t.accentText else t.controlRaised, CircleShape),
        )
    }
}

/** A tick box in the tokens. */
@Composable
fun HubCheckbox(checked: Boolean, onChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    val shape = RoundedCornerShape(6.dp)
    Box(
        modifier.size(20.dp).clip(shape)
            .background(if (checked) t.accent else t.surface, shape)
            .border(1.5.dp, if (checked) t.accent else t.borderStrong, shape)
            .then(if (onChange != null) Modifier.toggleable(checked, role = Role.Checkbox, onValueChange = onChange) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        if (checked) LucideIcon(Lucide.Check, null, size = 14.dp, tint = t.accentText)
    }
}

/** A radio mark in the tokens (the row around it takes the click). */
@Composable
fun HubRadio(selected: Boolean, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    Box(
        modifier.size(20.dp).border(1.5.dp, if (selected) t.accent else t.borderStrong, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) Box(Modifier.size(10.dp).background(t.accent, CircleShape))
    }
}

/** A row that toggles: the whole row takes the tap. */
@Composable
fun ToggleRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier, subtitle: String? = null, enabled: Boolean = true) {
    val t = LocalTokens.current
    Row(
        modifier.clickable(enabled = enabled) { onChange(!checked) }.padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = t.text, fontSize = FontTokens.sizeMd.sp)
            if (!subtitle.isNullOrBlank()) {
                Text(subtitle, color = t.textMuted, fontSize = FontTokens.sizeSm.sp)
            }
        }
        HubSwitch(checked, onChange, enabled = enabled)
    }
}

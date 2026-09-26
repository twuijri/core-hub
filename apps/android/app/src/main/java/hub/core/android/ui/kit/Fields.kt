package hub.core.android.ui.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.theme.LocalTokens

/**
 * A text field in the tokens (the web's `Input`): a solid surface, a hairline border that turns
 * accent while typing, an optional leading icon and trailing slot. The text decides its own
 * direction; the placeholder follows it.
 */
@Composable
fun HubTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    label: String? = null,
    leadingIcon: Int? = null,
    trailing: (@Composable () -> Unit)? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 6,
    enabled: Boolean = true,
    mono: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    size: ControlSize = ControlSize.Lg,
    error: String? = null,
    focusRequester: FocusRequester? = null,
    fieldTag: String? = null,
) {
    val t = LocalTokens.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val style = TextStyle(
        color = t.text, fontSize = (if (size == ControlSize.Sm) FontTokens.sizeSm else FontTokens.sizeMd).sp,
        textDirection = if (mono) TextDirection.Ltr else TextDirection.Content,
        fontFamily = if (mono) FontFamily.Monospace else null,
    )
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (label != null) Text(label, fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
            textStyle = style,
            cursorBrush = SolidColor(t.accent),
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            visualTransformation = visualTransformation,
            interactionSource = interaction,
            modifier = Modifier.fillMaxWidth()
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                .then(if (fieldTag != null) Modifier.testTag(fieldTag) else Modifier),
            decorationBox = { inner ->
                val border = when {
                    error != null -> t.danger
                    focused -> t.accent
                    else -> t.border
                }
                Row(
                    Modifier.fillMaxWidth().defaultMinSize(minHeight = size.height)
                        .background(t.surface, ItemShape).border(1.dp, border, ItemShape)
                        .padding(horizontal = 12.dp, vertical = if (singleLine) 0.dp else 8.dp),
                    verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    leadingIcon?.let { LucideIcon(it, null, size = 16.dp, tint = t.textFaint) }
                    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                        if (value.isEmpty() && placeholder != null) {
                            Text(placeholder, style = style.copy(color = t.textFaint), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        inner()
                    }
                    trailing?.invoke()
                }
            },
        )
        if (error != null) Text(error, fontSize = FontTokens.sizeXs.sp, color = t.danger)
    }
}

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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import hub.core.android.R
import hub.core.android.generated.FontTokens
import hub.core.android.generated.LayoutTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.ui.theme.LocalGlassLevel
import hub.core.android.ui.theme.LocalTokens
import hub.core.android.ui.theme.glass

/**
 * The page's top bar, as on iOS: the menu (or back) as a round glass button at the start, the
 * title centred with an optional line under it, round actions at the end. It sits on the page's
 * own background and floats nothing over the content.
 */
@Composable
fun HubTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onMenu: (() -> Unit)? = null,
    onBack: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val t = LocalTokens.current
    Box(
        modifier.fillMaxWidth().statusBarsPadding().height(LayoutTokens.topbarHeight.dp).padding(horizontal = 12.dp),
    ) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically) {
            when {
                leading != null -> leading()
                onBack != null -> HubIconButton(Lucide.ArrowLeft, stringResource(R.string.back), onBack, kind = IconKind.Glass, modifier = Modifier.testTag("topbar.back"))
                onMenu != null -> HubIconButton(Lucide.Menu, stringResource(R.string.menu_open), onMenu, kind = IconKind.Glass, modifier = Modifier.testTag("shell.menu"))
            }
        }
        Column(
            Modifier.align(Alignment.Center).padding(horizontal = 56.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                title, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, color = t.text,
                maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() }.testTag("topbar.title"),
            )
            if (!subtitle.isNullOrBlank()) {
                Text(subtitle, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("topbar.subtitle"))
            }
        }
        Row(
            Modifier.align(Alignment.CenterEnd),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            content = actions,
        )
    }
}

/** A popover menu in the tokens: a solid surface, the medium radius, a hairline. */
@Composable
fun HubMenu(expanded: Boolean, onDismiss: () -> Unit, modifier: Modifier = Modifier, offset: DpOffset = DpOffset(0.dp, 4.dp), content: @Composable ColumnScope.() -> Unit) {
    val t = LocalTokens.current
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        offset = offset,
        shape = RoundedCornerShape(RadiusTokens.md.dp),
        containerColor = t.surface,
        tonalElevation = 0.dp,
        shadowElevation = 8.dp,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, t.border),
        modifier = modifier.widthIn(min = 200.dp),
    ) {
        CompositionLocalProvider(LocalContentColor provides t.text) { content() }
    }
}

/** One item of a [HubMenu]: an icon, the words, and a check when it is the current choice. */
@Composable
fun MenuItem(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: Int? = null,
    checked: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
) {
    val t = LocalTokens.current
    val color = if (danger) t.danger else t.text
    Row(
        modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) LucideIcon(icon, null, size = 18.dp, tint = if (danger) t.danger else t.textMuted)
        Text(text, fontSize = FontTokens.sizeMd.sp, color = if (enabled) color else t.textFaint, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (checked) LucideIcon(Lucide.Check, null, size = 16.dp, tint = t.accent)
    }
}

/** A caption inside a menu or sheet, above a group of its items. */
@Composable
fun MenuLabel(text: String) {
    Text(
        text, fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.SemiBold, color = LocalTokens.current.textMuted,
        modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 4.dp),
    )
}

/** A hairline between groups of a menu. */
@Composable
fun MenuDivider() = Hairline(Modifier.fillMaxWidth().padding(vertical = 4.dp))

/**
 * A sheet from the bottom (secondary actions and filters on a phone): glass-free, solid surface,
 * a grabber, a title, and the content.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HubSheet(onDismiss: () -> Unit, modifier: Modifier = Modifier, title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val t = LocalTokens.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = t.bgRaised,
        contentColor = t.text,
        scrimColor = t.scrim,
        tonalElevation = 0.dp,
        shape = RoundedCornerShape(topStart = RadiusTokens.xl.dp, topEnd = RadiusTokens.xl.dp),
        dragHandle = {
            Box(Modifier.padding(top = 8.dp, bottom = 4.dp).size(width = 36.dp, height = 5.dp).background(t.borderStrong.copy(alpha = 0.5f), CircleShape))
        },
        modifier = modifier,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (title != null) {
                Text(
                    title, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(vertical = 4.dp).semantics { heading() },
                )
            }
            content()
        }
    }
}

/**
 * «Are you sure» (the web's `useConfirm()`): a title, what happens, Cancel and the action — the
 * action in danger red when it cannot be undone.
 */
@Composable
fun ConfirmDialog(
    title: String,
    body: String?,
    confirm: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    danger: Boolean = false,
    dismiss: String = stringResource(R.string.cancel),
) {
    HubDialog(onDismiss, title) {
        if (body != null) Text(body, fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted)
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HubButton(dismiss, onDismiss, kind = ButtonKind.Secondary, size = ControlSize.Md)
            HubButton(confirm, onConfirm, kind = if (danger) ButtonKind.Danger else ButtonKind.Primary, size = ControlSize.Md, modifier = Modifier.testTag("dialog.confirm"))
        }
    }
}

/** A dialog in the tokens: solid surface, the large radius, the page's text colours. */
@Composable
fun HubDialog(onDismiss: () -> Unit, title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val t = LocalTokens.current
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().background(t.surface, RoundedCornerShape(RadiusTokens.xl.dp))
                .border(0.5.dp, t.border, RoundedCornerShape(RadiusTokens.xl.dp)).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            CompositionLocalProvider(LocalContentColor provides t.text) {
                if (title != null) {
                    Text(title, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                }
                content()
            }
        }
    }
}

/** Floating glass chrome (composer, dictation strip): the tint, the hairline, the extra-large radius. */
@Composable
fun Modifier.floatingChrome(radius: androidx.compose.ui.unit.Dp = RadiusTokens.xl.dp): Modifier =
    glass(LocalTokens.current, LocalGlassLevel.current, RoundedCornerShape(radius))

@Composable
internal fun HSpace(width: androidx.compose.ui.unit.Dp) = Spacer(Modifier.width(width))

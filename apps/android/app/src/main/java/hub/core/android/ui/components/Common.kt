package hub.core.android.ui.components

import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.Spinner
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.ui.theme.LocalTokens

/** The hub's words for a failure, or ours when it could not be reached. */
@Composable
fun errorText(error: HubError): String = when {
    error.offline -> stringResource(R.string.error_offline)
    error.status == 501 -> stringResource(R.string.error_not_built)
    !error.text.isNullOrBlank() -> error.text
    error.code != null -> stringResource(R.string.error_code, error.code)
    else -> stringResource(R.string.error_unknown)
}

/** A message on a tinted, solid surface: danger, warning or information. */
enum class Tone { DANGER, WARNING, INFO, SUCCESS }

@Suppress("ModifierParameter") // the older call sites name the tone before modifier
@Composable
fun Notice(text: String, tone: Tone = Tone.DANGER, modifier: Modifier = Modifier) {
    NoticeBox(
        text,
        when (tone) {
            Tone.DANGER -> BadgeTone.Danger
            Tone.WARNING -> BadgeTone.Warning
            Tone.INFO -> BadgeTone.Info
            Tone.SUCCESS -> BadgeTone.Success
        },
        modifier,
    )
}

@Composable
fun ErrorNotice(error: HubError?, modifier: Modifier = Modifier) {
    if (error != null) Notice(errorText(error), Tone.DANGER, modifier)
}

/** The product's mark, as on the web: the Core Hub mark in the accent (res/drawable/ic_brand_mark, made by scripts/icons/build-icons.mjs). */
@Composable
fun BrandMark(size: Int = 28) {
    Icon(
        painterResource(R.drawable.ic_brand_mark),
        contentDescription = null,
        tint = LocalTokens.current.accent,
        modifier = Modifier.size(size.dp).testTag("brand.mark"),
    )
}

@Composable
fun BrandName(modifier: Modifier = Modifier) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = modifier) {
        BrandMark()
        Text(stringResource(R.string.app_name), fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.Bold, color = LocalTokens.current.text)
    }
}

/** A small pill naming the profile an item lives in (lists that show more than one profile). */
@Composable
fun ProfileBadge(name: String, modifier: Modifier = Modifier) = Badge(name, modifier, tone = BadgeTone.Accent)

@Composable
fun Loading(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner(24.dp, LocalTokens.current.textMuted) }
}

@Composable
@Suppress("ModifierParameter") // the older call sites name body before modifier
fun EmptyState(title: String, body: String? = null, modifier: Modifier = Modifier) =
    hub.core.android.ui.kit.EmptyState(title, modifier, body = body)

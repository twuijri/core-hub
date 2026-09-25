package hub.core.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
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

@Composable
fun Notice(text: String, tone: Tone = Tone.DANGER, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    val (bg, fg) = when (tone) {
        Tone.DANGER -> t.dangerSoft to t.dangerSoftText
        Tone.WARNING -> t.warningSoft to t.warningSoftText
        Tone.INFO -> t.infoSoft to t.infoSoftText
        Tone.SUCCESS -> t.successSoft to t.successSoftText
    }
    Surface(color = bg, contentColor = fg, shape = MaterialTheme.shapes.medium, modifier = modifier.fillMaxWidth()) {
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
    }
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
        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleMedium)
    }
}

/** A small pill naming the profile an item lives in (lists that show more than one profile). */
@Composable
fun ProfileBadge(name: String, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    Surface(color = t.surface2, contentColor = t.textMuted, shape = CircleShape, modifier = modifier) {
        Text(name, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
    }
}

@Composable
fun Loading(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
fun EmptyState(title: String, body: String? = null, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
        if (body != null) {
            Text(body, style = MaterialTheme.typography.bodyMedium, color = LocalTokens.current.textMuted, textAlign = TextAlign.Center)
        }
    }
}

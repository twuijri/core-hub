package hub.core.android.ui.components

import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.Lucide
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.ui.theme.LocalTokens

/** A page's data: still loading, failed with the hub's words, or here. */
sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Failed(val error: HubError) : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
}

/** Loads [block] whenever [keys] change or [Loader.reload] is called. */
class Loader<T>(val state: Load<T>, val reload: () -> Unit)

@Composable
fun <T> rememberLoad(vararg keys: Any?, block: suspend () -> T): Loader<T> {
    var tick by remember { mutableIntStateOf(0) }
    var state by remember(*keys) { mutableStateOf<Load<T>>(Load.Loading) }
    LaunchedEffect(*keys, tick) {
        hubCall { block() }
            .onSuccess { state = Load.Ready(it) }
            .onFailure { state = Load.Failed(it as HubError) }
    }
    return Loader(state) { tick++ }
}

/** Draws a [Load]: a spinner, the failure with Retry, or [content]. */
@Composable
fun <T> LoadView(loader: Loader<T>, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    when (val s = loader.state) {
        Load.Loading -> Loading(modifier)
        is Load.Failed -> Column(modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ErrorNotice(s.error)
            HubButton(stringResource(R.string.retry), loader.reload, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.RefreshCw)
        }
        is Load.Ready -> content(s.value)
    }
}

/** One row of a read-mostly list: a solid card with a title, a line under it, and something at its end. */
@Suppress("ModifierParameter") // the older call sites pass the subtitle second
@Composable
fun ListRow(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    trailing: @Composable () -> Unit = {},
    onClick: (() -> Unit)? = null,
) {
    val t = LocalTokens.current
    HubCard(modifier, onClick = onClick, padding = 0.dp) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.Medium, color = t.text, maxLines = 2, overflow = TextOverflow.Ellipsis, style = TextStyle(textDirection = TextDirection.Content))
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, maxLines = 3, overflow = TextOverflow.Ellipsis, style = TextStyle(textDirection = TextDirection.Content))
                }
            }
            trailing()
        }
    }
}

/** A small label for a state (running, paused, failed…), tinted by what it means. */
@Composable
fun StatusBadge(text: String, tone: Tone? = null) {
    Badge(
        text,
        tone = when (tone) {
            Tone.SUCCESS -> BadgeTone.Success
            Tone.DANGER -> BadgeTone.Danger
            Tone.WARNING -> BadgeTone.Warning
            Tone.INFO -> BadgeTone.Info
            null -> BadgeTone.Neutral
        },
    )
}

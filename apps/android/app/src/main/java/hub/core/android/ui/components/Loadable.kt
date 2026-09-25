package hub.core.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
            TextButton(onClick = loader.reload) { Text(stringResource(R.string.retry)) }
        }
        is Load.Ready -> content(s.value)
    }
}

/** One row of a read-mostly list: a title, a line under it, and something at its end. */
@Composable
fun ListRow(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    trailing: @Composable () -> Unit = {},
    onClick: (() -> Unit)? = null,
) {
    val t = LocalTokens.current
    Surface(
        color = t.surface,
        shape = MaterialTheme.shapes.medium,
        onClick = onClick ?: {},
        enabled = onClick != null,
        modifier = modifier.fillMaxWidth(),
    ) {
        androidx.compose.foundation.layout.Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, style = MaterialTheme.typography.bodySmall, color = t.textMuted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
            trailing()
        }
    }
}

/** A small label for a state (running, paused, failed…), tinted by what it means. */
@Composable
fun StatusBadge(text: String, tone: Tone? = null) {
    val t = LocalTokens.current
    val (bg, fg) = when (tone) {
        Tone.SUCCESS -> t.successSoft to t.successSoftText
        Tone.DANGER -> t.dangerSoft to t.dangerSoftText
        Tone.WARNING -> t.warningSoft to t.warningSoftText
        Tone.INFO -> t.infoSoft to t.infoSoftText
        null -> t.surface2 to t.textMuted
    }
    Surface(color = bg, contentColor = fg, shape = MaterialTheme.shapes.small) {
        Text(text, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

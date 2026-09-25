package hub.core.android.ui.screens

import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.graph
import hub.core.android.tools.LogLevel
import hub.core.android.tools.LogSource
import hub.core.android.tools.LogsModel
import hub.core.android.tools.PerformanceModel
import hub.core.android.ui.components.EmptyState
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.ListRow
import hub.core.android.ui.components.Loading
import hub.core.android.ui.components.StatusBadge
import hub.core.android.ui.components.Tone
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.HermesProcess
import hub.core.client.model.LogLine
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Settings → Logs: what the hub and every Hermes gateway wrote lately (owners and admins). */
@Composable
fun LogsPage() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val model = remember { LogsModel { context.graph.apis(context.graph.store.current!!).audit } }
    val state by model.state.collectAsState()
    val list = rememberLazyListState()
    LaunchedEffect(model) { model.load() }
    // Follow the newest line, the way a log is read.
    LaunchedEffect(state.lines.size) { if (state.lines.isNotEmpty()) list.scrollToItem(state.lines.lastIndex) }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LogSource.entries.forEach { source ->
                FilterChip(
                    selected = state.source == source,
                    onClick = { scope.launch { model.setSource(source) } },
                    label = { Text(stringResource(sourceLabel(source))) },
                )
            }
            IconButton(onClick = { scope.launch { model.refresh() } }) {
                Icon(Icons.Default.Refresh, stringResource(R.string.tools_refresh))
            }
        }
        if (state.source != LogSource.ERRORS) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(stringResource(R.string.logs_level), style = MaterialTheme.typography.labelMedium, color = LocalTokens.current.textMuted)
                LogLevel.entries.forEach { level ->
                    FilterChip(
                        selected = state.level == level,
                        onClick = { scope.launch { model.setLevel(level) } },
                        label = { Text(stringResource(levelLabel(level))) },
                    )
                }
            }
        }
        Text(
            stringResource(R.string.logs_kept),
            style = MaterialTheme.typography.bodySmall,
            color = LocalTokens.current.textMuted,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
        ErrorNotice(state.error, Modifier.padding(horizontal = 12.dp))
        when {
            state.loading && state.lines.isEmpty() -> Loading()
            state.lines.isEmpty() -> EmptyState(stringResource(R.string.logs_empty))
            else -> LazyColumn(
                state = list,
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(state.lines, key = { it.seq }) { line -> LogRow(line) }
            }
        }
    }
}

@Composable
private fun LogRow(line: LogLine) {
    val t = LocalTokens.current
    Surface(color = t.surface, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(stringResource(shortLevel(line.level)), levelTone(line.level))
                Text(whereFrom(line), style = MaterialTheme.typography.labelSmall, color = t.textMuted)
                Text(localTime(line.at), style = MaterialTheme.typography.labelSmall, color = t.textMuted)
            }
            // A log line is the program's words: read as written, left to right unless it is not.
            Text(
                line.message,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, textDirection = TextDirection.Content),
            )
        }
    }
}

@Composable
private fun whereFrom(line: LogLine): String = when {
    line.source == LogLine.Source.HUB -> stringResource(R.string.logs_from_hub)
    line.profile == "tui" -> stringResource(R.string.logs_from_tui)
    else -> stringResource(R.string.logs_from_hermes, line.profile ?: "default")
}

private fun sourceLabel(source: LogSource) = when (source) {
    LogSource.ALL -> R.string.logs_source_all
    LogSource.HUB -> R.string.logs_source_hub
    LogSource.HERMES -> R.string.logs_source_hermes
    LogSource.ERRORS -> R.string.logs_source_errors
}

private fun levelLabel(level: LogLevel) = when (level) {
    LogLevel.DEBUG -> R.string.logs_level_debug
    LogLevel.INFO -> R.string.logs_level_info
    LogLevel.WARN -> R.string.logs_level_warn
    LogLevel.ERROR -> R.string.logs_level_error
}

private fun shortLevel(level: LogLine.Level) = when (level) {
    LogLine.Level.ERROR -> R.string.logs_short_error
    LogLine.Level.WARN -> R.string.logs_short_warn
    LogLine.Level.INFO -> R.string.logs_short_info
    LogLine.Level.DEBUG -> R.string.logs_short_debug
}

private fun levelTone(level: LogLine.Level): Tone? = when (level) {
    LogLine.Level.ERROR -> Tone.DANGER
    LogLine.Level.WARN -> Tone.WARNING
    LogLine.Level.INFO -> Tone.INFO
    LogLine.Level.DEBUG -> null
}

/** Settings → Performance: the host, the hub and every Hermes process, asked for again while shown. */
@Composable
fun PerformancePage() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val model = remember { PerformanceModel { context.graph.apis(context.graph.store.current!!).audit } }
    val state by model.state.collectAsState()
    // Measured when asked: every `interval_seconds` while this page is on screen, never behind it.
    LaunchedEffect(model) {
        while (true) {
            model.refresh()
            delay(model.intervalMs)
        }
    }
    val live = state.live
    if (live == null) {
        Column(Modifier.fillMaxSize()) {
            ErrorNotice(state.error, Modifier.padding(12.dp))
            if (state.loading) Loading()
        }
        return
    }
    val bytes = { value: Long? -> value?.let { Formatter.formatShortFileSize(context, it) } ?: "—" }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.perf_every, live.intervalSeconds, localTime(live.at)),
                    style = MaterialTheme.typography.bodySmall,
                    color = LocalTokens.current.textMuted,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { scope.launch { model.refresh() } }) {
                    Icon(Icons.Default.Refresh, stringResource(R.string.tools_refresh))
                }
            }
        }
        if (state.error != null) item { ErrorNotice(state.error) }
        item { Section(stringResource(R.string.perf_host)) }
        item {
            ListRow(
                stringResource(R.string.perf_cpu),
                stringResource(R.string.perf_cores, percent(live.host.cpuPercent), live.host.cpuCount),
            )
        }
        item {
            ListRow(
                stringResource(R.string.perf_memory),
                stringResource(R.string.perf_of, bytes(live.host.memoryUsedBytes), bytes(live.host.memoryTotalBytes)),
            )
        }
        item { ListRow(stringResource(R.string.perf_load), live.host.load?.joinToString(" · ") { decimal(it) } ?: "—") }
        if (live.host.measuredFrom.value == "os") {
            item { Text(stringResource(R.string.perf_no_proc), style = MaterialTheme.typography.bodySmall, color = LocalTokens.current.textMuted) }
        }
        item { Section(stringResource(R.string.perf_hub)) }
        item { ListRow(stringResource(R.string.perf_cpu), percent(live.hub.cpuPercent)) }
        item {
            ListRow(
                stringResource(R.string.perf_rss),
                stringResource(R.string.perf_heap, bytes(live.hub.rssBytes), bytes(live.hub.heapUsedBytes)),
            )
        }
        item {
            ListRow(
                stringResource(R.string.perf_lag),
                live.hub.eventLoopLagMs?.let { stringResource(R.string.perf_ms, decimal(it)) } ?: "—",
            )
        }
        item {
            ListRow(
                stringResource(R.string.perf_uptime),
                "${DateUtils.formatElapsedTime(live.hub.uptimeSeconds.toLong())} · Node ${live.hub.nodeVersion}",
            )
        }
        item { Section(stringResource(R.string.perf_hermes)) }
        if (live.processes.isEmpty()) item { Text(stringResource(R.string.perf_no_hermes), color = LocalTokens.current.textMuted) }
        items(live.processes, key = { "${it.kind.value}/${it.profile}/${it.pid}" }) { process ->
            ListRow(
                processName(process),
                listOfNotNull(
                    process.pid?.let { "PID $it" },
                    stringResource(R.string.perf_cpu) + " " + percent(process.cpuPercent),
                    bytes(process.rssBytes),
                    process.uptimeSeconds?.let { DateUtils.formatElapsedTime(it.toLong()) },
                ).joinToString(" · "),
                trailing = { StatusBadge(process.state, if (process.state == "running") Tone.SUCCESS else if (process.state == "error") Tone.DANGER else null) },
            )
        }
        item { Section(stringResource(R.string.perf_profiles)) }
        items(live.profiles, key = { it.profile }) { profile ->
            ListRow(profile.profile, stringResource(R.string.perf_profile_counts, profile.activeRuns, profile.sessions, profile.sockets))
        }
    }
}

@Composable
private fun Section(title: String) {
    Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun processName(process: HermesProcess): String = when (process.kind) {
    HermesProcess.Kind.TUI_GATEWAY -> stringResource(R.string.perf_kind_tui)
    HermesProcess.Kind.DASHBOARD -> stringResource(R.string.perf_kind_dashboard)
    HermesProcess.Kind.GATEWAY -> stringResource(R.string.perf_kind_gateway, process.profile ?: "default")
}

private fun decimal(value: BigDecimal): String = value.setScale(1, RoundingMode.HALF_UP).toPlainString()

/** A share the hub measured, or a dash when it could not: never a zero it did not see. */
private fun percent(value: BigDecimal?): String = value?.let { "${decimal(it)}%" } ?: "—"

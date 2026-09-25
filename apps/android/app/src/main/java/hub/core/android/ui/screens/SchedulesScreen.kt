package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import hub.core.android.AppGraph
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.realtime.SCHEDULES_NAMESPACE
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.ListRow
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.Loading
import hub.core.android.ui.components.ProfileBadge
import hub.core.android.ui.components.StatusBadge
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.api.SchedulesApi
import hub.core.client.model.JobStatus
import hub.core.client.model.Schedule
import hub.core.client.model.ScheduleWrite
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SchedulesUi(
    val items: List<Schedule> = emptyList(),
    val loading: Boolean = true,
    val error: HubError? = null,
    val notice: Int? = null,
)

/** Schedules across every profile the person may enter, with no profile filter (ADR 0016). */
class SchedulesViewModel(private val graph: AppGraph) : ViewModel() {
    private val _ui = MutableStateFlow(SchedulesUi())
    val ui: StateFlow<SchedulesUi> = _ui.asStateFlow()
    private var pending: Job? = null

    init {
        graph.realtime.subscribeAll(SCHEDULES_NAMESPACE)
        reload()
        viewModelScope.launch {
            graph.realtime.events.collect { e ->
                if (e.namespace == SCHEDULES_NAMESPACE && (e.event.startsWith("schedule") || e.event.startsWith("schedule_run"))) {
                    pending?.cancel()
                    pending = launch { delay(300); reload() }
                }
            }
        }
    }

    fun reload() {
        val s = graph.store.current ?: return
        viewModelScope.launch {
            hubCall { graph.apis(s).schedules.schedulesList(profiles = SchedulesApi.ProfilesSchedulesList.ALL, limit = 200) }
                .onSuccess { page -> _ui.update { it.copy(items = page.items, loading = false, error = null) } }
                .onFailure { e -> _ui.update { it.copy(loading = false, error = e as HubError) } }
        }
    }

    fun runNow(schedule: Schedule) {
        val s = graph.store.current ?: return
        viewModelScope.launch {
            hubCall { graph.apis(s).schedules.schedulesRunNow(schedule.profile, schedule.id) }
                .onSuccess { _ui.update { it.copy(notice = R.string.schedules_started) }; reload() }
                .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
        }
    }

    fun setEnabled(schedule: Schedule, enabled: Boolean) {
        val s = graph.store.current ?: return
        viewModelScope.launch {
            hubCall { graph.apis(s).schedules.schedulesUpdate(schedule.profile, schedule.id, ScheduleWrite(enabled = enabled)) }
                .onSuccess { reload() }
                .onFailure { e -> _ui.update { it.copy(error = e as HubError) } }
        }
    }
}

private val whenFormat: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)

/** A time in the phone's own zone and format. */
fun localTime(time: OffsetDateTime): String =
    time.atZoneSameInstant(java.time.ZoneId.systemDefault()).format(whenFormat.withLocale(java.util.Locale.getDefault()))

@Composable
fun jobLabel(status: JobStatus): String = stringResource(
    when (status) {
        JobStatus.QUEUED -> R.string.job_queued
        JobStatus.RUNNING -> R.string.job_running
        JobStatus.SUCCEEDED -> R.string.job_succeeded
        JobStatus.FAILED -> R.string.job_failed
        JobStatus.CANCELLED -> R.string.job_cancelled
    },
)

@Composable
private fun StateBadge(schedule: Schedule) {
    val (label, tone) = when (schedule.state) {
        Schedule.State.RUNNING -> R.string.schedule_running to Tone.SUCCESS
        Schedule.State.PAUSED -> R.string.schedule_paused to Tone.WARNING
        Schedule.State.EXHAUSTED -> R.string.schedule_finished to null
        else -> R.string.schedule_scheduled to Tone.INFO
    }
    StatusBadge(stringResource(label), tone)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SchedulesScreen(shell: ShellViewModel, onOpenChat: (String, String) -> Unit) {
    val context = LocalContext.current
    val vm: SchedulesViewModel = viewModel { SchedulesViewModel(context.graph) }
    val ui by vm.ui.collectAsState()
    var opened by remember { mutableStateOf<Schedule?>(null) }
    val badges = ui.items.map { it.profile }.distinct().size > 1
    Column(Modifier.fillMaxSize()) {
        ui.error?.let { ErrorNotice(it, Modifier.padding(12.dp)) }
        ui.notice?.let { Text(stringResource(it), color = LocalTokens.current.textMuted, modifier = Modifier.padding(12.dp)) }
        if (ui.loading) {
            Loading()
            return@Column
        }
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ui.items.isEmpty()) item { Text(stringResource(R.string.schedules_empty), color = LocalTokens.current.textMuted) }
            items(ui.items, key = { it.id }) { schedule ->
                ListRow(
                    title = schedule.name,
                    subtitle = listOfNotNull(
                        schedule.trigger.display ?: schedule.trigger.expression,
                        schedule.nextRunAt?.let { stringResource(R.string.schedules_next, localTime(it)) },
                        schedule.lastError,
                    ).joinToString(" · "),
                    trailing = {
                        Column(horizontalAlignment = androidx.compose.ui.Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            StateBadge(schedule)
                            if (badges) ProfileBadge(shell.profileName(schedule.profile))
                        }
                    },
                    onClick = { opened = schedule },
                )
            }
        }
    }
    opened?.let { schedule ->
        ModalBottomSheet(onDismissRequest = { opened = null }) {
            ScheduleSheet(schedule, vm, onOpenChat = { id -> opened = null; onOpenChat(id, schedule.profile) }, onDone = { opened = null })
        }
    }
}

@Composable
private fun ScheduleSheet(schedule: Schedule, vm: SchedulesViewModel, onOpenChat: (String) -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val history = rememberLoad(schedule.id) {
        val s = context.graph.store.current!!
        context.graph.apis(s).schedules.schedulesListRuns(schedule.profile, schedule.id, limit = 10).items
    }
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(schedule.name, style = MaterialTheme.typography.titleMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StateBadge(schedule)
            (schedule.trigger.display ?: schedule.trigger.expression)?.let { StatusBadge(it) }
        }
        schedule.target.prompt?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = t.textMuted, maxLines = 4) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.runNow(schedule); onDone() }) { Text(stringResource(R.string.schedules_run_now)) }
            OutlinedButton(onClick = { vm.setEnabled(schedule, !schedule.enabled); onDone() }) {
                Text(stringResource(if (schedule.enabled) R.string.schedules_pause else R.string.schedules_resume))
            }
        }
        Text(stringResource(R.string.schedules_history), style = MaterialTheme.typography.titleSmall)
        LoadView(history) { runs ->
            if (runs.isEmpty()) Text(stringResource(R.string.schedules_no_runs), color = t.textMuted)
            runs.forEach { run ->
                ListRow(
                    title = run.startedAt?.let(::localTime) ?: "—",
                    subtitle = run.error ?: run.outputPreview,
                    trailing = {
                        StatusBadge(
                            jobLabel(run.status),
                            when (run.status) {
                                JobStatus.SUCCEEDED -> Tone.SUCCESS
                                JobStatus.FAILED -> Tone.DANGER
                                JobStatus.RUNNING -> Tone.INFO
                                else -> null
                            },
                        )
                    },
                    onClick = run.sessionId?.let { id -> { onOpenChat(id) } },
                )
            }
        }
        TextButton(onClick = onDone) { Text(stringResource(R.string.close)) }
    }
}

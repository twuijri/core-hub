package hub.core.android.ui.screens

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.InContentDirection
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
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
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.Loading
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

/**
 * Schedules, as a card per schedule: its name and profile, when it runs (and next), its state as
 * a tinted badge, a last error in red. A tap opens its sheet: run now as the one primary action,
 * pause or resume beside it, and the history.
 */
@Composable
fun SchedulesScreen(shell: ShellViewModel, onOpenChat: (String, String) -> Unit) {
    // Schedules and workflows share the page, as on the web: one segmented switch above them.
    var half by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(SchedulesHalf.SCHEDULES) }
    Column(Modifier.fillMaxSize()) {
        hub.core.android.ui.kit.Segmented(
            listOf(
                hub.core.android.ui.kit.Segment(SchedulesHalf.SCHEDULES, stringResource(R.string.schedules_tab_jobs), Lucide.CalendarClock, "schedules.tab.jobs"),
                hub.core.android.ui.kit.Segment(SchedulesHalf.WORKFLOWS, stringResource(R.string.schedules_tab_workflows), Lucide.Workflow, "schedules.tab.workflows"),
            ),
            half, { half = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        )
        when (half) {
            SchedulesHalf.SCHEDULES -> SchedulesList(shell, onOpenChat)
            SchedulesHalf.WORKFLOWS -> WorkflowsList(shell, onOpenChat)
        }
    }
}

enum class SchedulesHalf { SCHEDULES, WORKFLOWS }

@Composable
private fun SchedulesList(shell: ShellViewModel, onOpenChat: (String, String) -> Unit) {
    val context = LocalContext.current
    val vm: SchedulesViewModel = viewModel { SchedulesViewModel(context.graph) }
    val ui by vm.ui.collectAsState()
    val t = LocalTokens.current
    var opened by remember { mutableStateOf<Schedule?>(null) }
    val badges = ui.items.map { it.profile }.distinct().size > 1
    Column(Modifier.fillMaxSize()) {
        ui.error?.let { ErrorNotice(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        ui.notice?.let { NoticeBox(stringResource(it), BadgeTone.Success, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        if (ui.loading) {
            Loading()
            return@Column
        }
        LazyColumn(
            Modifier.fillMaxSize().testTag("schedules.list"),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (ui.items.isEmpty()) item { EmptyState(stringResource(R.string.schedules_empty), icon = Lucide.CalendarClock) }
            items(ui.items, key = { it.id }) { schedule ->
                HubCard(Modifier.testTag("schedule.card.${schedule.id}"), onClick = { opened = schedule }, padding = 14.dp) {
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        InContentDirection(schedule.name) {
                            Text(schedule.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        if (badges) Badge(shell.profileName(schedule.profile), tone = BadgeTone.Accent)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StateBadge(schedule)
                        LucideIcon(Lucide.Clock, null, size = 13.dp, tint = t.textMuted)
                        Text(
                            listOfNotNull(
                                schedule.trigger.display ?: schedule.trigger.expression,
                                schedule.nextRunAt?.let { stringResource(R.string.schedules_next, localTime(it)) },
                            ).joinToString(" · "),
                            fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    schedule.lastError?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = t.danger, maxLines = 2) }
                }
            }
        }
    }
    opened?.let { schedule ->
        HubSheet(onDismiss = { opened = null }) {
            ScheduleSheet(schedule, vm, onOpenChat = { id -> opened = null; onOpenChat(id, schedule.profile) }, onDone = { opened = null })
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScheduleSheet(schedule: Schedule, vm: SchedulesViewModel, onOpenChat: (String) -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    val history = rememberLoad(schedule.id) {
        val s = context.graph.store.current!!
        context.graph.apis(s).schedules.schedulesListRuns(schedule.profile, schedule.id, limit = 10).items
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("schedule.sheet"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(schedule.name, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            StateBadge(schedule)
            (schedule.trigger.display ?: schedule.trigger.expression)?.let { Badge(it) }
        }
        schedule.target.prompt?.let { p -> InContentDirection(p) { Text(p, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, maxLines = 4) } }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HubButton(stringResource(R.string.schedules_run_now), { vm.runNow(schedule); onDone() }, size = ControlSize.Md, icon = Lucide.Play)
            HubButton(
                stringResource(if (schedule.enabled) R.string.schedules_pause else R.string.schedules_resume),
                { vm.setEnabled(schedule, !schedule.enabled); onDone() },
                kind = ButtonKind.Secondary, size = ControlSize.Md, icon = if (schedule.enabled) Lucide.Pause else Lucide.Play,
            )
        }
        SectionTitle(stringResource(R.string.schedules_history))
        LoadView(history) { runs ->
            if (runs.isEmpty()) Text(stringResource(R.string.schedules_no_runs), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            else GroupedList {
                runs.forEach { run ->
                    Item(
                        run.startedAt?.let(::localTime) ?: "—",
                        subtitle = run.error ?: run.outputPreview,
                        chevron = run.sessionId != null,
                        onClick = run.sessionId?.let { id -> { onOpenChat(id) } },
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
                    )
                }
            }
        }
    }
}

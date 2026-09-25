package hub.core.android.tools

import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.client.api.AuditApi
import hub.core.client.model.LivePerformance
import hub.core.client.model.LogLine
import hub.core.client.model.LogLinesPage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Settings → Logs and Performance on the phone (contract decision §51): the same live endpoints
 * the web reads — `audit.listLogLines` and `audit.getLivePerformance` — owners and admins only.
 * The rules live here, apart from the screens, so they are unit-tested.
 */

/** Which lines: every source, the hub's own, Hermes's, or every source's errors. */
enum class LogSource(val api: AuditApi.SourceAuditListLogLines) {
    ALL(AuditApi.SourceAuditListLogLines.ALL),
    HUB(AuditApi.SourceAuditListLogLines.HUB),
    HERMES(AuditApi.SourceAuditListLogLines.HERMES),
    ERRORS(AuditApi.SourceAuditListLogLines.ERRORS),
}

/** The least severe level shown. */
enum class LogLevel(val api: AuditApi.LevelAuditListLogLines) {
    DEBUG(AuditApi.LevelAuditListLogLines.DEBUG),
    INFO(AuditApi.LevelAuditListLogLines.INFO),
    WARN(AuditApi.LevelAuditListLogLines.WARN),
    ERROR(AuditApi.LevelAuditListLogLines.ERROR),
}

data class LogsState(
    val source: LogSource = LogSource.ALL,
    val level: LogLevel = LogLevel.DEBUG,
    val lines: List<LogLine> = emptyList(),
    /** The newest `seq` the hub held at the last answer: a refresh asks only for what is newer. */
    val lastSeq: Int = 0,
    val capacity: Int = 0,
    val loading: Boolean = true,
    val error: HubError? = null,
)

/** One `audit.listLogLines` call. `level` is null for «errors», which is already one level. */
data class LogQuery(val source: LogSource, val level: LogLevel?, val limit: Int, val after: Int?)

object Logs {
    /** A phone shows the newest 200 lines; the web offers more. */
    const val LIMIT = 200

    fun query(state: LogsState, after: Int? = null) = LogQuery(
        source = state.source,
        level = if (state.source == LogSource.ERRORS) null else state.level,
        limit = LIMIT,
        after = after,
    )

    /** Newer lines go under the shown ones; only the newest [limit] stay. */
    fun append(shown: List<LogLine>, newer: List<LogLine>, limit: Int = LIMIT): List<LogLine> {
        val known = shown.mapTo(HashSet()) { it.seq }
        return (shown + newer.filter { it.seq !in known }).takeLast(limit)
    }
}

/** The Logs screen's state and its three verbs: load, refresh (newer lines only), filter. */
class LogsModel(private val audit: () -> AuditApi) {
    private val _state = MutableStateFlow(LogsState())
    val state: StateFlow<LogsState> = _state.asStateFlow()

    private suspend fun fetch(query: LogQuery): Result<LogLinesPage> = hubCall {
        audit().auditListLogLines(
            source = query.source.api,
            level = query.level?.api,
            limit = query.limit,
            after = query.after,
        )
    }

    /** The newest lines for the filters as they are now. */
    suspend fun load() {
        _state.update { it.copy(loading = true) }
        val asked = _state.value
        fetch(Logs.query(asked))
            .onSuccess { page ->
                // A filter changed while this was on its way: its own load answers it.
                if (_state.value.source != asked.source || _state.value.level != asked.level) return
                _state.update {
                    it.copy(lines = page.lines, lastSeq = page.lastSeq, capacity = page.capacity, loading = false, error = null)
                }
            }
            .onFailure { failure -> _state.update { it.copy(loading = false, error = failure as HubError) } }
    }

    /** Only what the hub wrote since the last answer, under what is shown. */
    suspend fun refresh() {
        val asked = _state.value
        if (asked.loading && asked.lines.isEmpty()) return load()
        fetch(Logs.query(asked, after = asked.lastSeq))
            .onSuccess { page ->
                if (_state.value.source != asked.source || _state.value.level != asked.level) return
                _state.update {
                    it.copy(lines = Logs.append(it.lines, page.lines), lastSeq = page.lastSeq, capacity = page.capacity, error = null)
                }
            }
            .onFailure { failure -> _state.update { it.copy(error = failure as HubError) } }
    }

    suspend fun setSource(source: LogSource) {
        if (source == _state.value.source) return
        _state.update { it.copy(source = source, lines = emptyList(), lastSeq = 0) }
        load()
    }

    suspend fun setLevel(level: LogLevel) {
        if (level == _state.value.level) return
        _state.update { it.copy(level = level, lines = emptyList(), lastSeq = 0) }
        load()
    }
}

data class PerformanceState(
    val live: LivePerformance? = null,
    val loading: Boolean = true,
    val error: HubError? = null,
)

/** The Performance screen: one measurement, asked for again every `interval_seconds` while shown. */
class PerformanceModel(private val audit: () -> AuditApi) {
    private val _state = MutableStateFlow(PerformanceState())
    val state: StateFlow<PerformanceState> = _state.asStateFlow()

    /** How long to wait before asking again: what the hub said, five seconds before it said anything. */
    val intervalMs: Long get() = (_state.value.live?.intervalSeconds ?: DEFAULT_INTERVAL_SECONDS).coerceAtLeast(1) * 1000L

    suspend fun refresh() {
        hubCall { audit().auditGetLivePerformance() }
            .onSuccess { live -> _state.update { PerformanceState(live = live, loading = false, error = null) } }
            // A failed look keeps the last measurement on screen, with the reason above it.
            .onFailure { failure -> _state.update { it.copy(loading = false, error = failure as HubError) } }
    }

    companion object {
        const val DEFAULT_INTERVAL_SECONDS = 5
    }
}

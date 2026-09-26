// Settings → Logs and Performance (contract decision §51): the live endpoints the web reads —
// `audit.listLogLines` and `audit.getLivePerformance` — owners and admins only (navigation.json).
// The rules and the two models are kept apart from the views, so CoreHubTests runs them against a
// fake hub.
import CoreHubClient
import Foundation
import Observation
import SwiftUI

/// Which lines: every source, the hub's own, Hermes's, or every source's errors.
enum LogSource: String, CaseIterable, Identifiable {
    case all, hub, hermes, errors

    var id: String { rawValue }
    var labelKey: String { "logs.source_\(rawValue)" }
    var api: AuditAPI.Source_auditListLogLines {
        switch self {
        case .all: return .all
        case .hub: return .hub
        case .hermes: return .hermes
        case .errors: return .errors
        }
    }
}

/// The least severe level shown.
enum LogLevel: String, CaseIterable, Identifiable {
    case debug, info, warn, error

    var id: String { rawValue }
    var labelKey: String { "logs.level_\(rawValue)" }
    var api: AuditAPI.Level_auditListLogLines {
        switch self {
        case .debug: return .debug
        case .info: return .info
        case .warn: return .warn
        case .error: return .error
        }
    }
}

/// One `audit.listLogLines` call. `level` is nil for «errors only», which is one level already.
struct LogQuery: Equatable {
    let source: LogSource
    let level: LogLevel?
    let limit: Int
    let after: Int?
}

enum LogsRules {
    /// A phone shows the newest 200 lines; the web offers more.
    static let limit = 200

    static func query(source: LogSource, level: LogLevel, after: Int? = nil) -> LogQuery {
        LogQuery(source: source, level: source == .errors ? nil : level, limit: limit, after: after)
    }

    /// Newer lines go under the shown ones, each once; only the newest `limit` stay.
    static func append(_ shown: [LogLine], _ newer: [LogLine], limit: Int = limit) -> [LogLine] {
        let known = Set(shown.map(\.seq))
        return Array((shown + newer.filter { !known.contains($0.seq) }).suffix(limit))
    }
}

/// What the two screens ask of the hub.
protocol LiveToolsBackend {
    func logLines(_ query: LogQuery) async throws -> LogLinesPage
    func livePerformance() async throws -> LivePerformance
}

/// The hub itself, through the generated client.
struct LiveToolsAPI: LiveToolsBackend {
    let api: HubAPI

    func logLines(_ query: LogQuery) async throws -> LogLinesPage {
        try await api.call {
            try await AuditAPI.auditListLogLines(
                source: query.source.api, level: query.level?.api, limit: query.limit, after: query.after,
                apiConfiguration: $0
            )
        }
    }

    func livePerformance() async throws -> LivePerformance {
        try await api.call { try await AuditAPI.auditGetLivePerformance(apiConfiguration: $0) }
    }
}

@MainActor
@Observable
final class LogsModel {
    private(set) var source: LogSource = .all
    private(set) var level: LogLevel = .debug
    private(set) var lines: [LogLine] = []
    /// The newest `seq` the hub held at its last answer: a refresh asks only for what is newer.
    private(set) var lastSeq = 0
    private(set) var loading = true
    private(set) var error: HubFailure?

    @ObservationIgnored private let backend: LiveToolsBackend

    init(backend: LiveToolsBackend) {
        self.backend = backend
    }

    /// The newest lines for the filters as they are now.
    func load() async {
        loading = true
        let asked = (source, level)
        do {
            let page = try await backend.logLines(LogsRules.query(source: source, level: level))
            // A filter changed while this was on its way: its own load answers it.
            guard source == asked.0, level == asked.1 else { return }
            lines = page.lines
            lastSeq = page.lastSeq
            error = nil
        } catch is CancellationError {
            return
        } catch {
            guard source == asked.0, level == asked.1 else { return }
            self.error = HubFailure(error)
        }
        loading = false
    }

    /// Only what the hub wrote since its last answer, under what is shown.
    func refresh() async {
        if lines.isEmpty && lastSeq == 0 { return await load() }
        let asked = (source, level)
        do {
            let page = try await backend.logLines(LogsRules.query(source: source, level: level, after: lastSeq))
            guard source == asked.0, level == asked.1 else { return }
            lines = LogsRules.append(lines, page.lines)
            lastSeq = page.lastSeq
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = HubFailure(error)
        }
    }

    func setSource(_ next: LogSource) async {
        guard next != source else { return }
        source = next
        lines = []
        lastSeq = 0
        await load()
    }

    func setLevel(_ next: LogLevel) async {
        guard next != level else { return }
        level = next
        lines = []
        lastSeq = 0
        await load()
    }
}

@MainActor
@Observable
final class PerformanceModel {
    static let defaultIntervalSeconds = 5

    private(set) var live: LivePerformance?
    private(set) var loading = true
    private(set) var error: HubFailure?

    @ObservationIgnored private let backend: LiveToolsBackend

    init(backend: LiveToolsBackend) {
        self.backend = backend
    }

    /// How long to wait before asking again: what the hub said, five seconds before it said anything.
    var intervalSeconds: Int { max(1, live?.intervalSeconds ?? Self.defaultIntervalSeconds) }

    func refresh() async {
        do {
            live = try await backend.livePerformance()
            error = nil
        } catch is CancellationError {
            return
        } catch {
            // A failed look keeps the last measurement on screen, with the reason above it.
            self.error = HubFailure(error)
        }
        loading = false
    }
}

/// Numbers as the screens show them. A number the hub could not measure is a dash, never zero.
enum ToolsFormat {
    static func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.1f%%", value)
    }

    static func decimal(_ value: Double) -> String {
        String(format: "%.1f", value)
    }

    static func bytes(_ value: Int?) -> String {
        guard let value else { return "—" }
        return ByteCount.text(Int64(value), style: .memory)
    }

    static func duration(_ seconds: Int?, language: AppLanguage) -> String {
        guard let seconds else { return "—" }
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.allowedUnits = seconds >= 86_400 ? [.day, .hour] : seconds >= 3_600 ? [.hour, .minute] : [.minute, .second]
        var calendar = Calendar.current
        calendar.locale = language.locale
        formatter.calendar = calendar
        return formatter.string(from: TimeInterval(seconds)) ?? "—"
    }
}

// MARK: - Logs

struct LogsPage: View {
    @Environment(AppModel.self) private var app
    @State private var model: LogsModel?

    var body: some View {
        Group {
            if let model {
                LogsList(model: model)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            guard model == nil else { return }
            let made = LogsModel(backend: LiveToolsAPI(api: app.api))
            model = made
            await made.load()
        }
    }
}

private struct LogsList: View {
    let model: LogsModel
    @Environment(\.l10n) private var l10n

    var body: some View {
        List {
            Section {
                Picker(l10n("logs.source"), selection: Binding(
                    get: { model.source },
                    set: { next in Task { await model.setSource(next) } }
                )) {
                    ForEach(LogSource.allCases) { Text(l10n($0.labelKey)).tag($0) }
                }
                .pickerStyle(.segmented)
                if model.source != .errors {
                    Picker(l10n("logs.level"), selection: Binding(
                        get: { model.level },
                        set: { next in Task { await model.setLevel(next) } }
                    )) {
                        ForEach(LogLevel.allCases) { Text(l10n($0.labelKey)).tag($0) }
                    }
                }
                Text(l10n("logs.kept")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
            }
            if let error = model.error {
                NoticeView(text: error.describe(l10n), tone: .danger)
            }
            if model.loading && model.lines.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if model.lines.isEmpty {
                Text(l10n("logs.empty")).foregroundStyle(Tone.textMuted)
            } else {
                Section {
                    ForEach(model.lines, id: \.seq) { line in LogRow(line: line) }
                }
            }
        }
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Label { Text(l10n("tools.refresh")) } icon: { Image(lucide: .rotateCw) }
                }
                .accessibilityIdentifier("logs.refresh")
            }
        }
    }
}

private struct LogRow: View {
    let line: LogLine
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Space.s2) {
                StatusPill(text: l10n("logs.short_\(line.level.rawValue)"), kind: kind)
                Text(whereFrom).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                Spacer(minLength: Space.s2)
                Text(line.at.shortText(app.language)).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
            }
            // A log line is the program's own words: shown as written, in its own direction.
            Text(line.message)
                .font(.system(size: FontSize.sizeXs, design: .monospaced))
                .textSelection(.enabled)
                .contentDirection(of: line.message)
        }
    }

    private var kind: StatusPill.Kind {
        switch line.level {
        case .error: return .bad
        case .warn: return .warn
        case .info: return .good
        case .debug: return .neutral
        }
    }

    private var whereFrom: String {
        if line.source == .hub { return l10n("logs.from_hub") }
        if line.profile == "tui" { return l10n("logs.from_tui") }
        return l10n("logs.from_hermes", ["profile": line.profile ?? "default"])
    }
}

// MARK: - Performance

struct PerformancePage: View {
    @Environment(AppModel.self) private var app
    @State private var model: PerformanceModel?

    var body: some View {
        Group {
            if let model, model.live != nil || model.error != nil {
                PerformanceList(model: model)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Measured when asked: every `interval_seconds` while this page is on screen, never behind it.
        .task {
            let current = model ?? PerformanceModel(backend: LiveToolsAPI(api: app.api))
            model = current
            while !Task.isCancelled {
                await current.refresh()
                try? await Task.sleep(nanoseconds: UInt64(current.intervalSeconds) * 1_000_000_000)
            }
        }
    }
}

private struct PerformanceList: View {
    let model: PerformanceModel
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        List {
            if let error = model.error {
                NoticeView(text: error.describe(l10n), tone: .danger)
            }
            if let live = model.live {
                Section {
                    Text(l10n("perf.every", ["count": String(live.intervalSeconds), "time": live.at.shortText(app.language)]))
                        .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
                Section(l10n("perf.host")) {
                    FactRow(label: l10n("perf.cpu"), value: l10n("perf.cores", [
                        "value": ToolsFormat.percent(live.host.cpuPercent), "count": String(live.host.cpuCount),
                    ]))
                    FactRow(label: l10n("perf.memory"), value: l10n("perf.of", [
                        "used": ToolsFormat.bytes(live.host.memoryUsedBytes), "total": ToolsFormat.bytes(live.host.memoryTotalBytes),
                    ]))
                    FactRow(label: l10n("perf.load"), value: live.host.load.map { $0.map(ToolsFormat.decimal).joined(separator: " · ") } ?? "—")
                    if live.host.measuredFrom == .os {
                        Text(l10n("perf.no_proc")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                    }
                }
                Section(l10n("perf.hub")) {
                    FactRow(label: l10n("perf.cpu"), value: ToolsFormat.percent(live.hub.cpuPercent))
                    FactRow(label: l10n("perf.rss"), value: l10n("perf.heap", [
                        "rss": ToolsFormat.bytes(live.hub.rssBytes), "heap": ToolsFormat.bytes(live.hub.heapUsedBytes),
                    ]))
                    FactRow(label: l10n("perf.lag"), value: live.hub.eventLoopLagMs.map { l10n("perf.ms", ["count": ToolsFormat.decimal($0)]) } ?? "—")
                    FactRow(label: l10n("perf.uptime"), value: "\(ToolsFormat.duration(live.hub.uptimeSeconds, language: app.language)) · Node \(live.hub.nodeVersion)")
                }
                Section(l10n("perf.hermes")) {
                    if live.processes.isEmpty {
                        Text(l10n("perf.no_hermes")).foregroundStyle(Tone.textMuted)
                    }
                    ForEach(Array(live.processes.enumerated()), id: \.offset) { _, process in
                        ProcessRow(process: process)
                    }
                }
                Section(l10n("perf.profiles")) {
                    ForEach(live.profiles, id: \.profile) { profile in
                        FactRow(label: profile.profile, value: l10n("perf.profile_counts", [
                            "runs": String(profile.activeRuns), "sessions": String(profile.sessions), "sockets": String(profile.sockets),
                        ]))
                    }
                }
            }
        }
        .refreshable { await model.refresh() }
    }
}

private struct ProcessRow: View {
    let process: HermesProcess
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(name).font(.system(size: FontSize.sizeSm, weight: .medium))
                Spacer()
                StatusPill(text: process.state, kind: process.state == "running" ? .good : process.state == "error" ? .bad : .neutral)
            }
            Text(details).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
        }
    }

    private var name: String {
        switch process.kind {
        case .tuiGateway: return l10n("perf.kind_tui")
        case .dashboard: return l10n("perf.kind_dashboard")
        case .gateway: return l10n("perf.kind_gateway", ["profile": process.profile ?? "default"])
        }
    }

    private var details: String {
        [
            process.pid.map { "PID \($0)" },
            "\(l10n("perf.cpu")) \(ToolsFormat.percent(process.cpuPercent))",
            ToolsFormat.bytes(process.rssBytes),
            process.uptimeSeconds.map { ToolsFormat.duration($0, language: app.language) },
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }
}

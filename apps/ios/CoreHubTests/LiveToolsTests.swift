@testable import CoreHub
import CoreHubClient
import Foundation
import XCTest

/// A hub that answers Logs and Performance from a script and records what it was asked.
private final class FakeToolsBackend: LiveToolsBackend {
    var pages: [LogLinesPage] = []
    var logFailure: HubFailure?
    var performance: [Result<LivePerformance, HubFailure>] = []
    private(set) var queries: [LogQuery] = []

    func logLines(_ query: LogQuery) async throws -> LogLinesPage {
        queries.append(query)
        if let logFailure { throw logFailure }
        return pages.isEmpty ? LogLinesPage(lines: [], lastSeq: 0, capacity: 5000, sources: []) : pages.removeFirst()
    }

    func livePerformance() async throws -> LivePerformance {
        try performance.removeFirst().get()
    }
}

private func line(_ seq: Int, _ level: LogLine.Level = .info, _ message: String = "m", source: LogLine.Source = .hub, profile: String? = nil) -> LogLine {
    LogLine(seq: seq, at: Date(timeIntervalSince1970: 1_790_000_000 + Double(seq)), level: level, source: source, profile: profile, message: message)
}

private func page(_ lines: [LogLine], last: Int) -> LogLinesPage {
    LogLinesPage(lines: lines, lastSeq: last, capacity: 5000, sources: [LogLinesPageSourcesInner(source: .hub, lines: lines.count)])
}

private func refusal(_ status: Int, _ code: String) -> HubFailure {
    HubFailure(kind: .http, status: status, code: code, message: nil, operationID: nil, requestID: nil, detail: "")
}

private func measurement(interval: Int = 3) -> LivePerformance {
    LivePerformance(
        at: Date(timeIntervalSince1970: 1_790_000_005),
        intervalSeconds: interval,
        host: LivePerformanceHost(platform: "linux", measuredFrom: .proc, cpuCount: 8, cpuPercent: 12.5,
                                  memoryTotalBytes: 16_777_216_000, memoryUsedBytes: 6_442_450_944, load: [0.42, 0.51, 0.6]),
        hub: LivePerformanceHub(pid: 1, cpuPercent: 1.8, rssBytes: 184_549_376, heapUsedBytes: 71_303_168,
                                eventLoopLagMs: 1.2, uptimeSeconds: 86_400, nodeVersion: "v24.8.0"),
        processes: [
            HermesProcess(kind: .tuiGateway, pid: 58, state: "running", cpuPercent: 0.4, rssBytes: 227_540_992, uptimeSeconds: 3600),
            HermesProcess(kind: .gateway, profile: "work", state: "starting"),
        ],
        profiles: [LivePerformanceProfilesInner(profile: "work", activeRuns: 1, sessions: 42, sockets: 2)],
        history: []
    )
}

@MainActor
final class LiveToolsTests: XCTestCase {
    func testErrorsOnlyCarriesNoLevelAndEveryOtherSourceDoes() {
        let errors = LogsRules.query(source: .errors, level: .warn)
        XCTAssertNil(errors.level)
        XCTAssertEqual(errors.limit, LogsRules.limit)
        XCTAssertEqual(LogsRules.query(source: .hermes, level: .warn).level, .warn)
        XCTAssertEqual(LogsRules.query(source: .all, level: .debug, after: 7).after, 7)
        XCTAssertEqual(LogSource.errors.api, .errors)
        XCTAssertEqual(LogLevel.warn.api, .warn)
    }

    func testNewerLinesGoUnderTheShownOnesOnceEachAndOnlyTheNewestStay() {
        let shown = [line(1), line(2), line(3)]
        XCTAssertEqual(LogsRules.append(shown, [line(3), line(4)]).map(\.seq), [1, 2, 3, 4])
        XCTAssertEqual(LogsRules.append(shown, [line(4), line(5)], limit: 3).map(\.seq), [3, 4, 5])
    }

    func testLoadsTheNewestLinesThenRefreshAsksOnlyForNewerOnes() async {
        let hub = FakeToolsBackend()
        hub.pages = [page([line(1, .info, "hub started")], last: 1),
                     page([line(2, .error, "gateway exited", source: .hermes, profile: "work")], last: 2)]
        let model = LogsModel(backend: hub)
        await model.load()
        XCTAssertEqual(hub.queries.first, LogQuery(source: .all, level: .debug, limit: 200, after: nil))
        XCTAssertEqual(model.lines.map(\.message), ["hub started"])
        XCTAssertFalse(model.loading)

        await model.refresh()
        XCTAssertEqual(hub.queries.last?.after, 1)
        XCTAssertEqual(model.lines.map(\.seq), [1, 2])
        XCTAssertEqual(model.lastSeq, 2)
        XCTAssertEqual(model.lines.last?.profile, "work")
    }

    func testANewFilterIsANewPageAndErrorsOnlySendsNoLevel() async {
        let hub = FakeToolsBackend()
        hub.pages = [page([line(1)], last: 1), page([line(4, .warn)], last: 4), page([line(9, .error, "boom")], last: 9)]
        let model = LogsModel(backend: hub)
        await model.load()
        await model.setLevel(.warn)
        XCTAssertEqual(hub.queries.last, LogQuery(source: .all, level: .warn, limit: 200, after: nil))
        XCTAssertEqual(model.lines.map(\.seq), [4])

        await model.setSource(.errors)
        XCTAssertEqual(hub.queries.last, LogQuery(source: .errors, level: nil, limit: 200, after: nil))
        XCTAssertEqual(model.lines.map(\.seq), [9])
    }

    func testAMemberIsToldWhyInsteadOfShownNothing() async {
        let hub = FakeToolsBackend()
        hub.logFailure = refusal(403, "forbidden")
        let model = LogsModel(backend: hub)
        await model.load()
        XCTAssertEqual(model.error?.status, 403)
        XCTAssertEqual(model.error?.code, "forbidden")
        XCTAssertTrue(model.lines.isEmpty)
        XCTAssertFalse(model.loading)
    }

    func testPerformanceKeepsTheLastMeasurementWhenALookFailsAndTheHubSetsThePace() async {
        let hub = FakeToolsBackend()
        hub.performance = [.success(measurement(interval: 3)), .failure(refusal(503, "unavailable"))]
        let model = PerformanceModel(backend: hub)
        XCTAssertEqual(model.intervalSeconds, PerformanceModel.defaultIntervalSeconds)
        await model.refresh()
        XCTAssertEqual(model.live?.host.cpuCount, 8)
        XCTAssertEqual(model.live?.processes.count, 2)
        XCTAssertNil(model.live?.processes[1].rssBytes, "a process the host could not measure has no numbers")
        XCTAssertEqual(model.intervalSeconds, 3)

        await model.refresh()
        XCTAssertEqual(model.error?.status, 503)
        XCTAssertNotNil(model.live)
        XCTAssertFalse(model.loading)
    }

    func testAMissingNumberIsADashNeverZero() {
        XCTAssertEqual(ToolsFormat.percent(nil), "—")
        XCTAssertEqual(ToolsFormat.bytes(nil), "—")
        XCTAssertEqual(ToolsFormat.duration(nil, language: .en), "—")
        XCTAssertEqual(ToolsFormat.percent(12.5), "12.5%")
        XCTAssertFalse(ToolsFormat.bytes(184_549_376).isEmpty)
    }

    func testLogsAndPerformanceSpeakBothLanguages() {
        let keys = ["tools.refresh", "logs.kept", "logs.source_errors", "logs.level_warn", "logs.short_error",
                    "logs.from_hermes", "perf.every", "perf.cores", "perf.heap", "perf.kind_gateway", "perf.profile_counts"]
        let host = Bundle(for: AppModel.self)
        for language in AppLanguage.allCases {
            let l10n = L10n(language, bundle: host)
            for key in keys {
                XCTAssertTrue(l10n.has(key), "\(key) is missing in \(language.rawValue)")
            }
        }
    }
}

@testable import CoreHub
import CoreHubClient
import Foundation
import XCTest

/// The phone's tool activity rule — the web's `toolActivity` with a window of two (owner, 2026-09-26).
final class ToolActivityTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_790_000_000)

    private func call(
        _ id: String,
        _ name: String? = nil,
        _ status: ToolCallStatus = .succeeded,
        duration: Int? = 120,
        from: Double? = nil,
        to: Double? = nil
    ) -> ToolCall {
        ToolCall(
            id: id, name: name ?? "tool_\(id)", status: status, outputTruncated: false, durationMs: duration,
            startedAt: from.map { base.addingTimeInterval($0) }, finishedAt: to.map { base.addingTimeInterval($0) }
        )
    }

    private var six: [ToolCall] { ["a", "b", "c", "d", "e", "f"].map { call($0) } }

    func testLiveShowsTheLastTwoAndCountsTheRest() {
        let activity = ToolActivity.of(six, live: true)
        XCTAssertEqual(ToolActivity.window, 2)
        XCTAssertFalse(activity.folded)
        XCTAssertEqual(activity.visible.map(\.id), ["e", "f"])
        XCTAssertEqual(activity.hidden, 4)
    }

    func testAFailedOrRunningCallStaysInViewUntilTheTurnEnds() {
        var calls = six
        calls[0].status = .failed
        calls[1].status = .running
        let activity = ToolActivity.of(calls, live: true)
        XCTAssertEqual(activity.visible.map(\.id), ["a", "b", "e", "f"])
        XCTAssertEqual(activity.hidden, 2)
    }

    func testACallWaitingForApprovalKeepsTheTurnLive() {
        XCTAssertFalse(ToolActivity.of([call("a", nil, .awaitingApproval)], live: false).folded)
    }

    func testAFinishedTurnFoldsIntoOneSummary() {
        let calls = [
            call("1", "skill_view", from: 0, to: 5),
            call("2", "vision_analyze", .failed, from: 5, to: 40),
            call("3", "terminal", from: 40, to: 60),
            call("4", "vision_analyze", from: 60, to: 65),
        ]
        let activity = ToolActivity.of(calls, live: false)
        XCTAssertTrue(activity.folded)
        XCTAssertTrue(activity.visible.isEmpty)
        XCTAssertEqual(activity.hidden, 4)
        XCTAssertEqual(activity.summary, ToolActivitySummary(count: 4, failed: 1, durationMs: 65_000, names: ["vision_analyze", "terminal"]))
        XCTAssertEqual(ToolActivity.durationParts(65_000).minutes, 1)
        XCTAssertEqual(ToolActivity.durationParts(65_000).seconds, 5)
    }

    func testWithoutTimesTheDurationsAreSummed() {
        XCTAssertEqual(ToolActivity.summarize([call("1"), call("2")]).durationMs, 240)
        XCTAssertNil(ToolActivity.summarize([call("1", duration: nil)]).durationMs)
        XCTAssertEqual(ToolActivity.durationParts(240).seconds, 1)
    }

    func testArabicCountsWithItsSixPluralForms() {
        XCTAssertEqual([0, 1, 2, 3, 10, 11, 99, 100, 103].map { PluralCategory.of($0, .ar) },
                       ["zero", "one", "two", "few", "few", "many", "many", "other", "few"])
        XCTAssertEqual([0, 1, 2, 5].map { PluralCategory.of($0, .en) }, ["other", "one", "other", "other"])
        XCTAssertEqual(L10n(.ar).plural("tool.activity.steps", 2), "خطوتان")
        XCTAssertEqual(L10n(.ar).plural("tool.activity.steps", 6), "6 خطوات")
        XCTAssertEqual(L10n(.en).plural("tool.activity.earlier", 1), "+1 earlier step")
    }
}

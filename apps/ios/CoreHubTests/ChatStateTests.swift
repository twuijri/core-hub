@testable import CoreHub
import CoreHubClient
import XCTest

final class ChatStateTests: XCTestCase {
    private func apply(_ state: inout ChatState, _ envelope: Envelope) {
        guard let event = SessionEvent.decode(envelope) else {
            return XCTFail("\(envelope.event) did not decode")
        }
        state.apply(event, seq: envelope.seq, profile: envelope.profile)
    }

    private func started() -> ChatState {
        var state = ChatState(sessionID: "s1")
        state.profile = "default"
        return state
    }

    func testDeltasStreamIntoTheMessageAndCompletionReplacesIt() {
        var state = started()
        apply(&state, Fixture.envelope("message.created", seq: 1, payload: ["message": Fixture.json(Fixture.message(id: "m1", seq: 1, role: .user, text: "hi", author: "Tariq"))]))
        apply(&state, Fixture.envelope("run.started", seq: 2, payload: ["run": Fixture.json(Fixture.run(status: .running))]))
        apply(&state, Fixture.envelope("message.created", seq: 3, payload: ["message": Fixture.json(Fixture.message(id: "m2", seq: 2, status: .streaming))]))
        XCTAssertTrue(state.messages[1].isEmpty, "an empty shell is not a turn yet")
        apply(&state, Fixture.envelope("message.delta", seq: 4, payload: ["session_id": "s1", "message_id": "m2", "run_id": "run1", "delta": "Hel"]))
        apply(&state, Fixture.envelope("message.delta", seq: 5, payload: ["session_id": "s1", "message_id": "m2", "run_id": "run1", "delta": "lo"]))
        XCTAssertEqual(state.messages.map(\.text), ["hi", "Hello"])
        XCTAssertTrue(state.isBusy)

        let final = Fixture.message(id: "m2", seq: 2, text: "Hello, world")
        apply(&state, Fixture.envelope("run.completed", seq: 6, payload: [
            "run": Fixture.json(Fixture.run(status: .succeeded)),
            "message": Fixture.json(final),
        ]))
        XCTAssertEqual(state.messages.last?.text, "Hello, world")
        XCTAssertEqual(state.messages.last?.status, .complete)
        XCTAssertFalse(state.isBusy)
        XCTAssertEqual(state.lastSeq, 6)
    }

    func testADeltaWithoutItsMessageMakesAShell() {
        var state = started()
        apply(&state, Fixture.envelope("reasoning.delta", seq: 1, payload: ["session_id": "s1", "message_id": "m9", "run_id": "run1", "delta": "thinking"]))
        apply(&state, Fixture.envelope("message.delta", seq: 2, payload: ["session_id": "s1", "message_id": "m9", "run_id": "run1", "delta": "answer"]))
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(state.messages[0].reasoning?.text, "thinking")
        XCTAssertEqual(state.messages[0].text, "answer")
        XCTAssertEqual(state.messages[0].role, .assistant)
    }

    func testToolCallsFoldIntoTheirMessage() {
        var state = started()
        apply(&state, Fixture.envelope("message.created", seq: 1, payload: ["message": Fixture.json(Fixture.message(id: "m2", seq: 2, status: .streaming))]))
        apply(&state, Fixture.envelope("tool.started", seq: 2, payload: ["session_id": "s1", "message_id": "m2", "run_id": "run1", "tool_call": Fixture.json(Fixture.tool(status: .running))]))
        apply(&state, Fixture.envelope("tool.completed", seq: 3, payload: ["session_id": "s1", "message_id": "m2", "run_id": "run1", "tool_call": Fixture.json(Fixture.tool(status: .succeeded, output: "a\nb"))]))
        XCTAssertEqual(state.messages[0].toolCalls.count, 1)
        XCTAssertEqual(state.messages[0].toolCalls[0].status, .succeeded)
        XCTAssertEqual(state.messages[0].toolCalls[0].output, "a\nb")
        XCTAssertFalse(state.messages[0].isEmpty)
    }

    func testAFailedRunMarksItsStreamingMessage() {
        var state = started()
        apply(&state, Fixture.envelope("message.created", seq: 1, payload: ["message": Fixture.json(Fixture.message(id: "m2", seq: 2, text: "part", status: .streaming))]))
        apply(&state, Fixture.envelope("run.failed", seq: 2, payload: ["run": Fixture.json(Fixture.run(status: .failed))]))
        XCTAssertEqual(state.messages[0].status, .failed)
        apply(&state, Fixture.envelope("message.created", seq: 3, payload: ["message": Fixture.json(Fixture.message(id: "m3", seq: 3, text: "x", runID: "run2", status: .streaming))]))
        apply(&state, Fixture.envelope("run.cancelled", seq: 4, payload: ["run": Fixture.json(Fixture.run(id: "run2", status: .cancelled))]))
        XCTAssertEqual(state.messages[1].status, .interrupted)
    }

    func testApprovalsComeAndGo() {
        var state = started()
        apply(&state, Fixture.envelope("approval.requested", seq: 1, payload: ["approval": Fixture.json(Fixture.approval())]))
        XCTAssertEqual(state.pendingApprovals.map(\.id), ["a1"])
        apply(&state, Fixture.envelope("approval.resolved", seq: 2, payload: ["approval": Fixture.json(Fixture.approval(status: .approved))]))
        XCTAssertTrue(state.pendingApprovals.isEmpty)
    }

    func testOtherSessionsAreIgnoredButOnlyThisProfileMovesTheCursor() {
        var state = started()
        apply(&state, Fixture.envelope("message.created", seq: 40, profile: "work", payload: ["message": Fixture.json(Fixture.message(id: "x", seq: 1, text: "elsewhere", profile: "work", session: "s2"))]))
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertEqual(state.lastSeq, 0, "another profile's seq must not skip what this one missed")
        apply(&state, Fixture.envelope("message.created", seq: 7, payload: ["message": Fixture.json(Fixture.message(id: "y", seq: 1, text: "other chat", session: "s2"))]))
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertEqual(state.lastSeq, 7)
    }

    func testHydrateKeepsPendingApprovalsAndSortsMessages() {
        var state = started()
        state.lastSeq = 12
        let detail = SessionDetail(
            id: "s1", profile: "default", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date,
            agentId: "ag1", title: "Plan", source: .chat, pinned: false, archived: false, messageCount: 2,
            status: .waiting, notify: true,
            runs: [Fixture.run(status: .waiting)],
            pendingApprovals: [Fixture.approval(), Fixture.approval(id: "a2", status: .approved)]
        )
        let page = MessagePage(items: [Fixture.message(id: "m2", seq: 2, text: "b"), Fixture.message(id: "m1", seq: 1, role: .user, text: "a")], hasMore: true)
        state.hydrate(detail, messages: page)
        XCTAssertEqual(state.messages.map(\.id), ["m1", "m2"])
        XCTAssertEqual(state.pendingApprovals.map(\.id), ["a1"])
        XCTAssertEqual(state.title, "Plan")
        XCTAssertTrue(state.hasOlder)
        XCTAssertEqual(state.lastSeq, 12, "hydrating keeps the realtime cursor")
        XCTAssertEqual(state.activeRun?.status, .waiting)

        state.prependOlder(MessagePage(items: [Fixture.message(id: "m0", seq: 0, text: "z"), Fixture.message(id: "m1", seq: 1, role: .user, text: "a")], hasMore: false))
        XCTAssertEqual(state.messages.map(\.id), ["m0", "m1", "m2"])
        XCTAssertFalse(state.hasOlder)
    }

    func testTurnsGroupBySpeaker() {
        let messages = [
            Fixture.message(id: "1", seq: 1, role: .user, text: "a", author: "Tariq"),
            Fixture.message(id: "2", seq: 2, role: .user, text: "b", author: "Tariq"),
            Fixture.message(id: "3", seq: 3, text: "c"),
            Fixture.message(id: "4", seq: 4, text: "d"),
            Fixture.message(id: "5", seq: 5, text: "e", author: "Claude Code"),
        ]
        XCTAssertEqual((0..<5).map { Turns.startsTurn(messages, at: $0) }, [true, false, true, false, true])
    }

    func testSubscribeAckParsesBothAnswers() {
        let ok = SubscribeAck.parse(#"{"ok":true,"replayed":3,"truncated":true}"#.data(using: .utf8))
        XCTAssertEqual(ok, SubscribeAck(ok: true, replayed: 3, truncated: true, error: nil, code: nil))
        let refused = SubscribeAck.parse(#"{"ok":false,"error":"nope","code":"not_found"}"#.data(using: .utf8))
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.code, "not_found")
        XCTAssertFalse(SubscribeAck.parse(nil).ok)
    }

    func testULIDLooksLikeTheContractsUlid() {
        let id = ULID.make()
        XCTAssertEqual(id.count, 26)
        XCTAssertNotNil(id.range(of: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", options: .regularExpression))
        XCTAssertLessThan(ULID.make(now: Date(timeIntervalSince1970: 1)), ULID.make(now: Date(timeIntervalSince1970: 2)))
    }

    func testApprovalDecisionsFollowTheHub() {
        XCTAssertEqual(ApprovalChoices.decisions(for: Fixture.approval()), [.approveOnce, .approveSession, .deny])
        XCTAssertEqual(ApprovalChoices.decisions(for: Fixture.approval(allowAlways: true)), [.approveOnce, .approveSession, .approveAlways, .deny])
        let listed = Fixture.approval(choices: [Choice(value: "approve_once", label: "مرة"), Choice(value: "deny", label: "رفض")])
        XCTAssertEqual(ApprovalChoices.decisions(for: listed), [.approveOnce, .deny])
    }
}

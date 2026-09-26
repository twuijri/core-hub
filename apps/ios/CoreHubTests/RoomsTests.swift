@testable import CoreHub
import CoreHubClient
import XCTest

/// Rooms on the phone, the pending list, and the chats list's batch mode and export.
final class RoomsTests: XCTestCase {
    private let room = "01J8QK3ZR2W7M5N4P6T8V9X0RM"
    private let other = "01J8QK3ZR2W7M5N4P6T8V9X0RO"
    private let planner = "01J8QK3ZR2W7M5N4P6T8V9X0ST"
    private let coder = "01J8QK3ZR2W7M5N4P6T8V9X0SU"

    private func seat(_ id: String, _ name: String, _ status: SeatStatus = .idle) -> Seat {
        Seat(id: id, roomId: room, agentId: "ag1", name: name, avatar: Avatar(kind: .generated, seed: "s"),
             status: status, executor: SeatExecutor(kind: .server), createdAt: Fixture.date, updatedAt: Fixture.date)
    }

    private func member(_ id: String, user: String, name: String, role: Member.Role = .member) -> Member {
        Member(id: id, roomId: room, userId: user, name: name, avatar: Avatar(kind: .generated, seed: "m"),
               role: role, online: true, joinedAt: Fixture.date)
    }

    private func message(_ id: String, _ seq: Int, text: String?, kind: Author.Kind = .user, authorID: String? = "u1",
                         name: String = "Tariq", roomID: String? = nil, status: MessageStatus = .complete, run: String? = nil) -> Message {
        Message(
            id: id, profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date,
            sessionId: roomID ?? room, roomId: roomID ?? room, seq: seq,
            role: kind == .agent ? .assistant : .user,
            author: Author(kind: kind, id: authorID, name: name),
            content: text.map { [.typeTextBlock(TextBlock(type: .text, text: $0))] } ?? [],
            toolCalls: [], runId: run, status: status, mentions: []
        )
    }

    private func approval(_ id: String, room roomID: String?, session: String? = "s9", workflow: String? = nil,
                          at: Date = Fixture.date, profile: String = "work") -> Approval {
        Approval(id: id, profile: profile, ownerId: "u1", createdAt: at, updatedAt: at, kind: .question, status: .pending,
                 sessionId: session, roomId: roomID, workflowRunId: workflow, agent: AgentRef(id: "ag1", name: "Hermes"),
                 title: "Which colour?", choices: [], allowAlways: false, answerMode: .both)
    }

    private func envelope(_ event: String, _ payload: [String: Any]) -> Envelope {
        let object: [String: Any] = [
            "event": event, "namespace": "/rt/rooms", "profile": "work", "ts": "2026-09-27T10:00:00Z", "seq": 1, "payload": payload,
        ]
        return Envelope.parse(try! JSONSerialization.data(withJSONObject: object))!
    }

    private func opened() -> RoomState {
        var state = RoomState(roomID: room, profile: "work")
        let detail = RoomDetail(
            id: room, profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date, name: "Launch team",
            inviteCode: "AB12CD34", canManage: true, canMentionAll: true, leadSeatId: planner, memberCount: 2, totalTokens: 0,
            summaryPolicy: SummaryPolicy(everyTurns: 20), handoff: HandoffPolicy(enabled: true, maxDepth: 3),
            seats: [seat(planner, "Planner"), seat(coder, "Code Reviewer")],
            members: [member("m1", user: "u1", name: "Tariq", role: .owner), member("m2", user: "u2", name: "Sara")],
            runs: [], pendingApprovals: [approval("q0", room: room)], handoffChains: [],
            memory: RoomMemory(status: .idle, summarizedTurnCount: 0), typing: []
        )
        state.hydrate(detail, messages: MessagePage(items: [message("a1", 1, text: "hello")], hasMore: false))
        return state
    }

    // MARK: - Mentions

    private let seats = [
        RoomMentions.Seat(id: "01J8QK3ZR2W7M5N4P6T8V9X0ST", name: "Planner"),
        RoomMentions.Seat(id: "01J8QK3ZR2W7M5N4P6T8V9X0SU", name: "Code Reviewer"),
        RoomMentions.Seat(id: "01J8QK3ZR2W7M5N4P6T8V9X0SV", name: "Code"),
    ]

    func testAnAtBeingTypedIsAQueryAndAnEmailIsNot() {
        XCTAssertEqual(RoomMentions.query("hello @Co"), RoomMentions.Query(start: 6, query: "Co"))
        XCTAssertEqual(RoomMentions.query("@"), RoomMentions.Query(start: 0, query: ""))
        XCTAssertNil(RoomMentions.query("write to me@example.com"))
        XCTAssertNil(RoomMentions.query("@Code\nnext"))
    }

    func testSuggestionsStartWithWhatWasTypedThenContainIt() {
        XCTAssertEqual(RoomMentions.suggest(seats, "co").map(\.name), ["Code Reviewer", "Code"])
        XCTAssertEqual(RoomMentions.suggest(seats, "view").map(\.name), ["Code Reviewer"])
        XCTAssertEqual(RoomMentions.insert("hi @Co", start: 3, name: "Code Reviewer"), "hi @Code Reviewer ")
    }

    func testMentionsAreWholeNamesLongestFirstWithAllWhenAllowed() {
        let found = RoomMentions.mentions(in: "@Code Reviewer and @Planner, not @Codex", seats: seats, allowAll: false)
        XCTAssertEqual(found.map(\.seatId), [coder, planner])
        XCTAssertTrue(RoomMentions.mentions(in: "@all please", seats: seats, allowAll: false).isEmpty)
        XCTAssertEqual(RoomMentions.mentions(in: "@all please, @Code", seats: seats, allowAll: true).map(\.kind), [.all, .seat])
    }

    // MARK: - The room

    func testASeatsReplyStreamsIntoItsMessageAndEndsComplete() {
        var state = opened()
        state.apply(envelope("message.created", ["message": Fixture.json(message("a2", 2, text: nil, kind: .agent, authorID: "ag1", name: "Planner", status: .streaming, run: "r1"))]))
        state.apply(envelope("seat.updated", ["room_id": room, "seat": Fixture.json(seat(planner, "Planner", .running))]))
        state.apply(envelope("message.delta", ["session_id": "x", "message_id": "a2", "run_id": "r1", "delta": "Start "]))
        state.apply(envelope("message.delta", ["session_id": "x", "message_id": "a2", "run_id": "r1", "delta": "with the UI."]))
        XCTAssertEqual(state.messages.last?.text, "Start with the UI.")
        XCTAssertEqual(state.busySeats.map(\.id), [planner])
        var run = Fixture.run(id: "r1", status: .succeeded)
        run.roomId = room
        state.apply(envelope("run.completed", [
            "run": Fixture.json(run),
            "message": Fixture.json(message("a2", 2, text: "Start with the UI.", kind: .agent, authorID: "ag1", name: "Planner", run: "r1")),
        ]))
        XCTAssertEqual(state.messages.last?.status, .complete)
        XCTAssertEqual(state.messages.last?.text, "Start with the UI.")
    }

    func testAnotherRoomsEventsChangeNothingHere() {
        let state = opened()
        var after = state
        after.apply(envelope("message.created", ["message": Fixture.json(message("b1", 5, text: "elsewhere", roomID: other))]))
        after.apply(envelope("message.delta", ["session_id": "x", "message_id": "b1", "run_id": "r", "delta": "x"]))
        after.apply(envelope("seat.updated", ["room_id": other, "seat": Fixture.json(seat(planner, "Planner", .running))]))
        after.apply(envelope("approval.requested", ["approval": Fixture.json(approval("q9", room: other))]))
        XCTAssertEqual(after.messages, state.messages)
        XCTAssertEqual(after.seats, state.seats)
        XCTAssertEqual(Set(after.approvals.keys), ["q0"])
    }

    func testWhatASeatAsksHereWaitsInTheRoomUntilAnswered() {
        var state = opened()
        XCTAssertEqual(state.pendingApprovals.map(\.id), ["q0"])
        state.apply(envelope("approval.requested", ["approval": Fixture.json(approval("q1", room: room))]))
        XCTAssertEqual(Set(state.approvals.keys), ["q0", "q1"])
        state.apply(envelope("approval.resolved", ["approval": Fixture.json(approval("q1", room: room))]))
        XCTAssertEqual(Set(state.approvals.keys), ["q0"])
    }

    func testPeopleComeAndGoAndTypingShowsUntilItStops() {
        var state = opened()
        state.apply(envelope("member.typing", ["room_id": room, "member_id": "m2", "name": "Sara", "typing": true]))
        XCTAssertEqual(state.typing, ["m2": "Sara"])
        state.apply(envelope("member.left", ["room_id": room, "member": Fixture.json(member("m2", user: "u2", name: "Sara"))]))
        XCTAssertTrue(state.typing.isEmpty)
        XCTAssertEqual(state.members.map(\.userId), ["u1"])
    }

    func testOnlyYourOwnMessagesAreOnTheRight() {
        let mine = message("a1", 1, text: "me")
        let theirs = message("a2", 2, text: "Sara here", authorID: "u2", name: "Sara")
        let agent = message("a3", 3, text: "done", kind: .agent, authorID: "ag1", name: "Planner")
        XCTAssertTrue(RoomTurns.isMine(mine, me: "u1"))
        XCTAssertFalse(RoomTurns.isMine(theirs, me: "u1"))
        XCTAssertFalse(RoomTurns.isMine(agent, me: "u1"))
        XCTAssertTrue(RoomTurns.startsTurn([mine, theirs], at: 1, me: "u1"))
        XCTAssertFalse(RoomTurns.startsTurn([mine, mine], at: 1, me: "u1"))
    }

    // MARK: - Making and joining

    func testAPastedCodeOrLinkGivesTheInviteCode() {
        XCTAssertEqual(RoomLinks.code(from: "ab12cd34"), "AB12CD34")
        XCTAssertEqual(RoomLinks.code(from: "https://hub.example/join/AB12CD34"), "AB12CD34")
        XCTAssertEqual(RoomLinks.code(from: " https://hub.example/join/AB12CD34/?x=1 "), "AB12CD34")
        XCTAssertNil(RoomLinks.code(from: "https://hub.example/join/"))
        XCTAssertEqual(RoomLinks.join(hub: URL(string: "https://hub.example/")!, code: "AB12CD34"), "https://hub.example/join/AB12CD34")
    }

    func testANewRoomsSeatsAreNamedAfterTheirAgentsNeverTwiceTheSame() {
        let agent = { (id: String, name: String) in
            Agent(id: id, profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date, slug: "a\(id)",
                  name: name, kind: .hermes, avatar: Avatar(kind: .generated, seed: "a"), status: .available, enabled: true,
                  install: AgentInstall(source: .managed, updateAvailable: false, newerThanTested: false, autoUpdate: false, autoUpdateSupported: false),
                  runtime: AgentRuntime(state: .running), capabilities: [], sections: [], limited: false, subagents: ._none)
        }
        let seats = NewRoom.seats([agent("1", "Hermes"), agent("2", "hermes"), agent("3", "all")])
        XCTAssertEqual(seats.map(\.name), ["Hermes", "hermes 2", "all 2"])
    }

    func testARoomLinkOpensTheRoomInItsProfile() {
        let url = URL(string: "\(Product.id)://open/rooms/\(room)?profile=work")!
        XCTAssertEqual(AppModel.route(for: url, selector: "default"), .room(roomID: room, profile: "work"))
        XCTAssertEqual(AppModel.route(for: URL(string: "\(Product.id)://open/rooms")!, selector: "default"), .newChat)
    }

    // MARK: - The pending list

    func testThePendingListIsOldestFirstAndEachThingOpensWhereItLives() {
        let inRoom = approval("q1", room: room, at: Fixture.date.addingTimeInterval(120))
        let inChat = approval("q2", room: nil, at: Fixture.date, profile: "home")
        let step = approval("q3", room: nil, session: nil, workflow: "wr1", at: Fixture.date.addingTimeInterval(60))
        XCTAssertEqual(PendingItems.merge([[inRoom, step], [inChat, inChat]]).map(\.id), ["q2", "q3", "q1"])
        XCTAssertEqual(PendingItems.destination(of: inRoom), .room(roomID: room, profile: "work"))
        XCTAssertEqual(PendingItems.destination(of: inChat), .chat(sessionID: "s9", profile: "home"))
        XCTAssertEqual(PendingItems.destination(of: step), .destination(.schedules))
        XCTAssertEqual(PendingItems.placeKey(of: inRoom), "pending.in_room")
    }

    // MARK: - Batch mode and export

    private func session(_ id: String, _ profile: String) -> Session {
        Session(id: id, profile: profile, ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date, agentId: "ag1",
                source: .chat, pinned: false, archived: false, messageCount: 0, status: .idle, notify: false)
    }

    func testASelectionIsSentPerProfileAtMostAHundredACall() {
        let work = (1...150).map { session("w\($0)", "work") }
        let home = session("h1", "home")
        let selected = Set(work.map(\.id) + [home.id])
        let groups = SessionBatch.byProfile(work + [home, session("x", "work")], selected)
        XCTAssertEqual(groups.map { "\($0.0):\($0.1.count)" }, ["work:100", "work:50", "home:1"])
        XCTAssertEqual(SessionBatch.toggle([], "a"), ["a"])
        XCTAssertEqual(SessionBatch.toggle(["a"], "a"), [])
    }

    func testWhatTheHubRefusedInABatchIsSaid() {
        let result = BulkResult(results: [
            BulkResultResultsInner(id: "a", ok: true),
            BulkResultResultsInner(id: "b", ok: false, error: ModelError(error: "cannot archive the global agent", code: .stateInvalid)),
        ])
        XCTAssertEqual(SessionBatch.failures([result]), ["cannot archive the global agent"])
    }

    func testAnExportIsNamedAfterItsChat() {
        XCTAssertEqual(ChatExport.fileName(title: "Launch plan", sessionID: "s1"), "Launch plan.md")
        XCTAssertEqual(ChatExport.fileName(title: "a/b", sessionID: "s1"), "a b.md")
        XCTAssertEqual(ChatExport.fileName(title: "  ", sessionID: "s1"), "s1.md")
    }
}

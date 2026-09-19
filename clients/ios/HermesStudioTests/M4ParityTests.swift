import Foundation
import XCTest
@testable import HermesStudio

/// M4: the group-chat socket contract and reducer, the run→line converter,
/// room drafts and invites, the workflow socket, status styling, cron
/// descriptions and the graph timeline, the model catalog, account
/// management bodies and the session paging helpers.
final class M4ParityTests: XCTestCase {
    private let room = "room-1"

    // MARK: - Group chat socket

    func testRoomEventsIgnoreOtherRooms() {
        let events = GroupRoomSocket.events(for: "message", json: ["roomId": "other", "id": "m1"], roomID: room)
        XCTAssertTrue(events.isEmpty)
    }

    func testRoomMessageEventsAreMapped() {
        let started = GroupRoomSocket.events(for: "message_stream_start", json: ["roomId": room, "id": "m1", "senderId": "a1"], roomID: room)
        guard case let .streamStart(message)? = started.first else { return XCTFail("expected a stream start") }
        XCTAssertEqual(message.id, "m1")

        XCTAssertEqual(GroupRoomSocket.events(for: "message_stream_delta", json: ["roomId": room, "id": "m1", "delta": "Hel"], roomID: room),
                       [.streamDelta(id: "m1", delta: "Hel")])
        XCTAssertEqual(GroupRoomSocket.events(for: "message_reasoning_delta", json: ["roomId": room, "id": "m1", "delta": "why"], roomID: room),
                       [.reasoningDelta(id: "m1", delta: "why")])
        XCTAssertEqual(GroupRoomSocket.events(for: "message_stream_end", json: ["roomId": room, "id": "m1"], roomID: room),
                       [.streamEnd(id: "m1")])
        // An empty delta is not an event.
        XCTAssertTrue(GroupRoomSocket.events(for: "message_stream_delta", json: ["roomId": room, "id": "m1", "delta": ""], roomID: room).isEmpty)
    }

    func testRoomMembershipAndPresenceEvents() {
        let joined = GroupRoomSocket.events(for: "member_joined", json: ["roomId": room, "members": [["id": "u1", "name": "Tariq"]]], roomID: room)
        XCTAssertEqual(joined, [.membersUpdated([RoomMember(["id": "u1", "name": "Tariq"])])])
        XCTAssertEqual(GroupRoomSocket.events(for: "member_kicked", json: ["roomId": room], roomID: room), [.kicked])
        XCTAssertEqual(GroupRoomSocket.events(for: "typing", json: ["roomId": room, "userId": "u2", "userName": "Sara"], roomID: room),
                       [.typing(userID: "u2", name: "Sara", active: true)])
        XCTAssertEqual(GroupRoomSocket.events(for: "stop_typing", json: ["roomId": room, "userId": "u2", "userName": "Sara"], roomID: room),
                       [.typing(userID: "u2", name: "Sara", active: false)])
    }

    func testRoomInteractionAndLifecycleEvents() {
        let approval = GroupRoomSocket.events(for: "approval.requested", json: ["roomId": room, "approval_id": "ap1", "command": "rm -rf", "agentName": "Hermes"], roomID: room)
        guard case let .interactionRequested(pending)? = approval.first else { return XCTFail("expected an approval") }
        XCTAssertEqual(pending.id, "ap1")
        XCTAssertEqual(pending.agentName, "Hermes")
        XCTAssertEqual(pending.interaction.kind, .approval)

        XCTAssertEqual(GroupRoomSocket.events(for: "approval.resolved", json: ["roomId": room, "approval_id": "ap1"], roomID: room),
                       [.interactionResolved(id: "ap1")])
        // `resolved: false` is a refusal to resolve, not a resolution.
        XCTAssertTrue(GroupRoomSocket.events(for: "approval.resolved", json: ["roomId": room, "approval_id": "ap1", "resolved": false], roomID: room).isEmpty)
        XCTAssertEqual(GroupRoomSocket.events(for: "clarify.resolved", json: ["roomId": room, "clarify_id": "cl1"], roomID: room),
                       [.interactionResolved(id: "cl1")])
        XCTAssertEqual(GroupRoomSocket.events(for: "room_cleared", json: ["roomId": room], roomID: room), [.roomCleared])
        XCTAssertEqual(GroupRoomSocket.events(for: "room_updated", json: ["roomId": room, "totalTokens": 42], roomID: room),
                       [.roomUpdated(name: nil, totalTokens: 42)])
    }

    func testJoinSnapshotKeepsTypingUserIdentifiers() {
        let snapshot = RoomJoinSnapshot([
            "roomId": room,
            "roomName": "Launch",
            "members": [["id": "u1", "name": "Tariq"]],
            "messages": [["id": "m1", "content": "hi", "senderId": "u1"]],
            "agents": [["id": "seat1", "agentId": "a1", "agent": "hermes", "name": "Hermes"]],
            "typingUsers": [["userId": "u9", "userName": "Sara"]],
            "executionQueue": [["id": "q1", "roomId": room, "status": "queued"]],
            "pendingApprovals": [["approval_id": "ap1", "description": "run?"]],
            "total": 2,
            "hasMore": true,
            "historyTruncated": true,
        ])
        XCTAssertEqual(snapshot.roomName, "Launch")
        XCTAssertEqual(snapshot.typingUsers.count, 1)
        XCTAssertEqual(snapshot.typingUsers.first?.userID, "u9")
        XCTAssertEqual(snapshot.typingUsers.first?.name, "Sara")
        XCTAssertEqual(snapshot.agents.first?.agentID, "a1")
        XCTAssertEqual(snapshot.pendingApprovals.count, 1)
        XCTAssertTrue(snapshot.hasMore)
        XCTAssertTrue(snapshot.historyTruncated)
    }

    // MARK: - Room reducer

    private func joinedState() -> GroupRoomState {
        var state = GroupRoomState()
        GroupRoomReducer.apply(.connected, to: &state)
        GroupRoomReducer.apply(.joined(RoomJoinSnapshot([
            "roomId": room,
            "roomName": "Launch",
            "members": [["id": "me", "name": "Tariq"], ["id": "u2", "name": "Sara"]],
            "messages": [["id": "m1", "content": "hello", "senderId": "me", "timestamp": 1_000]],
            "agents": [["id": "seat1", "agentId": "a1", "agent": "hermes", "name": "Hermes"]],
            "hasMore": true,
        ])), to: &state)
        return state
    }

    func testReducerJoinFillsTheRoom() {
        let state = joinedState()
        XCTAssertTrue(state.joined)
        XCTAssertEqual(state.roomName, "Launch")
        XCTAssertEqual(state.members.count, 2)
        XCTAssertEqual(state.messages.map(\.id), ["m1"])
        XCTAssertTrue(state.hasMore)
    }

    func testReducerStreamsAnAgentReply() {
        var state = joinedState()
        GroupRoomReducer.apply(.streamStart(GroupMessage(["id": "m2", "senderId": "a1", "role": "assistant", "run_id": "r1"])), to: &state)
        GroupRoomReducer.apply(.streamDelta(id: "m2", delta: "Hel"), to: &state)
        GroupRoomReducer.apply(.streamDelta(id: "m2", delta: "lo"), to: &state)
        GroupRoomReducer.apply(.reasoningDelta(id: "m2", delta: "think"), to: &state)
        XCTAssertEqual(state.messages.last?.text, "Hello")
        XCTAssertEqual(state.messages.last?.reasoning, "think")
        XCTAssertTrue(state.messages.last?.isStreaming == true)
        GroupRoomReducer.apply(.streamEnd(id: "m2"), to: &state)
        XCTAssertFalse(state.messages.last?.isStreaming == true)
    }

    func testReducerDropsAnEmptyStreamPlaceholder() {
        var state = joinedState()
        GroupRoomReducer.apply(.streamStart(GroupMessage(["id": "m2", "senderId": "a1", "role": "assistant"])), to: &state)
        GroupRoomReducer.apply(.streamEnd(id: "m2"), to: &state)
        XCTAssertEqual(state.messages.map(\.id), ["m1"])
    }

    func testReducerTracksTypingByUserIdentifier() {
        var state = joinedState()
        GroupRoomReducer.apply(.typing(userID: "u2", name: "Sara", active: true), to: &state, currentUserID: "me")
        XCTAssertEqual(state.typingNames, ["Sara"])
        // My own typing echo never shows up.
        GroupRoomReducer.apply(.typing(userID: "me", name: "Tariq", active: true), to: &state, currentUserID: "me")
        XCTAssertEqual(state.typingNames, ["Sara"])
        GroupRoomReducer.apply(.typing(userID: "u2", name: "Sara", active: false), to: &state, currentUserID: "me")
        XCTAssertTrue(state.typingNames.isEmpty)
    }

    func testReducerKeepsOnlyBusyAgentsAndQueuedWork() {
        var state = joinedState()
        GroupRoomReducer.apply(.activity(GroupAgentActivity(["roomId": room, "agentId": "a1", "runId": "r1", "agentName": "Hermes", "status": "replying"])), to: &state)
        XCTAssertEqual(state.activeAgents.count, 1)
        GroupRoomReducer.apply(.activity(GroupAgentActivity(["roomId": room, "agentId": "a1", "runId": "r1", "agentName": "Hermes", "status": "ready"])), to: &state)
        XCTAssertTrue(state.activeAgents.isEmpty)

        GroupRoomReducer.apply(.queueUpdated([
            GroupQueueItem(["id": "q1", "status": "queued"]),
            GroupQueueItem(["id": "q2", "status": "done"]),
        ]), to: &state)
        XCTAssertEqual(state.queue.map(\.id), ["q1"])
    }

    func testReducerHandlesHandoffsInteractionsAndClearing() {
        var state = joinedState()
        GroupRoomReducer.apply(.handoffUpdated(HandoffChain(["chainId": "c1", "status": "stopped", "currentDepth": 3, "maxDepth": 3])), to: &state)
        XCTAssertEqual(state.stoppedHandoffs.map(\.id), ["c1"])
        GroupRoomReducer.apply(.handoffUpdated(HandoffChain(["chainId": "c1", "status": "running", "currentDepth": 4])), to: &state)
        XCTAssertTrue(state.stoppedHandoffs.isEmpty)

        let pending = GroupPendingInteraction(event: "clarify.requested", payload: ["roomId": room, "clarify_id": "cl1", "question": "which branch?"])
        GroupRoomReducer.apply(.interactionRequested(pending), to: &state)
        XCTAssertEqual(state.pendingInteractions.map(\.id), ["cl1"])
        GroupRoomReducer.apply(.interactionResolved(id: "cl1"), to: &state)
        XCTAssertTrue(state.pendingInteractions.isEmpty)

        GroupRoomReducer.apply(.roomCleared, to: &state)
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertEqual(state.totalTokens, 0)
    }

    func testPrependHistorySkipsMessagesAlreadyLoaded() {
        var state = joinedState()
        GroupRoomReducer.prependHistory([
            GroupMessage(["id": "m0", "content": "older", "timestamp": 500]),
            GroupMessage(["id": "m1", "content": "hello", "timestamp": 1_000]),
        ], hasMore: false, to: &state)
        XCTAssertEqual(state.messages.map(\.id), ["m0", "m1"])
        XCTAssertFalse(state.hasMore)
    }

    // MARK: - Messages → lines

    func testGroupRunLinesFoldOneRunIntoOneAssistantRow() {
        let agents = [RoomAgent(["id": "seat1", "agentId": "a1", "agent": "hermes", "name": "Hermes"])]
        let messages = [
            GroupMessage(["id": "m1", "senderId": "u2", "senderName": "Sara", "content": "check the repo", "timestamp": 1_000]),
            GroupMessage(["id": "m2", "senderId": "a1", "senderName": "Hermes", "role": "assistant", "run_id": "r1", "timestamp": 1_100,
                          "tool_calls": [["id": "t1", "function": ["name": "shell", "arguments": "{\"command\":\"ls\"}"]]]]),
            GroupMessage(["id": "m3", "senderId": "a1", "role": "tool", "run_id": "r1", "tool_call_id": "t1", "tool_name": "shell", "content": "README.md", "timestamp": 1_200]),
            GroupMessage(["id": "m4", "senderId": "a1", "senderName": "Hermes", "role": "assistant", "run_id": "r1", "content": "Found one file.", "timestamp": 1_300]),
        ]
        let lines = GroupRunLines.lines(from: messages, agents: agents, currentUserID: "me")
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0].memberName, "Sara")
        XCTAssertEqual(lines[0].line.kind, .user)
        XCTAssertEqual(lines[1].line.kind, .assistant)
        XCTAssertEqual(lines[1].line.text, "Found one file.")
        XCTAssertEqual(lines[1].line.tools.count, 1)
        XCTAssertEqual(lines[1].line.tools.first?.status, .done)
        XCTAssertEqual(lines[1].line.tools.first?.output, "README.md")
        XCTAssertEqual(lines[1].agent, .hermes)
    }

    func testMyOwnMessagesCarryNoMemberName() {
        let messages = [GroupMessage(["id": "m1", "senderId": "me", "senderName": "Tariq", "content": "hi"])]
        let lines = GroupRunLines.lines(from: messages, agents: [], currentUserID: "me")
        XCTAssertNil(lines.first?.memberName)
    }

    func testInteractionLinesPrefixTheAgentName() {
        let pending = GroupPendingInteraction(event: "approval.requested", payload: ["approval_id": "ap1", "description": "run ls", "agentName": "Hermes"])
        let lines = GroupRunLines.interactionLines([pending])
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines.first?.kind, .interaction)
        XCTAssertEqual(lines.first?.interaction?.prompt, "Hermes: run ls")
    }

    func testGroupContentBlocksSplitTextAndFiles() {
        let parsed = GroupMessage.parseContent([
            ["type": "text", "text": "look"],
            ["type": "image", "name": "shot.png", "path": "/tmp/shot.png", "media_type": "image/png"],
        ])
        XCTAssertEqual(parsed.text, "look")
        XCTAssertEqual(parsed.files.first?.name, "shot.png")
        XCTAssertEqual(parsed.files.first?.type, "image/png")
    }

    // MARK: - Room drafts, agents and invites

    func testRoomAgentInputBodyAndValidation() {
        var input = RoomAgentInput()
        input.profile = "main"
        input.name = "Planner"
        input.model = "gpt-5"
        input.provider = "openai"
        XCTAssertTrue(input.isValid)
        let body = input.body
        XCTAssertEqual(body.string("agent"), "hermes")
        XCTAssertEqual(body.string("provider"), "openai")
        XCTAssertEqual(body.string("model"), "gpt-5")

        // `all` is reserved for the @all mention.
        var reserved = input
        reserved.name = "all"
        XCTAssertFalse(reserved.isValid)

        // Global mode is only allowed for the coding agents that support it.
        var global = input
        global.agentMode = "global"
        XCTAssertFalse(global.isValid)
        global.agent = "claude"
        XCTAssertTrue(global.isValid)
        XCTAssertNil(global.body["apiMode"])
    }

    func testRoomCreateDraftValidatesAndBuildsTheSummary() {
        var draft = RoomCreateDraft()
        draft.inviteCode = "ABCD1234"
        XCTAssertEqual(draft.validationError, String(localized: "Enter a room name."))
        draft.name = "Launch"
        XCTAssertEqual(draft.validationError, String(localized: "Choose the profile that writes the room summary."))
        draft.summaryProfile = "main"
        XCTAssertTrue(draft.isValid)

        var first = RoomAgentInput(); first.profile = "main"; first.name = "Planner"
        var second = RoomAgentInput(); second.profile = "main"; second.name = "planner"
        draft.agents = [first, second]
        XCTAssertEqual(draft.validationError, String(localized: "Agent names must be unique inside a room."))

        draft.agents = [first]
        draft.summaryModel = "gpt-5"
        draft.summaryProvider = "openai"
        draft.summaryEveryTurns = 7
        let summary = draft.summaryBody
        XCTAssertEqual(summary.string("profile"), "main")
        XCTAssertEqual(summary.int("everyTurns"), 7)
        XCTAssertEqual(summary.string("model"), "gpt-5")
    }

    func testRoomConfigDraftSendsTheHandoffPolicy() {
        let stored = Room(["id": "r1", "name": "Launch", "summaryProfile": "main", "summaryEveryTurns": 5, "agentHandoffEnabled": true, "agentHandoffMaxDepth": 4])
        var draft = RoomConfigDraft(room: stored)
        XCTAssertEqual(draft.handoffMaxDepth, 4)
        let limited = draft.body.object("agentHandoff")
        XCTAssertEqual(limited.int("maxDepth"), 4)
        XCTAssertTrue(limited.bool("enabled"))

        draft.handoffUnlimited = true
        let unlimited = draft.body.object("agentHandoff")
        XCTAssertNil(unlimited["maxDepth"])
        XCTAssertTrue(unlimited.bool("unlimited"))
    }

    func testInviteLinkMatchesTheWebShareRoute() {
        // `URL.path` drops a trailing slash on the CI simulator: compare the
        // whole URL instead.
        let url = RoomInviteLink.url(server: "https://hub.example/", inviteCode: "ABCD1234")
        XCTAssertEqual(url?.absoluteString, "https://hub.example/share/group-chat/ABCD1234")
        XCTAssertNil(RoomInviteLink.url(server: "", inviteCode: "ABCD1234"))
        XCTAssertNil(RoomInviteLink.url(server: "https://hub.example", inviteCode: ""))
    }

    func testGeneratedInviteCodesAvoidAmbiguousGlyphs() {
        let allowed = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        for _ in 0..<20 {
            let code = RoomInviteLink.generateCode()
            XCTAssertEqual(code.count, 8)
            XCTAssertTrue(code.allSatisfy { allowed.contains($0) }, "unexpected glyph in \(code)")
        }
    }

    func testMentionMenuInsertsAndDetectsNames() {
        let agents = [RoomAgent(["id": "s1", "agentId": "a1", "name": "Planner"]), RoomAgent(["id": "s2", "agentId": "a2", "name": "Reviewer"])]
        XCTAssertEqual(GroupMentions.suggestions(agents: agents, canMentionAll: true), ["all", "Planner", "Reviewer"])
        XCTAssertEqual(GroupMentions.suggestions(agents: agents, canMentionAll: false), ["Planner", "Reviewer"])
        XCTAssertEqual(GroupMentions.insert("Planner", into: "hello"), "hello @Planner ")
        // A half-typed mention is replaced, not duplicated.
        XCTAssertEqual(GroupMentions.insert("Planner", into: "hello @Pl"), "hello @Planner ")
        XCTAssertEqual(GroupMentions.mentioned(in: "ping @planner please", agents: agents), ["Planner"])
        XCTAssertTrue(GroupMentions.mentionsAll("@all stand up"))
    }

    // MARK: - Workflows

    func testWorkflowStatusStyle() {
        XCTAssertEqual(WorkflowStatusStyle.tone(for: "running"), .info)
        XCTAssertEqual(WorkflowStatusStyle.tone(for: "completed"), .success)
        XCTAssertEqual(WorkflowStatusStyle.tone(for: "pending_approval"), .warning)
        XCTAssertEqual(WorkflowStatusStyle.tone(for: "failed"), .error)
        XCTAssertEqual(WorkflowStatusStyle.tone(for: "something-else"), .neutral)
        XCTAssertEqual(WorkflowStatusStyle.label(for: "completed"), String(localized: "Completed"))
        XCTAssertEqual(WorkflowStatusStyle.label(for: ""), String(localized: "Idle"))
        XCTAssertTrue(WorkflowStatusStyle.isTerminal("canceled"))
        XCTAssertFalse(WorkflowStatusStyle.isTerminal("running"))
    }

    func testCronDescriptions() {
        // The wording is localized; assert the parsed values instead.
        XCTAssertTrue(CronDescription.describe("0 9 * * *").contains("09:00"))
        XCTAssertTrue(CronDescription.describe("30 7 * * 1-5").contains("07:30"))
        XCTAssertTrue(CronDescription.describe("*/15 * * * *").contains("15"))
        XCTAssertTrue(CronDescription.describe("0 */6 * * *").contains("6"))
        XCTAssertNotEqual(CronDescription.describe("0 9 * * *"), "0 9 * * *")
        // Anything the describer does not understand is shown verbatim.
        XCTAssertEqual(CronDescription.describe("not a cron"), "not a cron")
    }

    private var sampleWorkflow: WorkflowItem {
        WorkflowItem([
            "id": "wf1",
            "name": "Research",
            "profile": "main",
            "nodes": [
                ["id": "b", "data": ["title": "Write", "agent": "hermes"], "position": ["x": 10, "y": 0]],
                ["id": "a", "data": ["title": "Plan", "agent": "hermes", "approvalRequired": true], "position": ["x": 0, "y": 0]],
            ],
            "edges": [["source": "a", "target": "b", "data": ["route": "always"]]],
        ])
    }

    func testGraphOrderStartsAtNodesWithoutIncomingEdges() {
        let nodes = WorkflowGraph.nodes(sampleWorkflow)
        let edges = WorkflowGraph.edges(sampleWorkflow)
        XCTAssertEqual(WorkflowGraph.ordered(nodes: nodes, edges: edges).map(\.id), ["a", "b"])
        XCTAssertEqual(edges.first?.route, "always")
        XCTAssertTrue(nodes.first { $0.id == "a" }?.approvalRequired == true)
    }

    func testTimelineMergesPersistedSessionsWithLiveStatus() {
        let run = WorkflowRun([
            "id": "run1",
            "status": "running",
            "node_sessions": [
                ["id": "ns1", "node_id": "a", "status": "completed", "session_id": "s1", "execution_id": "e1", "started_at": 1_000, "finished_at": 3_000],
            ],
        ])
        let live = WorkflowRuntimeStatus(["workflowId": "wf1", "runId": "run1", "status": "running", "nodeStatuses": ["b": "running"], "pendingApprovals": [["nodeId": "b"]]])
        let rows = WorkflowGraph.timeline(workflow: sampleWorkflow, run: run, live: live)
        XCTAssertEqual(rows.map(\.id), ["a", "b"])
        XCTAssertEqual(rows[0].status, "completed")
        XCTAssertEqual(rows[0].sessionID, "s1")
        // A pending approval wins over the live node status.
        XCTAssertEqual(rows[1].status, "pending_approval")
        XCTAssertTrue(rows[1].awaitingApproval)
    }

    func testWorkflowSocketUnwrapsTheAcknowledgementEnvelope() {
        let success = WorkflowSocket.unwrap(["ok": true, "data": ["workflows": [["id": "wf1", "name": "Research"]]]])
        switch success {
        case let .success(data): XCTAssertEqual(data.objects("workflows").count, 1)
        case .failure: XCTFail("expected success")
        }
        switch WorkflowSocket.unwrap(["ok": false, "error": "nope"]) {
        case .success: XCTFail("expected a failure")
        case let .failure(error): XCTAssertEqual(error.errorDescription, "nope")
        }
    }

    func testWorkflowSocketEventMapping() {
        guard case let .statusUpdated(status)? = WorkflowSocket.event(for: "workflow.status.updated", json: ["workflowId": "wf1", "status": "running"]) else {
            return XCTFail("expected a status update")
        }
        XCTAssertEqual(status.workflowID, "wf1")
        XCTAssertTrue(status.isActive)
        XCTAssertEqual(WorkflowSocket.event(for: "workflow.status.error", json: ["workflowId": "wf1", "error": "boom"]),
                       .statusError(workflowID: "wf1", error: "boom"))
        XCTAssertNil(WorkflowSocket.event(for: "unrelated", json: [:]))
    }

    // MARK: - Settings

    func testModelCatalogReadsAliasesVisibilityAndCustomModels() {
        let catalog = ModelCatalog([
            "default": "gpt-5",
            "default_provider": "openai",
            "groups": [["provider": "openai", "label": "OpenAI", "models": ["gpt-5", "gpt-4o"], "api_key": "sk-x", "builtin": true]],
            "model_aliases": ["openai": ["gpt-5": "Main model"]],
            "model_visibility": ["openai": ["mode": "include", "models": ["gpt-5"]]],
            "custom_models": ["openai": ["my-model"]],
        ])
        let group = catalog.groups.first
        XCTAssertEqual(catalog.defaultModel, "gpt-5")
        XCTAssertEqual(group?.label, "OpenAI")
        XCTAssertTrue(group?.apiKeyConfigured == true)
        XCTAssertEqual(catalog.displayName(provider: "openai", model: "gpt-5"), "Main model")
        XCTAssertEqual(catalog.displayName(provider: "openai", model: "gpt-4o"), "gpt-4o")
        XCTAssertTrue(catalog.isVisible(provider: "openai", model: "gpt-5"))
        XCTAssertFalse(catalog.isVisible(provider: "openai", model: "gpt-4o"))
        XCTAssertTrue(catalog.isCustom(provider: "openai", model: "my-model"))
        if let group { XCTAssertEqual(catalog.allModels(of: group), ["gpt-5", "gpt-4o", "my-model"]) }
    }

    func testManagedUserParsingAndBody() {
        let user = ManagedUser(["id": 3, "username": "sara", "role": "admin", "status": "disabled", "profiles": ["main"], "default_profile": "main"])
        XCTAssertFalse(user.isSuperAdmin)
        XCTAssertFalse(user.isActive)
        XCTAssertEqual(user.profiles, ["main"])

        let created = APIClient.managedUserBody(username: "sara", password: "secret", role: "admin", status: "active", profiles: ["main"], defaultProfile: "main")
        XCTAssertEqual(created.string("password"), "secret")
        XCTAssertEqual(created.string("defaultProfile"), "main")

        // An empty password is never sent, so editing keeps the stored one.
        let edited = APIClient.managedUserBody(username: "sara", password: "", role: "admin", status: "active", profiles: [], defaultProfile: "")
        XCTAssertNil(edited["password"])
        XCTAssertTrue(edited["defaultProfile"] is NSNull)
    }

    func testTextScaleClampsTheTokenFonts() {
        let original = CoreHubTokens.Typography.scale
        defer { CoreHubTokens.Typography.scale = original }
        CoreHubTokens.Typography.scale = 1
        XCTAssertEqual(CoreHubTokens.Typography.scaled(14), 14)
        CoreHubTokens.Typography.scale = 1.5
        XCTAssertEqual(CoreHubTokens.Typography.scaled(14), 20)
        CoreHubTokens.Typography.scale = 0.1
        XCTAssertEqual(CoreHubTokens.Typography.scaled(14), 12)
    }

    // MARK: - Session paging and batch selection

    func testMessagePagingWalksBackwardsFromTheNewestPage() {
        XCTAssertEqual(MessagePaging.lastPageOffset(total: 400, limit: 150), 250)
        XCTAssertEqual(MessagePaging.lastPageOffset(total: 20, limit: 150), 0)
        let window = MessagePaging.earlierWindow(currentOffset: 250, limit: 150)
        XCTAssertEqual(window?.offset, 100)
        XCTAssertEqual(window?.limit, 150)
        let firstPage = MessagePaging.earlierWindow(currentOffset: 100, limit: 150)
        XCTAssertEqual(firstPage?.offset, 0)
        XCTAssertEqual(firstPage?.limit, 100)
        XCTAssertNil(MessagePaging.earlierWindow(currentOffset: 0, limit: 150))
    }

    func testBatchSelectionSplitsArchiveTargets() {
        let sessions = [
            SessionSummary(["id": "s1", "title": "One"]),
            SessionSummary(["id": "s2", "title": "Two", "is_archived": true]),
            SessionSummary(["id": "s3", "title": "Three", "source": "global_agent"]),
        ]
        var selection = SessionBatchSelection()
        selection.active = true
        for session in sessions { selection.toggle(session.id) }
        XCTAssertEqual(selection.selected(in: sessions).count, 3)
        XCTAssertEqual(selection.archiveTargets(in: sessions).map(\.id), ["s1"])
        XCTAssertEqual(selection.unarchiveTargets(in: sessions).map(\.id), ["s2"])
        selection.toggle("s1")
        XCTAssertEqual(selection.selected(in: sessions).count, 2)
        selection.clear()
        XCTAssertFalse(selection.active)
        XCTAssertTrue(selection.ids.isEmpty)
    }

    func testSearchResultsAndPagesAreParsed() {
        let result = SessionSearchResult(["id": "s1", "title": "Deploy", "snippet": "…deploy the stack…", "matched_message_id": "m9"], profile: "main")
        XCTAssertEqual(result.id, "s1")
        XCTAssertEqual(result.snippet, "…deploy the stack…")
        XCTAssertEqual(result.matchedMessageID, "m9")

        let page = MessagePage(["messages": [["id": "m1", "role": "user", "content": "hi"]], "total": 12, "offset": 0, "limit": 1, "hasMore": true])
        XCTAssertEqual(page.messages.count, 1)
        XCTAssertEqual(page.total, 12)
        XCTAssertTrue(page.hasMore)
    }

    func testBatchResultCollectsErrors() {
        let result = BatchResult(["updated": 2, "failed": 1, "errors": [["id": "s3", "error": "locked"]]], successKey: "updated")
        XCTAssertEqual(result.succeeded, 2)
        XCTAssertEqual(result.failed, 1)
        XCTAssertEqual(result.errors, ["s3: locked"])
    }
}

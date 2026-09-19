import Foundation

/// What the `join` acknowledgement carries (`handleJoin` in
/// `packages/server/src/modules/studio/sockets/group-chat.ts`).
struct RoomJoinSnapshot: Equatable {
    let roomID: String
    let roomName: String
    let members: [RoomMember]
    let messages: [GroupMessage]
    let agents: [RoomAgent]
    let typingUsers: [String]
    let executionQueue: [GroupQueueItem]
    let pendingApprovals: [GroupPendingInteraction]
    let pendingClarifies: [GroupPendingInteraction]
    let summary: RoomSummaryState?
    let total: Int
    let hasMore: Bool
    let historyTruncated: Bool

    init(_ json: JSON) {
        roomID = json.string("roomId")
        roomName = json.string("roomName")
        members = json.objects("members").map(RoomMember.init)
        messages = json.objects("messages").map(GroupMessage.init)
        agents = json.objects("agents").map(RoomAgent.init)
        typingUsers = json.array("typingUsers").compactMap { ($0 as? String) ?? ($0 as? JSON)?.string("userName", "name") }
        executionQueue = json.objects("executionQueue").map(GroupQueueItem.init)
        pendingApprovals = json.objects("pendingApprovals").map { GroupPendingInteraction(event: "approval.requested", payload: $0) }
        pendingClarifies = json.objects("pendingClarifies").map { GroupPendingInteraction(event: "clarify.requested", payload: $0) }
        let summaryJSON = json.object("roomSummary")
        summary = summaryJSON.isEmpty ? nil : RoomSummaryState(summaryJSON)
        total = json.int("total")
        hasMore = json.bool("hasMore")
        historyTruncated = json.bool("historyTruncated")
    }
}

/// Events of the `/group-chat` namespace, translated for the room reducer.
enum LiveRoomEvent: Equatable {
    case connected
    case joined(RoomJoinSnapshot)
    case joinFailed(String)
    case disconnected(String?)
    case message(GroupMessage)
    case streamStart(GroupMessage)
    case streamDelta(id: String, delta: String)
    case reasoningDelta(id: String, delta: String)
    case streamEnd(id: String)
    case membersUpdated([RoomMember])
    case kicked
    case agentsUpdated([RoomAgent])
    case typing(userID: String, name: String, active: Bool)
    case activity(GroupAgentActivity)
    case queueUpdated([GroupQueueItem])
    case messageRetracted(id: String)
    case summaryUpdated(RoomSummaryState)
    case handoffUpdated(HandoffChain)
    case interactionRequested(GroupPendingInteraction)
    case interactionResolved(id: String)
    case roomUpdated(name: String?, totalTokens: Int?)
    case roomCleared
    case contextStatus(agentName: String, status: String)
}

private final class RoomReconnectTask: @unchecked Sendable {
    var value: Task<Void, Never>?
    var closed = false
    var attempt = 0
}

/// Persistent `/group-chat` connection for one room: `auth: { token }`, a
/// `join` with acknowledgement on every (re)connect, exponential backoff and
/// the pure `events(for:json:)` mapping.
final class GroupRoomSocket: @unchecked Sendable {
    private var connection: SocketIOConnection?
    private var roomID = ""
    private(set) var isConnected = false

    func close() { connection?.close(); connection = nil; isConnected = false }

    /// `message` with ack: `{ roomId, id, content, mentions }` where
    /// `content` is a string or content blocks. Returns the server error, if any.
    func send(messageID: String, content: Any, mentions: [JSON]) async -> String? {
        guard let connection, connection.isConnected else { return String(localized: "Not connected to the room") }
        var payload: JSON = ["roomId": roomID, "id": messageID, "content": content]
        if !mentions.isEmpty { payload["mentions"] = mentions }
        let response = await connection.request("message", payload: payload)
        return response.string("error").nilIfEmpty
    }

    func typing(_ active: Bool) { connection?.emit(active ? "typing" : "stop_typing", payload: ["roomId": roomID]) }

    func interruptAgent(named name: String) async -> String? {
        guard let connection else { return nil }
        return await connection.request("interrupt_agent", payload: ["roomId": roomID, "agentName": name]).string("error").nilIfEmpty
    }

    func cancelQueueItem(_ id: String) async -> String? {
        guard let connection else { return nil }
        return await connection.request("cancel_execution_queue_item", payload: ["roomId": roomID, "queueId": id]).string("error").nilIfEmpty
    }

    func respondToApproval(id: String, choice: String) async -> String? {
        guard let connection else { return nil }
        return await connection.request("approval.respond", payload: ["roomId": roomID, "approval_id": id, "choice": choice]).string("error").nilIfEmpty
    }

    func respondToClarification(id: String, answer: String) async -> String? {
        guard let connection else { return nil }
        return await connection.request("clarify.respond", payload: ["roomId": roomID, "clarify_id": id, "response": answer]).string("error").nilIfEmpty
    }

    /// `load_messages { roomId, before, limit, history: true }` → older page.
    func loadOlder(before: String, limit: Int = 100) async -> (messages: [GroupMessage], hasMore: Bool)? {
        guard let connection else { return nil }
        let response = await connection.request("load_messages", payload: ["roomId": roomID, "before": before, "limit": limit, "history": true])
        guard response.string("error").isEmpty else { return nil }
        return (response.objects("messages").map(GroupMessage.init), response.bool("hasMore"))
    }

    /// Opens the connection, joins the room and streams events until the
    /// stream is cancelled.
    func open(baseURL: String, token: String, profile: String, roomID: String, memberName: String) -> AsyncStream<LiveRoomEvent> {
        close()
        self.roomID = roomID
        return AsyncStream { continuation in
            let live = SocketIOConnection(baseURL: baseURL, token: token, namespace: "/group-chat", profile: profile, platform: "ios")
            self.connection = live
            let retry = RoomReconnectTask()
            var handlePacket: ((String) -> Void)!

            func scheduleReconnect() {
                guard !retry.closed, retry.value == nil else { return }
                let delay = min(pow(2.0, Double(retry.attempt)), 30.0)
                retry.attempt += 1
                retry.value = Task {
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled, !retry.closed else { return }
                    retry.value = nil
                    live.connect(onPacket: handlePacket)
                }
            }

            handlePacket = { [weak self] packet in
                if packet == "__connected__" {
                    retry.attempt = 0
                    self?.isConnected = true
                    continuation.yield(.connected)
                    live.emitWithAck("join", payload: ["roomId": roomID, "name": memberName, "historyLimit": 150]) { response in
                        let json = (response as? JSON) ?? [:]
                        if let error = json.string("error").nilIfEmpty { continuation.yield(.joinFailed(error)) }
                        else { continuation.yield(.joined(RoomJoinSnapshot(json))) }
                    }
                    return
                }
                if packet == "__disconnected__" || packet.hasPrefix("__error__:") {
                    self?.isConnected = false
                    let message = packet.hasPrefix("__error__:") ? String(packet.dropFirst(10)) : nil
                    continuation.yield(.disconnected(message))
                    scheduleReconnect()
                    return
                }
                guard let (event, json) = ChatSocket.event(packet, namespace: "/group-chat") else { return }
                for item in Self.events(for: event, json: json, roomID: roomID) { continuation.yield(item) }
            }
            live.connect(onPacket: handlePacket)
            continuation.onTermination = { [weak self] _ in retry.closed = true; retry.value?.cancel(); self?.close() }
        }
    }

    /// Server event → room events (pure; unit-tested). Events for other
    /// rooms are ignored.
    static func events(for event: String, json: JSON, roomID: String) -> [LiveRoomEvent] {
        let target = json.string("roomId", "room_id")
        if !target.isEmpty && target != roomID { return [] }
        switch event {
        case "message": return [.message(GroupMessage(json))]
        case "message_stream_start": return [.streamStart(GroupMessage(json))]
        case "message_stream_delta":
            let delta = json.string("delta"); return delta.isEmpty ? [] : [.streamDelta(id: json.string("id"), delta: delta)]
        case "message_reasoning_delta":
            let delta = json.string("delta"); return delta.isEmpty ? [] : [.reasoningDelta(id: json.string("id"), delta: delta)]
        case "message_stream_end": return [.streamEnd(id: json.string("id"))]
        case "member_joined", "member_left", "member_updated": return [.membersUpdated(json.objects("members").map(RoomMember.init))]
        case "member_kicked": return [.kicked]
        case "agents_updated": return [.agentsUpdated(json.objects("agents").map(RoomAgent.init))]
        case "typing": return [.typing(userID: json.string("userId"), name: json.string("userName"), active: true)]
        case "stop_typing": return [.typing(userID: json.string("userId"), name: json.string("userName"), active: false)]
        case "room_agent_activity": return [.activity(GroupAgentActivity(json))]
        case "execution_queue_updated": return [.queueUpdated(json.objects("items").map(GroupQueueItem.init))]
        case "message_retracted": return [.messageRetracted(id: json.string("messageId", "id"))]
        case "room_summary_updated": return [.summaryUpdated(RoomSummaryState(json))]
        case "handoff_updated": return [.handoffUpdated(HandoffChain(json))]
        case "approval.requested", "clarify.requested": return [.interactionRequested(GroupPendingInteraction(event: event, payload: json))]
        case "approval.resolved":
            return json["resolved"] != nil && !json.bool("resolved") ? [] : [.interactionResolved(id: json.string("approval_id"))]
        case "clarify.resolved": return [.interactionResolved(id: json.string("clarify_id"))]
        case "room_updated": return [.roomUpdated(name: json.string("name").nilIfEmpty, totalTokens: json["totalTokens"] == nil ? nil : json.int("totalTokens"))]
        case "room_cleared": return [.roomCleared]
        case "context_status": return [.contextStatus(agentName: json.string("agentName"), status: json.string("status"))]
        default: return []
        }
    }
}

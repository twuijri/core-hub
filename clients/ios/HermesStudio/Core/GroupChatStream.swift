import CryptoKit
import Foundation

/// Deterministic UUIDs for rows whose identity comes from the server, so
/// SwiftUI keeps its diffing/scroll position across recomputations.
enum StableID {
    static func uuid(_ key: String) -> UUID {
        let digest = Insecure.MD5.hash(data: Data(key.utf8))
        let bytes = Array(digest)
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }
}

/// Everything the room screen renders (web `group-chat.ts` store subset).
struct GroupRoomState: Equatable {
    var roomName = ""
    var messages: [GroupMessage] = []
    var members: [RoomMember] = []
    var agents: [RoomAgent] = []
    var typingUsers: [String: String] = [:]
    var activities: [String: GroupAgentActivity] = [:]
    var contextStatuses: [String: String] = [:]
    var queue: [GroupQueueItem] = []
    var pendingInteractions: [GroupPendingInteraction] = []
    var summary: RoomSummaryState?
    var handoffs: [HandoffChain] = []
    var totalTokens = 0
    var hasMore = false
    var historyTruncated = false
    var connected = false
    var joined = false
    var kicked = false
    var connectionError: String?

    var typingNames: [String] { typingUsers.values.sorted() }
    var activeAgents: [GroupAgentActivity] { activities.values.filter { $0.status != "ready" }.sorted { $0.agentName < $1.agentName } }
    var stoppedHandoffs: [HandoffChain] { handoffs.filter { $0.canContinue } }
    var oldestMessageID: String? { messages.first?.id }
}

/// Pure reducer for `LiveRoomEvent` (unit-tested).
enum GroupRoomReducer {
    static func apply(_ event: LiveRoomEvent, to state: inout GroupRoomState, currentUserID: String = "") {
        switch event {
        case .connected:
            state.connected = true
            state.connectionError = nil
        case let .joined(snapshot):
            state.joined = true
            state.kicked = false
            state.roomName = snapshot.roomName
            state.members = snapshot.members
            state.agents = snapshot.agents
            state.queue = snapshot.executionQueue
            state.pendingInteractions = snapshot.pendingApprovals + snapshot.pendingClarifies
            state.summary = snapshot.summary ?? state.summary
            state.hasMore = snapshot.hasMore
            state.historyTruncated = snapshot.historyTruncated
            state.typingUsers = [:]
            for entry in snapshot.typingUsers { state.typingUsers[entry.userID] = entry.name }
            // Rejoin after a reconnect: keep messages that arrived before the
            // snapshot but merge in server order without duplicates.
            var merged = snapshot.messages
            for message in state.messages where !merged.contains(where: { $0.id == message.id }) { merged.append(message) }
            state.messages = merged.sorted { $0.timestamp < $1.timestamp }
        case let .joinFailed(error):
            state.joined = false
            state.connectionError = error
        case let .disconnected(error):
            state.connected = false
            state.joined = false
            state.connectionError = error
        case let .message(message):
            upsert(message, in: &state.messages, streaming: false)
        case let .streamStart(message):
            var incoming = message
            incoming.isStreaming = true
            // Drop empty streaming placeholders of the same sender.
            state.messages.removeAll { $0.isStreaming && $0.senderID == message.senderID && $0.id != message.id && $0.text.isEmpty && $0.reasoning.isEmpty && $0.toolCalls.isEmpty }
            if let index = state.messages.firstIndex(where: { $0.id == message.id }) {
                if state.messages[index].isStreaming {
                    if !incoming.text.isEmpty { state.messages[index].text = incoming.text }
                    if !incoming.reasoning.isEmpty { state.messages[index].reasoning = incoming.reasoning }
                    state.messages[index].runID = incoming.runID.nilIfEmpty ?? state.messages[index].runID
                    state.messages[index].isStreaming = true
                }
            } else {
                state.messages.append(incoming)
            }
        case let .streamDelta(id, delta):
            if let index = state.messages.firstIndex(where: { $0.id == id }) { state.messages[index].text += delta }
        case let .reasoningDelta(id, delta):
            if let index = state.messages.firstIndex(where: { $0.id == id }) { state.messages[index].reasoning += delta }
        case let .streamEnd(id):
            if let index = state.messages.firstIndex(where: { $0.id == id }) {
                let message = state.messages[index]
                if message.text.isEmpty && message.reasoning.isEmpty && message.toolCalls.isEmpty { state.messages.remove(at: index) }
                else { state.messages[index].isStreaming = false }
            }
        case let .membersUpdated(members):
            if !members.isEmpty { state.members = members }
        case .kicked:
            state.kicked = true
            state.joined = false
        case let .agentsUpdated(agents):
            state.agents = agents
        case let .typing(userID, name, active):
            guard userID != currentUserID else { return }
            if active { state.typingUsers[userID] = name.nilIfEmpty ?? userID } else { state.typingUsers.removeValue(forKey: userID) }
        case let .activity(activity):
            if activity.status == "ready" { state.activities.removeValue(forKey: activity.id) } else { state.activities[activity.id] = activity }
        case let .queueUpdated(items):
            state.queue = items.filter { $0.status == "queued" || $0.status == "running" }
        case let .messageRetracted(id):
            state.messages.removeAll { $0.id == id }
            state.queue.removeAll { $0.messageID == id }
        case let .summaryUpdated(summary):
            state.summary = summary
        case let .handoffUpdated(chain):
            state.handoffs.removeAll { $0.id == chain.id }
            if chain.canContinue { state.handoffs.append(chain) }
        case let .interactionRequested(pending):
            state.pendingInteractions.removeAll { $0.id == pending.id }
            state.pendingInteractions.append(pending)
        case let .interactionResolved(id):
            state.pendingInteractions.removeAll { $0.id == id }
        case let .roomUpdated(name, totalTokens):
            if let name { state.roomName = name }
            if let totalTokens { state.totalTokens = totalTokens }
        case .roomCleared:
            state.totalTokens = 0
            state.messages = []
            state.queue = []
            state.activities = [:]
        case let .contextStatus(agentName, status):
            if status == "ready" || status.isEmpty { state.contextStatuses.removeValue(forKey: agentName) } else { state.contextStatuses[agentName] = status }
        }
    }

    /// A persisted message replaces the streaming row with the same id; new
    /// ids append in arrival order.
    static func upsert(_ message: GroupMessage, in messages: inout [GroupMessage], streaming: Bool) {
        var final = message
        final.isStreaming = streaming
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            let existing = messages[index]
            if final.text.isEmpty && !existing.text.isEmpty && final.toolCalls.isEmpty { final.text = existing.text }
            if final.reasoning.isEmpty { final.reasoning = existing.reasoning }
            messages[index] = final
        } else {
            messages.append(final)
        }
    }

    /// Prepends an older history page (`load_messages` / `?before=`).
    static func prependHistory(_ older: [GroupMessage], hasMore: Bool, to state: inout GroupRoomState) {
        let existing = Set(state.messages.map(\.id))
        state.messages = older.filter { !existing.contains($0.id) } + state.messages
        state.hasMore = hasMore
    }
}

/// Converts room messages into the M3 `ChatLine` rows: human messages are
/// user rows (with the sender name), every agent run (assistant + tool
/// messages sharing a `run_id`) becomes one assistant row whose tools come
/// from `tool_calls` matched with `tool` messages (web
/// `groupAgentRunMessages` + `GroupAgentRunCard`).
/// One rendered row: the M3 line plus, for messages of other humans, the
/// member name (they render start-aligned with an initials avatar).
struct GroupLine: Identifiable, Equatable {
    var line: ChatLine
    var memberName: String?
    var agent: AgentAvatarAsset?
    var id: UUID { line.id }
}

enum GroupRunLines {
    static func lines(from messages: [GroupMessage], agents: [RoomAgent], currentUserID: String) -> [GroupLine] {
        var result: [GroupLine] = []
        var runIndex: [String: Int] = [:]
        for message in messages {
            if !message.isAgent || message.role == "user" {
                let isSelf = message.senderID == currentUserID
                result.append(GroupLine(line: userLine(message), memberName: isSelf ? nil : (message.senderName.nilIfEmpty ?? message.senderID), agent: nil))
                continue
            }
            let owner = message.senderAgentRecordID.nilIfEmpty ?? message.senderID
            let runKey = message.responseRunID.isEmpty ? "single:\(message.id)" : "\(owner)|\(message.responseRunID)"
            if let index = runIndex[runKey] {
                merge(message, into: &result[index].line)
            } else {
                var line = ChatLine(id: StableID.uuid("group-run:\(runKey)"), text: "", fromUser: false, timestamp: message.sentAt, sender: message.senderName.nilIfEmpty ?? agentLabel(message, agents: agents), isStreaming: message.isStreaming, remoteID: message.id)
                line.startedAt = message.sentAt
                merge(message, into: &line)
                runIndex[runKey] = result.count
                result.append(GroupLine(line: line, memberName: nil, agent: agentAsset(message, agents: agents)))
            }
        }
        return result
    }

    static func agentAsset(_ message: GroupMessage, agents: [RoomAgent]) -> AgentAvatarAsset {
        if let seat = agents.first(where: { $0.agentID == message.senderID || (!message.senderAgentRecordID.isEmpty && $0.id == message.senderAgentRecordID) }) { return seat.avatarAsset }
        let type = message.senderAgentType.nilIfEmpty ?? "hermes"
        return AgentAvatarAsset.resolve(runtime: type, source: type == "hermes" ? "cli" : "coding_agent")
    }

    /// Pending approvals/clarifications as interaction rows after the messages.
    static func interactionLines(_ pending: [GroupPendingInteraction]) -> [ChatLine] {
        pending.map { item in
            var interaction = item.interaction
            if !item.agentName.isEmpty && !interaction.prompt.contains(item.agentName) { interaction.prompt = "\(item.agentName): \(interaction.prompt)" }
            return ChatLine(id: StableID.uuid("group-interaction:\(item.id)"), interaction: interaction)
        }
    }

    private static func userLine(_ message: GroupMessage) -> ChatLine {
        ChatLine(id: StableID.uuid("group-user:\(message.id)"), text: message.text, fromUser: true, timestamp: message.sentAt, sender: message.senderName, attachments: message.attachments.map { ChatAttachmentRef(name: $0.name, path: $0.path.nilIfEmpty ?? $0.url, mime: $0.type) }, remoteID: message.id)
    }

    private static func agentLabel(_ message: GroupMessage, agents: [RoomAgent]) -> String {
        agents.first { $0.agentID == message.senderID || $0.id == message.senderAgentRecordID }?.name ?? AgentIdentity.displayName(for: message.senderAgentType)
    }

    /// Folds one run message into the run's line.
    static func merge(_ message: GroupMessage, into line: inout ChatLine) {
        if message.isStreaming { line.isStreaming = true }
        if !message.reasoning.isEmpty && !line.reasoning.contains(message.reasoning) {
            line.reasoning = line.reasoning.isEmpty ? message.reasoning : line.reasoning + "\n\n" + message.reasoning
            if line.thinkingStartedAt == nil { line.thinkingStartedAt = message.sentAt }
        }
        if message.isTool {
            let call = message.toolCallID
            if let index = line.tools.firstIndex(where: { $0.id == call && !call.isEmpty }) {
                line.tools[index].status = message.finishReason == "error" ? .error : .done
                line.tools[index].output = message.text.nilIfEmpty
                if line.tools[index].detail == nil { line.tools[index].detail = preview(message.text) }
                if let ended = message.sentAt { line.tools[index].duration = max(0, ended.timeIntervalSince(line.tools[index].startedAt)) }
            } else {
                var step = ToolStep(id: call.nilIfEmpty ?? message.id, name: message.toolName.nilIfEmpty ?? "tool", detail: preview(message.text), status: message.finishReason == "error" ? .error : .done, startedAt: message.sentAt ?? .now)
                step.output = message.text.nilIfEmpty
                line.tools.append(step)
            }
            return
        }
        for call in message.toolCalls where !line.tools.contains(where: { $0.id == call.id }) {
            var step = ToolStep(id: call.id, name: call.name.nilIfEmpty ?? "tool", detail: ToolEvent.detailText(["arguments": call.arguments]), status: message.isStreaming ? .running : .interrupted, startedAt: message.sentAt ?? .now)
            step.arguments = call.arguments.nilIfEmpty
            line.tools.append(step)
        }
        if !message.text.isEmpty {
            line.text = line.text.isEmpty ? message.text : line.text + "\n\n" + message.text
            line.remoteID = message.id
        }
        if !message.isStreaming, message.toolCalls.isEmpty, !message.text.isEmpty {
            line.finishedAt = message.sentAt
            if line.thinkingEndedAt == nil && !line.reasoning.isEmpty { line.thinkingEndedAt = message.sentAt }
        }
        if !line.tools.contains(where: { $0.status == .running }) && !message.isStreaming && !message.text.isEmpty {
            for index in line.tools.indices where line.tools[index].status == .interrupted { line.tools[index].status = .done }
        }
    }

    /// Short preview of a tool result: url / title / summary of a JSON
    /// payload, else the first 80 characters.
    static func preview(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let data = trimmed.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? JSON {
            if let value = json.string("url", "title", "preview", "summary").nilIfEmpty { return String(value.prefix(100)) }
        }
        return String(trimmed.replacingOccurrences(of: "\n", with: " ").prefix(80))
    }
}

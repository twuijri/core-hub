// A pure reducer from `/rt/rooms` events to one open room: its transcript (the contract's one
// `Message`, DECISIONS §1), its seats with what each is doing, its people with who is here now,
// who is typing, and what the seats wait for a person to answer. Nothing here touches a socket
// or a view, so the room is unit-tested on its own (RoomsTests).
import CoreHubClient
import Foundation

struct RoomState {
    var roomID: String
    var profile: String
    var name = ""
    var canManage = false
    var canMentionAll = false
    var inviteCode: String?
    var leadSeatID: String?
    var archived = false
    var seats: [Seat] = []
    var members: [Member] = []
    var messages: [Message] = []
    var approvals: [String: Approval] = [:]
    /// People typing now, by member id.
    var typing: [String: String] = [:]
    /// The tool a seat's run is in right now, by run id.
    var tools: [String: String] = [:]
    var hasOlder = false
    var deleted = false

    init(roomID: String, profile: String) {
        self.roomID = roomID
        self.profile = profile
    }

    /// The room and a page of its messages, as read over HTTP on open and after a reconnect;
    /// what arrived live while the page was on its way stays.
    mutating func hydrate(_ detail: RoomDetail, messages page: MessagePage) {
        name = detail.name
        profile = detail.profile
        canManage = detail.canManage
        canMentionAll = detail.canMentionAll
        inviteCode = detail.inviteCode
        leadSeatID = detail.leadSeatId
        archived = detail.archivedAt != nil
        seats = detail.seats
        members = detail.members
        approvals = Dictionary(
            detail.pendingApprovals.filter { $0.status == .pending }.map { ($0.id, $0) },
            uniquingKeysWith: { _, last in last }
        )
        typing = Dictionary(detail.typing.map { ($0.memberId, $0.name) }, uniquingKeysWith: { _, last in last })
        let newest = page.items.map(\.seq).max() ?? 0
        let fresh = Set(page.items.map(\.id))
        let newer = messages.filter { !fresh.contains($0.id) && $0.seq > newest }
        messages = (page.items + newer).sorted { $0.seq < $1.seq }
        hasOlder = page.hasMore
    }

    mutating func prependOlder(_ page: MessagePage) {
        let held = Set(messages.map(\.id))
        messages = (page.items.filter { !held.contains($0.id) } + messages).sorted { $0.seq < $1.seq }
        hasOlder = page.hasMore
    }

    /// Seats doing something now: queued, thinking, replying or waiting for a person.
    var busySeats: [Seat] { seats.filter { $0.status != .idle && $0.status != .offline } }

    var mentionSeats: [RoomMentions.Seat] { seats.map { RoomMentions.Seat(id: $0.id, name: $0.name) } }

    var pendingApprovals: [Approval] { approvals.values.sorted { $0.createdAt < $1.createdAt } }

    /// The tool a seat's live reply is in, when it reported one.
    func step(of seat: Seat) -> String? {
        guard let message = messages.last(where: { $0.status == .streaming && $0.author.name == seat.name }),
              let run = message.runId else { return nil }
        return tools[run]
    }

    mutating func apply(_ envelope: Envelope) {
        let d = HubJSON.decoder
        let data = envelope.payload
        let ours: (String?) -> Bool = { [roomID] in $0 == roomID }
        switch envelope.event {
        case "message.created":
            guard let box = try? d.decode(MessageBox.self, from: data), ours(box.message.roomId) else { return }
            upsert(box.message)
        case "message.delta", "reasoning.delta":
            guard let p = try? d.decode(DeltaBox.self, from: data) else { return }
            patch(p.message_id) { message in
                if envelope.event == "message.delta" {
                    message.appendText(p.delta)
                } else {
                    let text = (message.reasoning?.text ?? "") + p.delta
                    message.reasoning = Reasoning(text: text, durationMs: message.reasoning?.durationMs)
                    message.status = .streaming
                }
            }
        case "tool.started", "tool.completed", "tool.failed":
            guard let p = try? d.decode(ToolBox.self, from: data), messages.contains(where: { $0.id == p.message_id }) else { return }
            patch(p.message_id) { $0.upsertTool(p.tool_call) }
            tools[p.run_id] = envelope.event == "tool.started" ? p.tool_call.name : nil
        case "run.completed":
            guard let p = try? d.decode(RunCompletedBox.self, from: data) else { return }
            guard ours(p.run.roomId) || ours(p.message.roomId) else { return }
            end(p.run, as: .complete)
            if ours(p.message.roomId) { upsert(p.message) }
        case "run.failed", "run.cancelled":
            guard let p = try? d.decode(RunBox.self, from: data), ours(p.run.roomId) else { return }
            end(p.run, as: envelope.event == "run.failed" ? .failed : .interrupted)
        case "seat.added", "seat.updated":
            guard let p = try? d.decode(SeatBox.self, from: data), ours(p.room_id) else { return }
            if let index = seats.firstIndex(where: { $0.id == p.seat.id }) { seats[index] = p.seat } else { seats.append(p.seat) }
        case "seat.removed":
            guard let p = try? d.decode(SeatBox.self, from: data), ours(p.room_id) else { return }
            seats.removeAll { $0.id == p.seat.id }
        case "member.joined":
            guard let p = try? d.decode(MemberBox.self, from: data), ours(p.room_id) else { return }
            members.removeAll { $0.id == p.member.id }
            members.append(p.member)
        case "member.left":
            guard let p = try? d.decode(MemberBox.self, from: data), ours(p.room_id) else { return }
            members.removeAll { $0.id == p.member.id }
            typing[p.member.id] = nil
        case "member.typing":
            guard let p = try? d.decode(TypingBox.self, from: data), ours(p.room_id) else { return }
            typing[p.member_id] = p.typing ? p.name : nil
        case "room.updated":
            guard let p = try? d.decode(RoomBox.self, from: data), ours(p.room.id) else { return }
            name = p.room.name
            canManage = p.room.canManage
            canMentionAll = p.room.canMentionAll
            inviteCode = p.room.inviteCode
            leadSeatID = p.room.leadSeatId
            archived = p.room.archivedAt != nil
            seats = p.room.seats
        case "room.deleted":
            if let p = try? d.decode(RoomIDBox.self, from: data), ours(p.room_id) { deleted = true }
        case "approval.requested":
            guard let p = try? d.decode(ApprovalBox.self, from: data), ours(p.approval.roomId), p.approval.status == .pending else { return }
            approvals[p.approval.id] = p.approval
        case "approval.resolved":
            guard let p = try? d.decode(ApprovalBox.self, from: data) else { return }
            approvals[p.approval.id] = nil
        default:
            return
        }
    }

    private mutating func upsert(_ message: Message) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            // A `message.created` shell must not wipe words that already streamed into it.
            if message.status == .streaming, message.text.isEmpty, !messages[index].text.isEmpty { return }
            messages[index] = message
        } else {
            messages.append(message)
            messages.sort { $0.seq < $1.seq }
        }
    }

    /// A delta for a message this room does not hold (another room's) changes nothing.
    private mutating func patch(_ id: String, _ change: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
    }

    private mutating func end(_ run: Run, as status: MessageStatus) {
        tools[run.id] = nil
        for index in messages.indices where messages[index].runId == run.id && messages[index].status == .streaming {
            messages[index].status = status
        }
    }

    private struct MessageBox: Decodable { let message: Message }
    private struct DeltaBox: Decodable {
        let message_id: String
        let run_id: String
        let delta: String
    }
    private struct ToolBox: Decodable {
        let message_id: String
        let run_id: String
        let tool_call: ToolCall
    }
    private struct RunBox: Decodable { let run: Run }
    private struct RunCompletedBox: Decodable {
        let run: Run
        let message: Message
    }
    private struct SeatBox: Decodable {
        let room_id: String
        let seat: Seat
    }
    private struct MemberBox: Decodable {
        let room_id: String
        let member: Member
    }
    private struct TypingBox: Decodable {
        let room_id: String
        let member_id: String
        let name: String
        let typing: Bool
    }
    private struct RoomBox: Decodable { let room: Room }
    private struct RoomIDBox: Decodable { let room_id: String }
    private struct ApprovalBox: Decodable { let approval: Approval }
}

/// Every event name `/rt/rooms` carries.
enum RoomEvents {
    static let names: Set<String> = [
        "message.created", "message.delta", "reasoning.delta", "tool.started", "tool.completed", "tool.failed",
        "run.queued", "run.started", "run.completed", "run.failed", "run.cancelled",
        "seat.added", "seat.updated", "seat.removed", "member.joined", "member.left", "member.typing",
        "room.created", "room.updated", "room.deleted", "room.cleared", "memory.updated", "handoff.updated",
        "approval.requested", "approval.resolved",
    ]
}

/// Who a room message belongs to: only your own messages are on the right; everyone else —
/// people and agents — is on the left under their name (DECISIONS §69).
enum RoomTurns {
    static func isMine(_ message: Message, me: String?) -> Bool {
        (message.role == .user || message.role == .command) && me != nil && message.author.id == me
    }

    static func speaker(_ message: Message, me: String?) -> String {
        isMine(message, me: me) ? "me" : "\(message.author.kind.rawValue):\(message.author.id ?? message.author.name)"
    }

    static func startsTurn(_ messages: [Message], at index: Int, me: String?) -> Bool {
        guard index > 0 else { return true }
        return speaker(messages[index - 1], me: me) != speaker(messages[index], me: me)
    }
}

/// A room's invite as a link, and an invite code read out of whatever was pasted.
enum RoomLinks {
    /// `<hub>/join/<code>`: the one join address web and phones share (contract decision §23).
    static func join(hub: URL, code: String) -> String {
        var base = hub.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return base + "/join/" + code
    }

    /// The code in a pasted code or link (`…/join/AB12CD34`), upper-cased; `nil` when none.
    static func code(from input: String) -> String? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = text.range(of: "/join/", options: .backwards) { text = String(text[range.upperBound...]) }
        text = String(text.split(separator: "?", omittingEmptySubsequences: false).first ?? "")
        text = String(text.split(separator: "#", omittingEmptySubsequences: false).first ?? "")
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        let code = text.uppercased()
        guard (6...32).contains(code.count), code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        return code
    }
}

/// Pure rules of making a room.
enum NewRoom {
    /// One seat per chosen agent, named after it; a second seat of the same agent gets a number,
    /// because seat names are unique in a room (contract decision §23).
    static func seats(_ agents: [Agent]) -> [SeatConfig] {
        var used = Set<String>()
        return agents.map { agent in
            let base = agent.name.trimmingCharacters(in: .whitespaces).isEmpty ? agent.slug : agent.name.trimmingCharacters(in: .whitespaces)
            var name = base
            var n = 2
            while used.contains(name.lowercased()) || name.lowercased() == "all" {
                name = "\(base) \(n)"
                n += 1
            }
            used.insert(name.lowercased())
            return SeatConfig(agentId: agent.id, name: name)
        }
    }
}

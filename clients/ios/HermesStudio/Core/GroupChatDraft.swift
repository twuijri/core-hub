import Foundation

/// Everything `POST /api/studio/group-chat/rooms` needs, kept pure so the
/// create sheet stays a thin form (the server requires the `summary` block).
struct RoomCreateDraft: Equatable {
    var name = ""
    var inviteCode = RoomInviteLink.generateCode()
    var workspace = ""
    var memberName = ""
    var summaryProfile = ""
    var summaryProvider = ""
    var summaryModel = ""
    var summaryApiMode = ""
    var summaryEveryTurns = 10
    var agents: [RoomAgentInput] = []

    static let turnRange = 1...100

    /// `summary` object of the create body.
    var summaryBody: JSON {
        var body: JSON = ["profile": summaryProfile, "everyTurns": max(1, summaryEveryTurns)]
        if !summaryProvider.isEmpty { body["provider"] = summaryProvider }
        if !summaryModel.isEmpty { body["model"] = summaryModel }
        if !summaryApiMode.isEmpty { body["apiMode"] = summaryApiMode }
        return body
    }

    /// A room needs a name, an invite code and a summary profile; every agent
    /// seat must be valid and names must be unique (the server rejects
    /// duplicates and the reserved name `all`).
    var validationError: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Enter a room name.") }
        if inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).count < 4 { return String(localized: "The invite code needs at least 4 characters.") }
        if summaryProfile.isEmpty { return String(localized: "Choose the profile that writes the room summary.") }
        if agents.contains(where: { !$0.isValid }) { return String(localized: "Every agent needs a profile and a valid name.") }
        let names = agents.map { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
        if Set(names).count != names.count { return String(localized: "Agent names must be unique inside a room.") }
        return nil
    }

    var isValid: Bool { validationError == nil }
}

/// `PUT /rooms/{id}/config` body built from the room settings form.
struct RoomConfigDraft: Equatable {
    var name: String
    var summaryProfile: String
    var summaryProvider: String
    var summaryModel: String
    var summaryApiMode: String
    var summaryEveryTurns: Int
    var handoffEnabled: Bool
    var handoffUnlimited: Bool
    var handoffMaxDepth: Int

    init(room: Room) {
        name = room.name
        summaryProfile = room.summaryProfile
        summaryProvider = room.summaryProvider
        summaryModel = room.summaryModel
        summaryApiMode = room.summaryApiMode
        summaryEveryTurns = max(1, room.summaryEveryTurns)
        handoffEnabled = room.agentHandoffEnabled
        handoffUnlimited = room.agentHandoffUnlimited
        handoffMaxDepth = room.agentHandoffMaxDepth ?? 3
    }

    var body: JSON {
        var summary: JSON = ["profile": summaryProfile, "everyTurns": max(1, summaryEveryTurns)]
        if !summaryProvider.isEmpty { summary["provider"] = summaryProvider }
        if !summaryModel.isEmpty { summary["model"] = summaryModel }
        if !summaryApiMode.isEmpty { summary["apiMode"] = summaryApiMode }
        var handoff: JSON = ["enabled": handoffEnabled, "unlimited": handoffUnlimited]
        if !handoffUnlimited { handoff["maxDepth"] = max(1, handoffMaxDepth) }
        return ["name": name, "summary": summary, "agentHandoff": handoff]
    }
}

/// `@mention` support for the room composer. The client never sends the
/// structured `mentions` array (the server derives targets from the text for
/// human senders and rejects mismatched metadata); this only powers the
/// insert menu and the highlight of mentioned seats.
enum GroupMentions {
    /// Names the composer can offer: every agent seat plus `all` when the
    /// room allows it.
    static func suggestions(agents: [RoomAgent], canMentionAll: Bool) -> [String] {
        var names = agents.map(\.name).filter { !$0.isEmpty }
        if canMentionAll { names.insert("all", at: 0) }
        return names
    }

    /// Inserts `@name ` at the end of the draft, replacing a trailing partial
    /// `@token` the user already typed.
    static func insert(_ name: String, into text: String) -> String {
        var base = text
        if let range = base.range(of: "@[^\\s@]*$", options: .regularExpression) { base.removeSubrange(range) }
        if !base.isEmpty && !base.hasSuffix(" ") && !base.hasSuffix("\n") { base += " " }
        return base + "@" + name + " "
    }

    /// Seat names mentioned in the text (case-insensitive, word bounded).
    static func mentioned(in text: String, agents: [RoomAgent]) -> [String] {
        let lower = text.lowercased()
        return agents.map(\.name).filter { name in
            guard !name.isEmpty else { return false }
            return lower.contains("@" + name.lowercased())
        }
    }

    static func mentionsAll(_ text: String) -> Bool { text.lowercased().contains("@all") }
}

/// Human label for `room_agent_activity.status` and `context_status`.
enum GroupActivityLabel {
    static func text(for status: String) -> String {
        switch status {
        case "queued": return String(localized: "Queued")
        case "thinking", "running", "replying": return String(localized: "Replying…")
        case "compressing": return String(localized: "Compressing context…")
        case "waiting_approval": return String(localized: "Waiting for approval")
        case "ready", "": return String(localized: "Ready")
        default: return status
        }
    }
}

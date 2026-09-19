import Foundation

/// A group-chat room (`RoomInfo` in `packages/client/src/api/studio/group-chat.ts`).
struct Room: Identifiable, Hashable {
    let id: String
    var name: String
    var inviteCode: String
    var canManage: Bool
    var canMentionAll: Bool
    var ownerMemberID: String
    var summaryProfile: String
    var summaryProvider: String
    var summaryModel: String
    var summaryApiMode: String
    var summaryEveryTurns: Int
    var totalTokens: Int
    var workspace: String
    var agentHandoffEnabled: Bool
    var agentHandoffMaxDepth: Int?
    var agentHandoffUnlimited: Bool
    var createdAt: Int64
    var lastActiveAt: Int64
    /// `roomAgentSummaries` from the list endpoint (id, agentId, agent, name, avatar).
    var agents: [RoomAgent]
    var memberCount: Int

    init(_ json: JSON) {
        id = json.string("id", "roomId", "room_id")
        name = json.string("name", "title").nilIfEmpty ?? String(localized: "Group")
        inviteCode = json.string("inviteCode", "invite_code")
        canManage = json["canManage"] == nil ? true : json.bool("canManage")
        canMentionAll = json.bool("canMentionAll")
        ownerMemberID = json.string("ownerMemberId")
        summaryProfile = json.string("summaryProfile")
        summaryProvider = json.string("summaryProvider")
        summaryModel = json.string("summaryModel")
        summaryApiMode = json.string("summaryApiMode")
        summaryEveryTurns = json.int("summaryEveryTurns")
        totalTokens = json.int("totalTokens")
        workspace = json.string("workspace")
        agentHandoffEnabled = json.bool("agentHandoffEnabled")
        agentHandoffMaxDepth = json["agentHandoffMaxDepth"] is NSNull || json["agentHandoffMaxDepth"] == nil ? nil : json.int("agentHandoffMaxDepth")
        agentHandoffUnlimited = json.bool("agentHandoffUnlimited")
        createdAt = (json["createdAt"] as? NSNumber)?.int64Value ?? 0
        lastActiveAt = (json["lastActiveAt"] as? NSNumber)?.int64Value ?? 0
        agents = json.objects("agents").map(RoomAgent.init)
        memberCount = json.int("memberCount", default: json.int("member_count", default: json.objects("members").count))
    }

    var agentCount: Int { agents.count }
    var updatedAt: String? { lastActiveAt > 0 ? String(lastActiveAt) : nil }
}

/// An agent seat in a room (`RoomAgent`).
struct RoomAgent: Identifiable, Hashable {
    let id: String
    var roomID: String
    var agentID: String
    /// `hermes | ekko | codex | claude | pi | grok | opencode | dsh`
    var agent: String
    var agentMode: String
    var profile: String
    var provider: String
    var model: String
    var apiMode: String
    var agentPreset: String
    var reasoningEffort: String
    var name: String
    var description: String
    var avatar: String
    var invited: Bool
    var executorType: String
    var remoteOrigin: String
    var connectionStatus: String
    var ownerMemberID: String

    init(_ json: JSON) {
        id = json.string("id").nilIfEmpty ?? json.string("agentId")
        roomID = json.string("roomId")
        agentID = json.string("agentId").nilIfEmpty ?? id
        agent = json.string("agent").nilIfEmpty ?? "hermes"
        agentMode = json.string("agentMode").nilIfEmpty ?? "scoped"
        profile = json.string("profile")
        provider = json.string("provider")
        model = json.string("model")
        apiMode = json.string("apiMode")
        agentPreset = json.string("agentPreset")
        reasoningEffort = json.string("reasoningEffort")
        name = json.string("name").nilIfEmpty ?? profile.nilIfEmpty ?? agent
        description = json.string("description")
        avatar = json.string("avatar")
        invited = json["invited"] == nil ? true : json.bool("invited")
        executorType = json.string("executorType").nilIfEmpty ?? "server"
        remoteOrigin = json.string("remoteOrigin")
        connectionStatus = json.string("connectionStatus")
        ownerMemberID = json.string("ownerMemberId")
    }

    var isRemote: Bool { executorType == "remote" }
    var avatarAsset: AgentAvatarAsset { AgentAvatarAsset.resolve(runtime: agent, source: agent == "hermes" ? "cli" : "coding_agent") }
}

/// Fields sent when adding or editing a room agent (`RoomAgentInput`).
struct RoomAgentInput: Equatable {
    var presetID = ""
    var agent = "hermes"
    var agentMode = "scoped"
    var profile = ""
    var provider = ""
    var model = ""
    var apiMode = ""
    var agentPreset = ""
    var reasoningEffort = ""
    var name = ""
    var description = ""
    var avatar = ""

    static let agentTypes = ["hermes", "ekko", "claude", "codex", "pi", "grok", "opencode", "dsh"]
    /// Global mode is only allowed for Claude, Codex, Pi and Grok (server rule).
    static let globalCapable: Set<String> = ["claude", "codex", "pi", "grok"]

    init() {}

    init(seat: RoomAgent) {
        agent = seat.agent
        agentMode = seat.agentMode
        profile = seat.profile
        provider = seat.provider
        model = seat.model
        apiMode = seat.apiMode
        agentPreset = seat.agentPreset
        reasoningEffort = seat.reasoningEffort
        name = seat.name
        description = seat.description
        avatar = seat.avatar
    }

    init(preset: GroupAgentPreset) {
        presetID = preset.id
        agent = preset.agent
        agentMode = preset.agentMode
        profile = preset.profile
        provider = preset.provider
        model = preset.model
        apiMode = preset.agent == "hermes" || preset.agentMode == "global" ? "" : preset.apiMode
        agentPreset = preset.agentPreset
        reasoningEffort = preset.reasoningEffort
        name = preset.name
        description = preset.description
        avatar = preset.avatar
    }

    /// JSON body for `POST/PUT /rooms/{roomId}/agents[/{agentId}]`. Empty
    /// optional strings are omitted; `provider` and `model` travel together.
    var body: JSON {
        var json: JSON = ["agent": agent, "profile": profile, "agentMode": agentMode]
        if !presetID.isEmpty { json["presetId"] = presetID }
        if !provider.isEmpty && !model.isEmpty { json["provider"] = provider; json["model"] = model }
        if !apiMode.isEmpty && agent != "hermes" && agentMode != "global" { json["apiMode"] = apiMode }
        if !agentPreset.isEmpty { json["agentPreset"] = agentPreset }
        if !reasoningEffort.isEmpty { json["reasoningEffort"] = reasoningEffort }
        if !name.isEmpty { json["name"] = name }
        if !description.isEmpty { json["description"] = description }
        if !avatar.isEmpty { json["avatar"] = avatar }
        return json
    }

    var isValid: Bool {
        guard !profile.isEmpty, RoomAgentInput.agentTypes.contains(agent) else { return false }
        if agentMode == "global" && !RoomAgentInput.globalCapable.contains(agent) { return false }
        if name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "all" { return false }
        return true
    }
}

/// A saved agent preset (`GroupAgentPreset`).
struct GroupAgentPreset: Identifiable, Hashable {
    let id: String
    var name: String
    var description: String
    var avatar: String
    var agent: String
    var agentMode: String
    var profile: String
    var provider: String
    var model: String
    var apiMode: String
    var agentPreset: String
    var reasoningEffort: String
    var available: Bool
    var validationError: String

    init(_ json: JSON) {
        id = json.string("id")
        name = json.string("name")
        description = json.string("description")
        avatar = json.string("avatar")
        agent = json.string("agent").nilIfEmpty ?? "hermes"
        agentMode = json.string("agentMode").nilIfEmpty ?? "scoped"
        profile = json.string("profile")
        provider = json.string("provider")
        model = json.string("model")
        apiMode = json.string("apiMode")
        agentPreset = json.string("agentPreset")
        reasoningEffort = json.string("reasoningEffort")
        available = json["available"] == nil ? true : json.bool("available")
        validationError = json.string("validationError")
    }
}

/// A human member of a room (`MemberInfo`).
struct RoomMember: Identifiable, Hashable {
    let id: String
    var userID: String
    var name: String
    var description: String
    var joinedAt: Int64
    var avatar: String
    var online: Bool

    init(_ json: JSON) {
        id = json.string("id").nilIfEmpty ?? json.string("userId")
        userID = json.string("userId").nilIfEmpty ?? id
        name = json.string("name")
        description = json.string("description")
        joinedAt = (json["joinedAt"] as? NSNumber)?.int64Value ?? 0
        avatar = json.string("avatar")
        online = json.string("connectionStatus") == "online" || json.bool("online")
    }
}

/// One attachment on a group message (`ChatMessage.attachments[]`).
struct GroupAttachment: Hashable {
    let id: String
    let name: String
    let type: String
    let size: Int
    let url: String
    let path: String

    init(_ json: JSON) {
        id = json.string("id").nilIfEmpty ?? json.string("name")
        name = json.string("name")
        type = json.string("type", "media_type")
        size = json.int("size")
        url = json.string("url")
        path = json.string("path")
    }

    init(name: String, type: String, path: String) {
        id = name; self.name = name; self.type = type; size = 0; url = ""; self.path = path
    }
}

/// One entry of an assistant message's `tool_calls[]`.
struct GroupToolCall: Hashable {
    let id: String
    let name: String
    let arguments: String

    init(_ json: JSON) {
        id = json.string("id")
        let function = json.object("function")
        name = function.string("name").nilIfEmpty ?? json.string("name")
        if let text = function["arguments"] as? String { arguments = text }
        else if let object = function["arguments"], JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) { arguments = String(data: data, encoding: .utf8) ?? "" }
        else { arguments = "" }
    }
}

/// A persisted or streaming group message (`ChatMessage` of the group-chat
/// namespace). `content` may be a plain string or a JSON array of content
/// blocks (`text` / `image` / `file`) when the sender attached files.
struct GroupMessage: Identifiable, Hashable {
    let id: String
    var roomID: String
    var senderID: String
    var senderName: String
    var senderType: String
    var senderAgentRecordID: String
    var senderAvatar: String
    var senderAgentType: String
    var senderAgentProfile: String
    var role: String
    var text: String
    var attachments: [GroupAttachment]
    var timestamp: Int64
    var runID: String
    var toolCallID: String
    var toolName: String
    var toolCalls: [GroupToolCall]
    var finishReason: String
    var reasoning: String
    var mentionDepth: Int
    var handoffChainID: String
    var isStreaming: Bool

    init(_ json: JSON) {
        id = json.string("id").nilIfEmpty ?? UUID().uuidString
        roomID = json.string("roomId", "room_id")
        senderID = json.string("senderId", "sender_id")
        senderName = json.string("senderName", "sender_name", "name")
        senderType = json.string("senderType")
        senderAgentRecordID = json.string("senderAgentRecordId")
        senderAvatar = json.string("senderAvatar")
        senderAgentType = json.string("senderAgentType")
        senderAgentProfile = json.string("senderAgentProfile")
        role = json.string("role").nilIfEmpty ?? (json.bool("isAgent") ? "assistant" : "user")
        let parsed = GroupMessage.parseContent(json["content"])
        text = parsed.text
        var files = parsed.files
        files += json.objects("attachments").map(GroupAttachment.init)
        attachments = files
        timestamp = (json["timestamp"] as? NSNumber)?.int64Value ?? Int64(json.string("timestamp")) ?? 0
        runID = json.string("run_id", "runId")
        toolCallID = json.string("tool_call_id", "toolCallId")
        toolName = json.string("tool_name", "toolName")
        toolCalls = json.objects("tool_calls").map(GroupToolCall.init).filter { !$0.id.isEmpty || !$0.name.isEmpty }
        finishReason = json.string("finish_reason")
        reasoning = json.string("reasoning").nilIfEmpty ?? json.string("reasoning_content")
        mentionDepth = json.int("mentionDepth")
        handoffChainID = json.string("handoffChainId")
        isStreaming = json.bool("isStreaming") || json.string("finish_reason") == "streaming"
    }

    /// Text and file blocks from a string or block-array content.
    static func parseContent(_ raw: Any?) -> (text: String, files: [GroupAttachment]) {
        var blocks: [JSON] = []
        if let array = raw as? [Any] { blocks = array.objects }
        else if let string = raw as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("[") , let data = trimmed.data(using: .utf8), let array = try? JSONSerialization.jsonObject(with: data) as? [Any] {
                blocks = array.objects
            } else {
                return (string, [])
            }
        } else { return ("", []) }
        var texts: [String] = []
        var files: [GroupAttachment] = []
        for block in blocks {
            let type = block.string("type")
            if type == "text" { if let value = block.string("text").nilIfEmpty { texts.append(value) } }
            else if type == "image" || type == "file" {
                files.append(GroupAttachment(name: block.string("name").nilIfEmpty ?? URL(fileURLWithPath: block.string("path")).lastPathComponent, type: block.string("media_type", "mime"), path: block.string("path")))
            }
        }
        return (texts.joined(separator: "\n"), files)
    }

    var isAgent: Bool { role == "assistant" || role == "tool" || senderType == "agent" }
    var isTool: Bool { role == "tool" }
    var sentAt: Date? { timestamp > 0 ? StudioTimestamp.date(from: String(timestamp)) : nil }
    /// Stable run identity shared by every message of one agent reply.
    var responseRunID: String { runID.nilIfEmpty ?? "" }
}

/// `room_agent_activity` (compressing / replying / ready).
struct GroupAgentActivity: Identifiable, Hashable {
    var id: String { "\(agentID)|\(runID)" }
    let roomID: String
    let agentID: String
    let runID: String
    let agentName: String
    let agent: String
    let avatar: String
    let status: String

    init(_ json: JSON) {
        roomID = json.string("roomId"); agentID = json.string("agentId"); runID = json.string("runId")
        agentName = json.string("agentName"); agent = json.string("agent"); avatar = json.string("avatar"); status = json.string("status")
    }
}

/// `execution_queue_updated.items[]`.
struct GroupQueueItem: Identifiable, Hashable {
    let id: String
    let roomID: String
    let messageID: String
    let targetAgentID: String
    let targetAgentName: String
    let requesterMemberID: String
    let textSummary: String
    let position: Int
    let status: String

    init(_ json: JSON) {
        id = json.string("id"); roomID = json.string("roomId"); messageID = json.string("messageId")
        targetAgentID = json.string("targetAgentId"); targetAgentName = json.string("targetAgentName")
        requesterMemberID = json.string("requesterMemberId"); textSummary = json.string("textSummary")
        position = json.int("position", default: json.int("sequence")); status = json.string("status").nilIfEmpty ?? "queued"
    }
}

/// `GET /rooms/{roomId}/summary` and `room_summary_updated`.
struct RoomSummaryState: Hashable {
    var roomID: String
    var summary: String
    var status: String
    var summarizedTurnCount: Int
    var updatedAt: Int64
    var lastError: String
    var anchorText: String

    init(_ json: JSON, anchor: JSON = [:]) {
        roomID = json.string("roomId")
        summary = json.string("summary")
        status = json.string("status").nilIfEmpty ?? "idle"
        summarizedTurnCount = json.int("summarizedTurnCount")
        updatedAt = (json["updatedAt"] as? NSNumber)?.int64Value ?? 0
        lastError = json.string("lastError")
        anchorText = anchor.string("content")
    }
}

/// A stopped agent-handoff chain (`RoomAgentHandoffChain`).
struct HandoffChain: Identifiable, Hashable {
    let id: String
    let roomID: String
    let currentDepth: Int
    let maxDepth: Int?
    let unlimited: Bool
    let targetAgentID: String
    let status: String
    let stopReason: String
    let continueUsed: Bool
    let lastError: String

    init(_ json: JSON) {
        id = json.string("chainId", "id"); roomID = json.string("roomId")
        currentDepth = json.int("currentDepth")
        maxDepth = json["maxDepth"] == nil || json["maxDepth"] is NSNull ? nil : json.int("maxDepth")
        unlimited = json.bool("unlimited"); targetAgentID = json.string("targetAgentId")
        status = json.string("status"); stopReason = json.string("stopReason")
        continueUsed = json.bool("continueUsed"); lastError = json.string("lastError")
    }

    var canContinue: Bool { status == "stopped" && !continueUsed }
}

/// A pending approval or clarification raised by a room agent.
struct GroupPendingInteraction: Identifiable, Hashable {
    var id: String { interaction.id }
    let roomID: String
    let agentName: String
    var interaction: ChatInteraction

    init(event: String, payload: JSON) {
        roomID = payload.string("roomId")
        agentName = payload.string("agentName")
        interaction = ChatInteraction(event: event, payload: payload)
    }
}

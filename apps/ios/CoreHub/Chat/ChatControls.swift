// The chat's controls (apps batch 1), from the same contract operations as the web's composer and
// conversation menu: the model chip (`models.listCatalogue`, `sessions.update`), the approvals chip
// (the agent's own `approval_mode` / `approvals_mode` setting, `agents.getSettings` /
// `agents.updateSettings`), a new chat's working folder (`sessions.listWorkingDirs`), and the
// actions on one chat and one message (`sessions.update`, `.delete`, `.fork`, `.compress`,
// `.steerRun`). The rules are plain functions, tested in ChatControlsTests; Android's
// `chat/ChatControls.kt` is their twin.
import CoreHubClient
import Foundation
import Observation

enum ChatControls {
    // MARK: - Model

    /// One model the composer offers: `value` is the catalogue's `key` (`<provider>/<model>`),
    /// which is what a session stores; the alias reads, the provider groups.
    struct ModelOption: Equatable, Identifiable {
        let value: String
        let label: String
        let group: String
        /// The catalogue's `context_window`, for the context ring's estimate (apps batch 6).
        var window: Int? = nil
        /// The agent's context floor this model is under (`Agent.gateway_min_context`, §141): the
        /// picker says «small context». `nil`: big enough, or not known.
        var smallUnder: Int? = nil
        var id: String { value }
    }

    /// The chat models this profile can run, as the web's composer offers them. A coding agent on
    /// the hub's models (`gatewayOnly`, ADR 0029) is offered only what the hub's model gateway can
    /// serve it (`Model.agent_gateway`) — a subscription signed in to through Hermes is not lent —
    /// and not a model its provider says cannot call tools (`Model.agent_tools`, §141); a model
    /// under the agent's context floor (`minContext`) is marked.
    static func models(_ catalogue: [Model], gatewayOnly: Bool = false, minContext: Int? = nil) -> [ModelOption] {
        let floor = gatewayOnly ? minContext : nil
        return catalogue
            .filter { $0.kind == .chat && $0.imageOnly != true && $0.visible && !$0.disabled }
            .filter { !gatewayOnly || ($0.agentGateway == true && $0.agentTools != false) }
            .map { (model: Model) -> ModelOption in
                var small: Int?
                if let floor, let window = model.contextWindow, window < floor { small = floor }
                return ModelOption(value: model.key, label: model.alias ?? model.model, group: model.provider, window: model.contextWindow, smallUnder: small)
            }
    }

    /// Whether a coding agent runs on the hub's models in this profile (`Agent.model_source`,
    /// DECISIONS §140). An older hub says nothing: the whole catalogue, as before.
    static func gatewayOnly(_ agent: Agent?) -> Bool {
        guard let agent else { return false }
        return agent.kind == .acp && agent.modelSource == "hub"
    }

    /// Which model «Default» is, as the web names it: a coding agent on its own account runs on
    /// the model its own settings name (`agent_default_model`); Hermes, the hub's own agent and a
    /// coding agent on the hub's models run on the profile's default (`default_model`), by the
    /// catalogue's label. `nil` when the hub does not say: the plain «Default model».
    static func defaultModelName(_ agent: Agent?, _ options: [ModelOption]) -> String? {
        guard let agent else { return nil }
        if agent.kind == .acp && agent.modelSource != "hub" {
            guard let own = agent.agentDefaultModel, !own.isEmpty else { return nil }
            return own
        }
        guard let ref = agent.defaultModel, !ref.model.isEmpty else { return nil }
        let option = options.first { $0.value == ref.model || $0.value.hasSuffix("/\(ref.model)") }
        return option?.label ?? ref.model
    }

    /// The agent card's line on where its model calls go (`hub` / `agent`); `nil` hides it — an
    /// agent the gateway does not wire, or an older hub.
    static func modelSourceKey(_ agent: Agent) -> String? {
        switch agent.modelSource {
        case "hub": return "agents.model_source.hub"
        case "agent": return "agents.model_source.agent"
        default: return nil
        }
    }

    /// The options matching what was typed, in the label, the id or the provider; case does not matter.
    static func filter(_ options: [ModelOption], _ query: String) -> [ModelOption] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return options }
        return options.filter {
            $0.label.lowercased().contains(q) || $0.value.lowercased().contains(q) || $0.group.lowercased().contains(q)
        }
    }

    /// The options by provider, in the order the providers first appear.
    static func groups(_ options: [ModelOption]) -> [(group: String, options: [ModelOption])] {
        var order: [String] = []
        var byGroup: [String: [ModelOption]] = [:]
        for option in options {
            if byGroup[option.group] == nil { order.append(option.group) }
            byGroup[option.group, default: []].append(option)
        }
        return order.map { ($0, byGroup[$0] ?? []) }
    }

    /// The chip's words for the chat's model: its alias when the catalogue has it, else the part
    /// after the provider; `nil` is the agent's default.
    static func modelLabel(_ value: String?, _ options: [ModelOption]) -> String? {
        guard let value, !value.isEmpty else { return nil }
        if let match = options.first(where: { $0.value == value }) { return match.label }
        return value.split(separator: "/", maxSplits: 1).last.map(String.init) ?? value
    }

    // MARK: - Approvals

    /// The approval field, whatever the adapter calls it: ACP adapters declare `approval_mode`,
    /// Hermes `approvals_mode`. The client shows the options the descriptor declares.
    static let approvalKeys = ["approval_mode", "approvals_mode"]

    struct ApprovalField: Equatable {
        let section: String
        let key: String
        let value: String
        let options: [Choice]
    }

    static func approval(_ sections: [SettingsSection]) -> ApprovalField? {
        for section in sections {
            for field in section.fields where approvalKeys.contains(field.key) {
                // Nothing written is the agent's own default (Hermes: `smart`), not the first option.
                let value = string(field.value) ?? string(field._default) ?? field.options.first?.value ?? "ask"
                return ApprovalField(section: section.key, key: field.key, value: value, options: field.options)
            }
        }
        return nil
    }

    /// Modes that give something away wear the warning mark.
    static func risky(_ mode: String) -> Bool { ["auto_all", "off", "auto_safe", "smart"].contains(mode) }

    private static func string(_ value: JSONValue?) -> String? {
        if case .string(let text)? = value { return text }
        return nil
    }

    // MARK: - Working folder

    /// The part of a path worth reading on a chip: the folder under the root, or its last name.
    static func shortDir(_ full: String?, root: String?) -> String? {
        guard let full, !full.isEmpty else { return nil }
        if let root, !root.isEmpty, full.hasPrefix(root) {
            let rest = full.dropFirst(root.count).drop { $0 == "/" || $0 == "\\" }
            return rest.isEmpty ? "." : String(rest)
        }
        return full.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? full
    }

    /// A folder the hub generated is named by a ULID: the chip says «Automatic folder» instead.
    static func isGenerated(_ name: String) -> Bool {
        name.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil
    }

    /// The folder as a person reads it, or `nil` for the automatic one.
    static func folderName(_ value: String?, root: String?) -> String? {
        guard let short = shortDir(value, root: root), !isGenerated(short) else { return nil }
        return short
    }

    /// A new folder the person named: one name inside the hub's root, never a path (the hub
    /// refuses anything outside the root; this keeps the obvious mistakes on the phone).
    static func newFolder(_ typed: String) -> String? {
        let name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\") else { return nil }
        return name
    }

    // MARK: - One chat

    /// What a rename sends: the trimmed title, at most 200 characters; empty is not a title.
    static func renameTitle(_ typed: String) -> String? {
        let title = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : String(title.prefix(200))
    }

    /// What «Default model» sends: `model: null` (contract decision §114); a model is sent by its key.
    static func modelPatch(_ value: String?) -> SessionPatch {
        guard let value else { return SessionPatch(sendNull: [.model]) }
        return SessionPatch(model: value)
    }

    enum Action: String, CaseIterable {
        case rename, autoTitle, pin, unpin, archive, unarchive, fork, compress, export, delete
    }

    /// The chat's own menu, in order. The global agent's conversation is not a chat of the list
    /// (DECISIONS §46): it is never renamed, pinned, archived, forked or deleted from here. A chat
    /// with a title can give the naming back to the hub (`.autoTitle`).
    static func actions(pinned: Bool, archived: Bool, globalAgent: Bool, canCompress: Bool, canExport: Bool = true, titled: Bool = false) -> [Action] {
        var list: [Action] = []
        if !globalAgent {
            list.append(.rename)
            if titled { list.append(.autoTitle) }
            list.append(pinned ? .unpin : .pin)
            list.append(archived ? .unarchive : .archive)
            list.append(.fork)
        }
        if canCompress { list.append(.compress) }
        if canExport { list.append(.export) }
        if !globalAgent { list.append(.delete) }
        return list
    }

    /// The patch an action sends (the other fields stay out: a merge-patch changes only what it names).
    /// «Name it automatically» sends `title: null`: the hub renames the chat from its first turn (§26).
    static func patch(_ action: Action) -> SessionPatch? {
        switch action {
        case .autoTitle: return SessionPatch(sendNull: [.title])
        case .pin: return SessionPatch(pinned: true)
        case .unpin: return SessionPatch(pinned: false)
        case .archive: return SessionPatch(archived: true)
        case .unarchive: return SessionPatch(archived: false)
        default: return nil
        }
    }

    // MARK: - Compress and steer

    enum Compression: Equatable {
        case compressed(before: Int?, after: Int?)
        case unchanged
        case skipped
    }

    static func compression(_ result: SessionCompression) -> Compression {
        switch result.status {
        case .compressed: return .compressed(before: result.beforeTokens, after: result.afterTokens)
        case .unchanged: return .unchanged
        case .skipped: return .skipped
        }
    }

    /// The line the chat shows after compressing (the key and its values).
    static func compressionText(_ outcome: Compression) -> (key: String, params: [String: String]) {
        switch outcome {
        case .compressed(let before?, let after?):
            return ("chat_controls.compressed", ["before": String(before), "after": String(after)])
        case .compressed:
            return ("chat_controls.compressed_plain", [:])
        case .unchanged:
            return ("chat_controls.compress_unchanged", [:])
        case .skipped:
            return ("chat_controls.compress_skipped", [:])
        }
    }

    /// Steering is offered while a reply runs, to an agent that can take it, with words typed.
    static func canSteer(running: Bool, text: String, capabilities: [AgentCapability]) -> Bool {
        running && capabilities.contains(.steer) && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// The calls behind the controls, each in the chat's own profile.
@MainActor
enum ChatActions {
    static func update(_ app: AppModel, id: String, profile: String, _ patch: SessionPatch) async throws -> Session {
        try await app.api.call {
            try await SessionsAPI.sessionsUpdate(xHubProfile: profile, sessionId: id, sessionPatch: patch, apiConfiguration: $0)
        }
    }

    static func delete(_ app: AppModel, id: String, profile: String) async throws {
        try await app.api.call {
            try await SessionsAPI.sessionsDelete(xHubProfile: profile, sessionId: id, apiConfiguration: $0)
        }
    }

    /// A new chat with the transcript up to `message` (the whole one when nil); the original stays.
    static func fork(_ app: AppModel, id: String, profile: String, at message: String? = nil) async throws -> Session {
        try await app.api.call {
            try await SessionsAPI.sessionsFork(
                xHubProfile: profile, sessionId: id, sessionForkRequest: SessionForkRequest(atMessageId: message), apiConfiguration: $0
            )
        }
    }

    /// `focus` is what the summary should keep in view (apps batch 6: `ChatInsight.compressRequest`).
    static func compress(_ app: AppModel, id: String, profile: String, focus: String = "") async throws -> SessionCompression {
        let request = ChatInsight.compressRequest(focus: focus)
        return try await app.api.call {
            try await SessionsAPI.sessionsCompress(xHubProfile: profile, sessionId: id, sessionCompressRequest: request, apiConfiguration: $0)
        }
    }

    static func steer(_ app: AppModel, id: String, profile: String, run: String, text: String) async throws -> RunSteerResult {
        try await app.api.call {
            try await SessionsAPI.sessionsSteerRun(
                xHubProfile: profile, sessionId: id, runId: run, runSteerRequest: RunSteerRequest(text: text), apiConfiguration: $0
            )
        }
    }
}

/// What the composer's chips read: the profile's chat models, the agent's approval mode, and (a
/// new chat only) the folders it may work in. Loaded once per profile and agent.
@MainActor
@Observable
final class ChatControlsModel {
    enum ApprovalState: Equatable {
        case loading
        case ready(ChatControls.ApprovalField)
        /// The agent declares no approval mode: the chip is not drawn.
        case unsupported
    }

    private(set) var models: [ChatControls.ModelOption] = []
    private(set) var modelsLoaded = false
    /// The chat's agent in this profile: which models its picker offers, and what «Default» is.
    private(set) var agent: Agent?
    /// Which model «Default» is, when the hub says (`nil`: the plain «Default model»).
    var defaultModelName: String? { ChatControls.defaultModelName(agent, models) }
    private(set) var approval: ApprovalState = .loading
    private(set) var dirs: WorkingDirs?
    private(set) var dirsError: String?
    var error: String?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var loadedKey: String?
    /// The catalogue of each profile, so a chat opens with its chips already filled.
    @ObservationIgnored private static var catalogues: [String: [Model]] = [:]
    @ObservationIgnored private var catalogue: [Model]?
    /// 200 models a page, ten pages at most: far past any provider's list (as the web).
    private static let pageSize = 200
    private static let maxPages = 10

    init(app: AppModel) {
        self.app = app
    }

    func load(profile: String, agentID: String?, folders: Bool = false) {
        let key = "\(profile)|\(agentID ?? "")|\(folders)"
        guard key != loadedKey, let app else { return }
        loadedKey = key
        agent = nil
        catalogue = nil
        if let cached = Self.catalogues[profile] {
            catalogue = cached
            refreshModels()
            modelsLoaded = true
        }
        Task {
            var all: [Model] = []
            var cursor: String?
            do {
                for _ in 0..<Self.maxPages {
                    let current = cursor
                    let page = try await app.api.call {
                        try await ModelsAPI.modelsListCatalogue(xHubProfile: profile, cursor: current, limit: Self.pageSize, apiConfiguration: $0)
                    }
                    all += page.items
                    cursor = page.nextCursor
                    if cursor == nil { break }
                }
                Self.catalogues[profile] = all
                catalogue = all
                refreshModels()
            } catch {
                // The chip stays on the chat's own model; the picker says the list is empty.
            }
            modelsLoaded = true
        }
        loadApproval(profile: profile, agentID: agentID)
        loadAgent(profile: profile, agentID: agentID)
        if folders { loadDirs(profile: profile) }
    }

    /// The options for this agent: the gateway's models for a coding agent on the hub's models.
    private func refreshModels() {
        guard let catalogue else { return }
        models = ChatControls.models(catalogue, gatewayOnly: ChatControls.gatewayOnly(agent), minContext: agent?.gatewayMinContext)
    }

    private func loadAgent(profile: String, agentID: String?) {
        guard let app, let agentID else { return }
        Task {
            // Without it the picker offers the whole catalogue, as before (an older hub, an error).
            if let found = try? await app.api.call({
                try await AgentsAPI.agentsGet(xHubProfile: profile, agentId: agentID, apiConfiguration: $0)
            }) {
                agent = found
                refreshModels()
            }
        }
    }

    private func loadApproval(profile: String, agentID: String?) {
        guard let app, let agentID else {
            approval = .unsupported
            return
        }
        approval = .loading
        Task {
            do {
                let settings = try await app.api.call {
                    try await AgentsAPI.agentsGetSettings(xHubProfile: profile, agentId: agentID, apiConfiguration: $0)
                }
                approval = ChatControls.approval(settings.sections).map(ApprovalState.ready) ?? .unsupported
            } catch {
                approval = .unsupported
            }
        }
    }

    private func loadDirs(profile: String) {
        guard let app else { return }
        Task {
            do {
                dirs = try await app.api.call { try await SessionsAPI.sessionsListWorkingDirs(xHubProfile: profile, apiConfiguration: $0) }
                dirsError = nil
            } catch {
                dirsError = HubFailure(error).describe(app.l10n)
            }
        }
    }

    /// Writes the agent's approval mode (admin); the chip follows once the hub has it.
    func setApproval(_ value: String, profile: String, agentID: String) async {
        guard let app, case .ready(let field) = approval, value != field.value else { return }
        do {
            _ = try await app.api.call {
                try await AgentsAPI.agentsUpdateSettings(
                    xHubProfile: profile, agentId: agentID,
                    agentSettingsPatch: AgentSettingsPatch(section: field.section, values: [field.key: .string(value)]),
                    apiConfiguration: $0
                )
            }
            approval = .ready(ChatControls.ApprovalField(section: field.section, key: field.key, value: value, options: field.options))
            error = nil
        } catch {
            self.error = HubFailure(error).describe(app.l10n)
        }
    }
}

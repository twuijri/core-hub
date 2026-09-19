import Foundation
import UniformTypeIdentifiers

enum HermesError: LocalizedError {
    case invalidServer
    case http(Int, String)
    case malformedResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidServer: String(localized: "Enter a valid Studio address")
        case let .http(code, detail): detail.isEmpty ? "HTTP \(code)" : "HTTP \(code): \(detail)"
        case .malformedResponse: String(localized: "The Studio returned an unreadable response")
        case let .server(message): message
        }
    }
}

final class APIClient: @unchecked Sendable {
    private(set) var baseURL: String
    private(set) var token: String
    private let session: URLSession

    /// Installed by `AppStore` for QR-paired connections. Called once after a
    /// 401 so the original request can be retried with a fresh app token.
    /// Returns the new token, or `nil` when no refresh is possible.
    var tokenRefresher: (@Sendable () async -> String?)?

    /// Profile sent as `X-Hermes-Profile` when a call does not name one, so
    /// every Studio request is scoped like the web client's axios default.
    /// `AppStore` keeps it in step with the selected profile.
    var activeProfile = ""

    /// Paths that must never trigger a silent refresh (they are the auth
    /// endpoints themselves).
    private static let authPaths = ["/api/auth/login", "/api/auth/app-login", "/api/auth/app-refresh"]

    init(baseURL: String = "", token: String = "") {
        self.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.token = token
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 300
        configuration.waitsForConnectivity = true
        self.session = URLSession(configuration: configuration)
    }

    func update(baseURL: String, token: String) {
        self.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.token = token
    }

    func url(_ path: String) throws -> URL {
        guard let url = URL(string: baseURL + path) else { throw HermesError.invalidServer }
        return url
    }

    /// Sends a request with the bearer token in the `Authorization` header.
    /// The token is never placed in the URL. On a 401 the installed
    /// `tokenRefresher` runs once and the request is retried with the new token.
    func send(_ request: URLRequest, allowRefresh: Bool = true) async throws -> (Data, HTTPURLResponse) {
        var request = request
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HermesError.malformedResponse }
        let path = request.url?.path ?? ""
        if http.statusCode == 401, allowRefresh, !Self.authPaths.contains(path), let refresher = tokenRefresher {
            if let refreshed = await refresher(), !refreshed.isEmpty {
                token = refreshed
                return try await send(request, allowRefresh: false)
            }
        }
        return (data, http)
    }

    private func checkedSend(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, http) = try await send(request)
        guard (200..<300).contains(http.statusCode) else {
            throw HermesError.http(http.statusCode, Self.errorDetail(data))
        }
        return (data, http)
    }

    func request(_ path: String, method: String = "GET", body: Any? = nil, profile: String? = nil) async throws -> Any {
        var request = URLRequest(url: try url(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let header = (profile?.nilIfEmpty ?? activeProfile.nilIfEmpty) { request.setValue(header, forHTTPHeaderField: "X-Hermes-Profile") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
        let (data, _) = try await checkedSend(request)
        guard !data.isEmpty else { return JSON() }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    func object(_ path: String, method: String = "GET", body: Any? = nil, profile: String? = nil) async throws -> JSON {
        let result = try await request(path, method: method, body: body, profile: profile)
        if let object = result as? JSON { return object }
        if let array = result as? [Any] { return ["data": array] }
        throw HermesError.malformedResponse
    }

    func array(_ path: String, keys: [String], profile: String? = nil) async throws -> [JSON] {
        let result = try await request(path, profile: profile)
        if let list = result as? [Any] { return list.objects }
        guard let json = result as? JSON else { return [] }
        for key in keys where json[key] != nil { return json.objects(key) }
        return json.objects("data")
    }

    func login(username: String, password: String) async throws -> String {
        let json = try await object("/api/auth/login", method: "POST", body: ["username": username, "password": password])
        guard let token = json.string("token").nilIfEmpty else { throw HermesError.server(String(localized: "Login succeeded but no token was returned")) }
        return token
    }

    /// `POST /api/auth/app-login` — exchanges a one-time QR authorization code
    /// for a device-bound app token. Status codes are left to the caller:
    /// 400 fields, 401 invalid code, 403 user disabled, 409 already used, 410 expired.
    func appLogin(authorizationCode: String, deviceCode: String, deviceName: String, deviceModel: String) async throws -> AppAuthResponse {
        let body: JSON = [
            "authorization_code": authorizationCode,
            "device_code": deviceCode,
            "device_name": deviceName,
            "device_brand": "Apple",
            "device_model": deviceModel,
        ]
        return try AppAuthResponse(try await object("/api/auth/app-login", method: "POST", body: body))
    }

    /// `POST /api/auth/app-refresh` with the current app token as bearer and an
    /// empty JSON body. A 401 means the connection was revoked or expired.
    func appRefresh() async throws -> AppAuthResponse {
        try AppAuthResponse(try await object("/api/auth/app-refresh", method: "POST", body: JSON()))
    }

    /// `GET /health` — connection status and the server's Core Hub version
    /// (`webui_version`), shown in the drawer footer.
    func health() async throws -> HealthStatus {
        let json = try await object("/health")
        return HealthStatus(ok: json.string("status") == "ok", webUIVersion: json.string("webui_version"))
    }

    func currentUser() async throws -> CurrentUser {
        let root = try await object("/api/auth/me")
        let user = root.object("user").isEmpty ? root : root.object("user")
        return CurrentUser(id: user.int("id"), username: user.string("username", "userId"), role: user.string("role").nilIfEmpty ?? "admin", status: user.string("status").nilIfEmpty ?? "active", avatar: AvatarSpec(user["avatar"]))
    }

    func profiles() async throws -> [Profile] {
        try await array("/api/hermes/profiles", keys: ["profiles"]).map(Profile.init).filter { !$0.name.isEmpty }
    }

    func agentStatuses() async throws -> [AgentRuntimeStatus] {
        try await object("/api/agents/status").objects("agents").map(AgentRuntimeStatus.init)
    }

    func codingAgents() async throws -> [CodingAgentTool] {
        try await object("/api/coding-agents").objects("tools").map(CodingAgentTool.init)
    }

    func installCodingAgent(_ id: String) async throws -> CodingAgentTool? {
        let root = try await object("/api/coding-agents/\(id.urlEncoded)/install", method: "POST")
        return root.object("tool").isEmpty ? nil : CodingAgentTool(root.object("tool"))
    }

    func checkCodingAgentUpdate(_ id: String) async throws -> (tool: CodingAgentTool?, available: Bool, latest: String) {
        let root = try await object("/api/coding-agents/\(id.urlEncoded)/check-update", method: "POST")
        return (root.object("tool").isEmpty ? nil : CodingAgentTool(root.object("tool")), root.bool("updateAvailable"), root.string("latestVersion"))
    }

    func deleteCodingAgent(_ id: String) async throws {
        _ = try await object("/api/coding-agents/\(id.urlEncoded)", method: "DELETE")
    }

    func profileRuntimes(refresh: Bool = true) async throws -> [ProfileRuntime] { try await array("/api/hermes/profiles/runtime-statuses\(refresh ? "" : "?refresh=0")", keys: ["profiles"]).map(ProfileRuntime.init) }
    func restartProfileRuntime(_ name: String) async throws { _ = try await object("/api/hermes/profiles/\(name.urlEncoded)/restart", method: "POST") }
    func setProfileAvatar(_ name: String, dataURL: String) async throws { _ = try await object("/api/hermes/profiles/\(name.urlEncoded)/avatar", method: "PUT", body: ["type": "image", "dataUrl": dataURL]) }
    func resetProfileAvatar(_ name: String) async throws { _ = try await object("/api/hermes/profiles/\(name.urlEncoded)/avatar", method: "DELETE") }
    func exportProfile(_ name: String) async throws -> Data {
        var request = URLRequest(url: try url("/api/hermes/profiles/\(name.urlEncoded)/export")); request.httpMethod = "POST"
        let (data, http) = try await send(request)
        guard (200..<300).contains(http.statusCode) else { throw HermesError.server(String(localized: "Profile export failed")) }
        return data
    }
    func importProfile(data: Data, name: String) async throws { _ = try await multipart("/api/hermes/profiles/import", data: data, name: name, mime: "application/gzip", field: "file", profile: nil) }

    func ekkoConfig() async throws -> JSON { try await object("/api/ekko/config") }
    func saveEkkoConfig(_ config: JSON) async throws { _ = try await object("/api/ekko/config", method: "PUT", body: ["config": config]) }
    func ekkoMemory(query: String = "") async throws -> [EkkoMemoryItem] { try await array("/api/ekko/memory\(query.isEmpty ? "" : "?query=\(query.urlEncoded)")", keys: ["memories"]).map(EkkoMemoryItem.init) }
    func updateEkkoMemory(_ item: EkkoMemoryItem) async throws { _ = try await object("/api/ekko/memory/\(item.id.urlEncoded)", method: "PATCH", body: ["expectedRevision": item.revision, "title": item.title, "content": item.content, "tags": item.tags]) }
    func deleteEkkoMemory(_ item: EkkoMemoryItem) async throws { _ = try await object("/api/ekko/memory/\(item.id.urlEncoded)", method: "DELETE", body: ["expectedRevision": item.revision]) }
    func ekkoSkills(query: String = "") async throws -> [EkkoSkillItem] { try await array("/api/ekko/skills\(query.isEmpty ? "" : "?query=\(query.urlEncoded)")", keys: ["skills"]).map(EkkoSkillItem.init) }
    func ekkoSkill(_ name: String) async throws -> EkkoSkillItem { EkkoSkillItem(try await object("/api/ekko/skills/\(name.urlEncoded)").object("skill")) }
    func setEkkoSkill(_ name: String, enabled: Bool) async throws { _ = try await object("/api/ekko/skills/\(name.urlEncoded)/toggle", method: "PUT", body: ["enabled": enabled]) }
    func createEkkoSkill(name: String, content: String, category: String) async throws { _ = try await object("/api/ekko/skills", method: "POST", body: ["name": name, "content": content, "category": category]) }
    func deleteEkkoSkill(_ name: String) async throws { _ = try await object("/api/ekko/skills/\(name.urlEncoded)", method: "DELETE") }
    func saveEkkoSkill(_ item: EkkoSkillItem) async throws { _ = try await object("/api/ekko/skills/\(item.name.urlEncoded)", method: "PUT", body: ["content": item.content]) }
    func importEkkoSkill(data: Data, name: String) async throws { _ = try await multipart("/api/ekko/skills/import", data: data, name: name, mime: "application/octet-stream", field: "file", profile: nil) }
    func ekkoSkillFiles(_ name: String) async throws -> [JSON] { try await array("/api/ekko/skills/\(name.urlEncoded)/files", keys: ["files"]) }
    func ekkoSkillFile(_ name: String, path: String) async throws -> String { try await object("/api/ekko/skills/\(name.urlEncoded)/file?path=\(path.urlEncoded)").string("content") }
    func ekkoExternalDirectories() async throws -> [String] { try await object("/api/ekko/skills/external-directories").array("directories").compactMap { ($0 as? String) ?? ($0 as? JSON)?.string("path") } }
    func saveEkkoExternalDirectories(_ directories: [String]) async throws { _ = try await object("/api/ekko/skills/external-directories", method: "PUT", body: ["directories": directories]) }
    func ekkoMCPServers() async throws -> [EkkoMCPItem] { try await array("/api/ekko/mcp/servers", keys: ["servers"]).map(EkkoMCPItem.init) }
    func saveEkkoMCP(_ server: EkkoMCPItem, existing: Bool) async throws { var config: JSON = ["enabled": server.enabled]; if !server.url.isEmpty { config["type"] = "streamable_http"; config["url"] = server.url } else { config["type"] = "stdio"; config["command"] = server.command; config["args"] = server.arguments }; _ = try await object(existing ? "/api/ekko/mcp/servers/\(server.name.urlEncoded)" : "/api/ekko/mcp/servers", method: existing ? "PATCH" : "POST", body: existing ? ["config": config] : ["name": server.name, "config": config]) }
    func deleteEkkoMCP(_ name: String) async throws { _ = try await object("/api/ekko/mcp/servers/\(name.urlEncoded)", method: "DELETE") }
    func testEkkoMCP(_ name: String) async throws -> [JSON] { try await object("/api/ekko/mcp/servers/\(name.urlEncoded)/test", method: "POST").objects("tools") }

    func providers(profile: String) async throws -> [ProviderSummary] { let root = try await object("/api/hermes/available-models?profile=\(profile.urlEncoded)"); return (root.objects("groups") + root.objects("allProviders")).map(ProviderSummary.init).reduce(into: []) { result, item in if !result.contains(where: { $0.id == item.id }) { result.append(item) } } }
    func refreshProviderCache() async throws { _ = try await object("/api/hermes/provider-models/cache/refresh", method: "POST") }
    func refreshProviderModels(_ id: String, confirm: Bool = false) async throws -> JSON { try await object("/api/hermes/config/providers/\(id.urlEncoded)/models/refresh", method: "POST", body: ["confirm": confirm]) }
    func testProvider(_ id: String) async throws -> JSON { try await object("/api/hermes/config/providers/\(id.urlEncoded)/editor/test", method: "POST", body: [:]) }

    static func sessionsPath(profile: String?, limit: Int = 80) -> String {
        guard let profile = profile?.trimmingCharacters(in: .whitespacesAndNewlines), !profile.isEmpty else {
            return "/api/studio/sessions?limit=\(limit)"
        }
        return "/api/studio/sessions?limit=\(limit)&profile=\(profile.urlEncoded)"
    }

    func sessions(profile: String? = nil, limit: Int = 100) async throws -> [SessionSummary] {
        let fallbackProfile = profile?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return try await array(Self.sessionsPath(profile: profile, limit: limit), keys: ["sessions"]).map { SessionSummary($0, profile: fallbackProfile) }.filter { !$0.id.isEmpty }
    }

    func searchSessions(_ query: String, profile: String? = nil) async throws -> [SessionSummary] {
        var path = "/api/studio/sessions/search?q=\(query.urlEncoded)&limit=100"
        if let profile = profile?.nilIfEmpty { path += "&profile=\(profile.urlEncoded)" }
        return try await array(path, keys: ["results"]).map { SessionSummary($0, profile: profile ?? "") }
    }
    func sessionSummary(_ id: String, profile: String? = nil) async throws -> SessionSummary {
        let query = profile?.nilIfEmpty.map { "?profile=\($0.urlEncoded)" } ?? ""
        let root = try await object("/api/studio/sessions/\(id.urlEncoded)\(query)")
        return SessionSummary(root.object("session"), profile: profile ?? "")
    }

    func sessionCategories() async throws -> [SessionCategory] { try await array("/api/studio/session-categories", keys: ["categories"]).map(SessionCategory.init) }
    func createSessionCategory(_ name: String) async throws -> SessionCategory { SessionCategory(try await object("/api/studio/session-categories", method: "POST", body: ["name": name]).object("category")) }
    func renameSessionCategory(_ id: Int, name: String) async throws { _ = try await object("/api/studio/session-categories/\(id)", method: "PATCH", body: ["name": name]) }
    func deleteSessionCategory(_ id: Int) async throws { _ = try await object("/api/studio/session-categories/\(id)", method: "DELETE") }
    func setSessionCategory(_ id: String, categoryID: Int?) async throws {
        let body: JSON = ["categoryId": categoryID.map { $0 as Any } ?? NSNull()]
        _ = try await object("/api/studio/sessions/\(id.urlEncoded)/category", method: "POST", body: body)
    }
    func setSessionArchived(_ id: String, archived: Bool) async throws { _ = try await object("/api/studio/sessions/\(id.urlEncoded)/\(archived ? "archive" : "unarchive")", method: "POST") }

    func workflows(profile: String? = nil) async throws -> [WorkflowItem] {
        let query = profile?.nilIfEmpty.map { "?profile=\($0.urlEncoded)" } ?? ""
        return try await array("/api/studio/workflows\(query)", keys: ["workflows"]).map(WorkflowItem.init)
    }
    func workflowRuns(_ id: String) async throws -> [WorkflowRun] { try await array("/api/studio/workflows/\(id.urlEncoded)/runs?limit=100", keys: ["runs"]).map(WorkflowRun.init) }
    func runWorkflow(_ id: String, input: String?) async throws {
        var body: JSON = [:]
        if let input = input?.nilIfEmpty { body["input"] = input }
        _ = try await object("/api/studio/workflows/\(id.urlEncoded)/run", method: "POST", body: body)
    }
    func stopWorkflow(_ id: String, runID: String) async throws { _ = try await object("/api/studio/workflows/\(id.urlEncoded)/runs/\(runID.urlEncoded)/stop", method: "POST") }
    func deleteWorkflowRun(_ id: String, runID: String) async throws { _ = try await object("/api/studio/workflows/\(id.urlEncoded)/runs/\(runID.urlEncoded)", method: "DELETE") }
    func approveWorkflowNode(_ id: String, runID: String, node: WorkflowRunNode, approved: Bool) async throws { _ = try await object("/api/studio/workflows/\(id.urlEncoded)/runs/\(runID.urlEncoded)/nodes/\(node.nodeID.urlEncoded)/approval", method: "POST", body: ["approved": approved, "executionId": node.executionID]) }
    func workflow(_ id: String) async throws -> WorkflowItem { WorkflowItem(try await object("/api/studio/workflows/\(id.urlEncoded)").object("workflow")) }
    func saveWorkflow(id: String?, name: String, profile: String, workspace: String?, nodes: [JSON], edges: [JSON], viewport: JSON = [:]) async throws -> WorkflowItem { var body: JSON = ["name": name, "workspace": workspace ?? NSNull(), "nodes": nodes, "edges": edges]; if id == nil { body["profile"] = profile }; if !viewport.isEmpty { body["viewport"] = viewport }; let root = try await object(id.map { "/api/studio/workflows/\($0.urlEncoded)" } ?? "/api/studio/workflows", method: id == nil ? "POST" : "PATCH", body: body); return WorkflowItem(root.object("workflow")) }
    func deleteWorkflow(_ id: String) async throws { _ = try await object("/api/studio/workflows/\(id.urlEncoded)", method: "DELETE") }
    func batchDeleteWorkflows(_ ids: [String]) async throws -> JSON { try await object("/api/studio/workflows/batch-delete", method: "POST", body: ["ids": ids]) }
    func exportWorkflow(_ id: String) async throws -> Data { try await rawData("/api/studio/workflows/\(id.urlEncoded)/export") }
    func previewWorkflowImport(_ document: String, profile: String?) async throws -> JSON {
        let body: JSON = ["document": document, "profile": profile ?? NSNull()]
        return try await object("/api/studio/workflows/import/preview", method: "POST", body: body).object("preview")
    }
    func confirmWorkflowImport(token: String, profile: String?) async throws {
        let body: JSON = ["token": token, "profile": profile ?? NSNull()]
        _ = try await object("/api/studio/workflows/import/confirm", method: "POST", body: body)
    }
    func cancelWorkflowImport(token: String, profile: String?) async throws {
        let body: JSON = ["token": token, "profile": profile ?? NSNull()]
        _ = try await object("/api/studio/workflows/import/cancel", method: "POST", body: body)
    }
    func rerunWorkflow(_ id: String, runID: String, nodeID: String, timeout: Int? = nil) async throws { var body: JSON = ["node_id": nodeID, "preserve_start_node": true]; if let timeout { body["timeout_ms"] = timeout }; _ = try await object("/api/studio/workflows/\(id.urlEncoded)/runs/\(runID.urlEncoded)/rerun-from-node", method: "POST", body: body) }
    func workflowSchedules(_ id: String) async throws -> [WorkflowSchedule] { try await array("/api/studio/workflows/\(id.urlEncoded)/schedules", keys: ["schedules"]).map(WorkflowSchedule.init) }
    func saveWorkflowSchedule(workflowID: String, scheduleID: String?, schedule: String, timezone: String, enabled: Bool, input: String) async throws { _ = try await object(scheduleID.map { "/api/studio/workflows/\(workflowID.urlEncoded)/schedules/\($0.urlEncoded)" } ?? "/api/studio/workflows/\(workflowID.urlEncoded)/schedules", method: scheduleID == nil ? "POST" : "PATCH", body: ["schedule": schedule, "timezone": timezone, "enabled": enabled, "input": input, "start_node_ids": []]) }
    func deleteWorkflowSchedule(workflowID: String, scheduleID: String) async throws { _ = try await object("/api/studio/workflows/\(workflowID.urlEncoded)/schedules/\(scheduleID.urlEncoded)", method: "DELETE") }

    func batchDeleteSessions(_ sessions: [SessionSummary]) async throws -> JSON { try await object("/api/studio/sessions/batch-delete", method: "POST", body: ["ids": sessions.map(\.id), "sessions": sessions.map { ["id": $0.id, "profile": $0.profile] }]) }
    func setSessionWorkspace(_ id: String, workspace: String?) async throws { _ = try await object("/api/studio/sessions/\(id.urlEncoded)/workspace", method: "POST", body: ["workspace": workspace ?? ""]) }
    func setSessionPush(_ id: String, enabled: Bool) async throws { _ = try await object("/api/studio/sessions/\(id.urlEncoded)/push-enabled", method: "POST", body: ["pushEnabled": enabled]) }
    func exportSession(_ id: String, mode: String = "full", ext: String = "json") async throws -> Data { try await rawData("/api/studio/sessions/\(id.urlEncoded)/export?mode=\(mode.urlEncoded)&ext=\(ext.urlEncoded)") }
    func workspaceFolders() async throws -> [String] { let root = try await object("/api/studio/workspace/folders"); return root.array("folders").compactMap { ($0 as? String) ?? ($0 as? JSON)?.string("path") } }

    func conversationHistory(sessionID: String) async throws -> (messages: [Message], contextTokens: Int?) {
        let path = "/api/studio/sessions/conversations/\(sessionID.urlEncoded)/messages?humanOnly=true"
        let root = try await object(path)
        let messages = root.objects("messages").map(Message.init)
        let raw = root["contextTokens"] ?? root["context_tokens"] ?? root["tokenCount"] ?? root["token_count"]
        let tokens = (raw as? NSNumber)?.intValue ?? Int(String(describing: raw ?? ""))
        return (messages, tokens)
    }

    func messages(sessionID: String) async throws -> [Message] {
        try await conversationHistory(sessionID: sessionID).messages
    }

    func contextLength(profile: String, provider: String, model: String) async throws -> Int {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "profile", value: profile),
            URLQueryItem(name: "provider", value: provider.nilIfEmpty),
            URLQueryItem(name: "model", value: model.nilIfEmpty),
        ].filter { $0.value != nil }
        let query = components.percentEncodedQuery ?? "profile=\(profile.urlEncoded)"
        let root = try await object("/api/studio/sessions/context-length?\(query)", profile: profile)
        let length = root["context_length"] == nil ? root.int("contextLength") : root.int("context_length")
        guard length > 0 else { throw HermesError.malformedResponse }
        return length
    }

    func usageStats(days: Int) async throws -> UsageStats {
        let safeDays = min(365, max(1, days))
        let root = try await object("/api/studio/usage/stats?days=\(safeDays)")
        let models = root.objects("model_usage").enumerated().map { index, item in
            let name = item.string("model", "name").nilIfEmpty ?? "Unknown"
            return UsageBreakdown(
                id: "\(name)-\(index)", name: name,
                inputTokens: item.int("input_tokens"), outputTokens: item.int("output_tokens"),
                sessions: item.int("sessions"), cost: item.double("cost")
            )
        }
        func breakdown(_ key: String, nameKeys: [String]) -> [UsageBreakdown] { root.objects(key).enumerated().map { index, item in let name = nameKeys.lazy.map { item.string($0) }.first(where: { !$0.isEmpty }) ?? "Unknown"; return UsageBreakdown(id: "\(key)-\(name)-\(index)", name: name, inputTokens: item.int("input_tokens"), outputTokens: item.int("output_tokens"), sessions: item.int("sessions"), cost: item["cost"] == nil ? item.double("estimated_cost_usd") : item.double("cost")) } }
        return UsageStats(
            inputTokens: root.int("total_input_tokens"), outputTokens: root.int("total_output_tokens"),
            cacheTokens: root.int("total_cache_read_tokens") + root.int("total_cache_write_tokens"),
            sessions: root.int("total_sessions"), cost: root.double("total_cost"), models: models,
            agents: breakdown("agent_usage", nameKeys: ["agent", "name", "family"]), daily: breakdown("daily_usage", nameKeys: ["date", "day"])
        )
    }

    func studioFiles(path: String, profile: String) async throws -> [StudioFileItem] { try await array("/api/studio/files/list?path=\(path.urlEncoded)&profile=\(profile.urlEncoded)", keys: ["entries"]).map(StudioFileItem.init) }
    func readStudioFile(_ path: String, profile: String) async throws -> String { try await object("/api/studio/files/read?path=\(path.urlEncoded)&profile=\(profile.urlEncoded)").string("content") }
    func writeStudioFile(_ path: String, content: String, profile: String) async throws { _ = try await object("/api/studio/files/write", method: "PUT", body: ["path": path, "content": content, "profile": profile]) }
    func mkdirStudioFile(_ path: String, profile: String) async throws { _ = try await object("/api/studio/files/mkdir", method: "POST", body: ["path": path, "profile": profile]) }
    func renameStudioFile(_ path: String, to newPath: String, profile: String) async throws { _ = try await object("/api/studio/files/rename", method: "POST", body: ["oldPath": path, "newPath": newPath, "profile": profile]) }
    func copyStudioFile(_ path: String, to newPath: String, profile: String) async throws { _ = try await object("/api/studio/files/copy", method: "POST", body: ["srcPath": path, "destPath": newPath, "profile": profile]) }
    func deleteStudioFile(_ path: String, recursive: Bool, profile: String) async throws { _ = try await object("/api/studio/files/delete", method: "DELETE", body: ["path": path, "recursive": recursive, "profile": profile]) }
    func uploadStudioFile(data: Data, name: String, mime: String, path: String, profile: String) async throws { _ = try await multipart("/api/studio/files/upload?path=\(path.urlEncoded)&profile=\(profile.urlEncoded)", data: data, name: name, mime: mime, field: "file", profile: profile) }
    /// Downloads a workspace file through `/api/studio/files/download` with the
    /// bearer token in the header and returns the local copy.
    func downloadStudioFile(_ path: String, profile: String) async throws -> URL {
        let name = URL(fileURLWithPath: path).lastPathComponent.nilIfEmpty ?? "file"
        return try await downloadFile(path: path, name: name, profile: profile)
    }
    func logFiles() async throws -> [StudioLogFile] { try await array("/api/studio/logs", keys: ["files"]).map(StudioLogFile.init) }
    func logEntries(_ name: String, text: String = "", level: String = "") async throws -> [StudioLogEntry] { var path = "/api/studio/logs/\(name.urlEncoded)?lines=1000"; if !text.isEmpty { path += "&text=\(text.urlEncoded)" }; if !level.isEmpty { path += "&level=\(level.urlEncoded)" }; return try await array(path, keys: ["entries"]).map(StudioLogEntry.init) }
    func appRelay(_ action: String = "status", method: String = "GET", body: JSON? = nil) async throws -> AppRelayInfo { AppRelayInfo(try await object("/api/app-relay/\(action)", method: method, body: body).object("relay")) }
    func appConnections() async throws -> [AppConnectionItem] { try await array("/api/app-connections", keys: ["connections"]).map(AppConnectionItem.init) }
    func deleteAppConnection(_ id: Int) async throws { _ = try await object("/api/app-connections/\(id)", method: "DELETE") }
    func appAuthorization(cloud: Bool, refresh: Bool = false, route: String = "official") async throws -> JSON { try await object("/api/app-connections/authorization-codes/\(cloud ? "cloud" : "lan")", method: "POST", body: cloud ? ["refresh": refresh, "route": route] : nil) }
    func devices(scan: Bool = false) async throws -> [StudioDevice] { try await object("/api/devices\(scan ? "/scan" : "")", method: scan ? "POST" : "GET").objects("devices").map(StudioDevice.init) }
    func deviceAction(_ id: String, action: String) async throws { _ = try await object("/api/devices/\(id.urlEncoded)/\(action)", method: "POST") }
    func devicePairingLink() async throws -> JSON { try await object("/api/devices/pairing-link") }
    func requestDevice(url: String) async throws { _ = try await object("/api/devices/manual-request", method: "POST", body: ["url": url]) }
    func peerConnections() async throws -> [PeerConnection] { try await array("/api/devices/peer-connections", keys: ["connections"]).map(PeerConnection.init) }
    func disconnectPeer(_ id: String) async throws { _ = try await object("/api/devices/peer-connections/\(id.urlEncoded)/disconnect", method: "POST") }
    func providerAuthStatus(_ provider: String) async throws -> JSON { try await object("/api/hermes/auth/\(provider.urlEncoded)/status") }
    func startProviderAuth(_ provider: String) async throws -> JSON { try await object("/api/hermes/auth/\(provider.urlEncoded)/start", method: "POST") }
    func pollProviderAuth(_ provider: String, sessionID: String) async throws -> JSON { try await object("/api/hermes/auth/\(provider.urlEncoded)/poll/\(sessionID.urlEncoded)") }
    func submitProviderAuth(_ provider: String, sessionID: String, code: String) async throws -> JSON { try await object("/api/hermes/auth/\(provider.urlEncoded)/submit/\(sessionID.urlEncoded)", method: "POST", body: ["code": code]) }

    func runtimePerformance() async throws -> RuntimePerformance {
        let root = try await object("/api/studio/performance/runtime")
        let system = root.object("system"), bridge = root.object("bridge"), sessions = root.object("sessions")
        let workers = bridge.objects("workers")
        return RuntimePerformance(
            cpuPercent: system["cpuPercent"] == nil ? nil : system.double("cpuPercent"),
            memoryPercent: system["memoryPercent"] == nil ? nil : system.double("memoryPercent"),
            workerCount: workers.count, runningWorkers: workers.filter { $0.bool("running") }.count,
            sessionCount: sessions.int("total")
        )
    }

    func renameSession(_ id: String, title: String) async throws { _ = try await object("/api/studio/sessions/\(id.urlEncoded)/rename", method: "POST", body: ["title": title]) }
    func deleteSession(_ id: String) async throws { _ = try await object("/api/studio/sessions/\(id.urlEncoded)", method: "DELETE") }
    func setSessionModel(_ id: String, model: String, provider: String?) async throws {
        var body: JSON = ["model": model]; if let provider, !provider.isEmpty { body["provider"] = provider }
        _ = try await object("/api/studio/sessions/\(id.urlEncoded)/model", method: "POST", body: body)
    }

    func models(profile: String) async throws -> [ModelOption] {
        let root = try await object("/api/hermes/available-models?profile=\(profile.urlEncoded)")
        var values = root.objects("models")
        if values.isEmpty, let strings = root["models"] as? [String] { values = strings.map { ["id": $0, "name": $0] } }
        if values.isEmpty {
            for group in root.objects("groups") + root.objects("allProviders") {
                let provider = group.string("provider", "name", "label")
                for raw in group.array("models") {
                    if let id = raw as? String, id != "*" { values.append(["id": id, "name": id, "provider": provider]) }
                    else if var model = raw as? JSON { model["provider"] = model.string("provider").nilIfEmpty ?? provider; values.append(model) }
                }
            }
        }
        return values.map(ModelOption.init).filter { !$0.id.isEmpty }
    }

    func setDefaultModel(profile: String, model: String, provider: String?) async throws {
        var body: JSON = ["default": model]; if let provider, !provider.isEmpty { body["provider"] = provider }
        _ = try await object("/api/hermes/config/model?profile=\(profile.urlEncoded)", method: "PUT", body: body, profile: profile)
    }

    func updateProviderKey(profile: String, provider: String, key: String) async throws {
        _ = try await object("/api/hermes/config/providers/\(provider.urlEncoded)?profile=\(profile.urlEncoded)", method: "PUT", body: ["api_key": key], profile: profile)
    }

    func createProfile(_ name: String) async throws { _ = try await object("/api/hermes/profiles", method: "POST", body: ["name": name]) }
    func cloneProfile(_ name: String) async throws { _ = try await object("/api/hermes/profiles", method: "POST", body: ["name": name, "clone": true]) }
    func activateProfile(_ name: String) async throws { _ = try await object("/api/hermes/profiles/active", method: "PUT", body: ["name": name]) }
    func renameProfile(_ name: String, to newName: String) async throws { _ = try await object("/api/hermes/profiles/\(name.urlEncoded)/rename", method: "POST", body: ["new_name": newName]) }
    func deleteProfile(_ name: String) async throws { _ = try await object("/api/hermes/profiles/\(name.urlEncoded)", method: "DELETE") }
    func restartGateway(profile: String) async throws { _ = try await object("/api/hermes/profiles/\(profile.urlEncoded)/gateway/restart", method: "POST") }

    func boards() async throws -> [KanbanBoard] {
        var rows = try await array("/api/hermes/kanban/boards", keys: ["boards"])
        if rows.isEmpty { rows = [["id": "default", "name": String(localized: "Default")]] }
        return rows.map(KanbanBoard.init)
    }
    func kanbanTasks(board: String) async throws -> [KanbanTask] { try await array("/api/hermes/kanban?board=\(board.urlEncoded)", keys: ["tasks", "items"]).map(KanbanTask.init) }
    func createTask(board: String, title: String, description: String, priority: String) async throws {
        let numericPriority = priority == "high" ? 3 : (priority == "low" ? 1 : 2)
        _ = try await object("/api/hermes/kanban?board=\(board.urlEncoded)", method: "POST", body: ["title": title, "body": description, "priority": numericPriority, "triage": true, "skills": []])
    }
    func moveTasks(board: String, ids: [String], status: String) async throws { _ = try await object("/api/hermes/kanban/tasks/bulk?board=\(board.urlEncoded)", method: "POST", body: ["ids": ids, "status": status]) }
    func assignTask(board: String, id: String, profile: String?) async throws {
        let body: JSON = ["profile": profile ?? ""]
        _ = try await object("/api/hermes/kanban/\(id.urlEncoded)/assign?board=\(board.urlEncoded)", method: "POST", body: body)
    }
    func commentTask(board: String, id: String, comment: String) async throws { _ = try await object("/api/hermes/kanban/\(id.urlEncoded)/comments?board=\(board.urlEncoded)", method: "POST", body: ["body": comment]) }
    func journey() async throws -> JourneyGraph { JourneyGraph(try await object("/api/hermes/journey")) }
    func skillUsage(days: Int) async throws -> SkillUsageStats { SkillUsageStats(try await object("/api/hermes/skills/usage/stats?days=\(days)")) }
    func webhookEndpoints() async throws -> [WebhookEndpoint] { try await array("/api/studio/webhooks/endpoints", keys: ["endpoints"]).map(WebhookEndpoint.init) }
    func saveWebhook(_ item: WebhookEndpoint?, name: String, url: String, secret: String, events: [String], profiles: [String], enabled: Bool, includeContent: Bool, includeUserContent: Bool, privateNetwork: Bool, retries: Int) async throws { var body: JSON = ["name": name, "url": url, "event_types": events, "profiles": profiles, "enabled": enabled, "include_content": includeContent, "include_user_content": includeUserContent, "allow_private_network": privateNetwork, "max_retries": retries]; if !secret.isEmpty { body["secret"] = secret }; _ = try await object(item.map { "/api/studio/webhooks/endpoints/\($0.id.urlEncoded)" } ?? "/api/studio/webhooks/endpoints", method: item == nil ? "POST" : "PATCH", body: body) }
    func deleteWebhook(_ id: String) async throws { _ = try await object("/api/studio/webhooks/endpoints/\(id.urlEncoded)", method: "DELETE") }
    func testWebhook(_ id: String) async throws -> JSON { try await object("/api/studio/webhooks/endpoints/\(id.urlEncoded)/test", method: "POST") }
    func localWebhookTarget() async throws -> JSON { try await object("/api/studio/webhooks/local-test-target") }
    func localWebhookEvents() async throws -> [JSON] { try await array("/api/studio/webhooks/local-test-events", keys: ["events"]) }
    func clearLocalWebhookEvents() async throws { _ = try await object("/api/studio/webhooks/local-test-events", method: "DELETE") }
    func runtimeVersions(remote: Bool = true) async throws -> RuntimeVersionStatus { RuntimeVersionStatus(try await object("/api/hermes/runtime-versions?remote=\(remote ? "true" : "false")")) }
    func runtimeJobs() async throws -> [JSON] { try await array("/api/hermes/runtime-versions/jobs", keys: ["jobs"]) }
    func downloadVersion(_ version: String, kind: String, source: String) async throws { _ = try await object("/api/hermes/runtime-versions/\(kind)/download", method: "POST", body: ["version": version, "source": source]) }
    func activateVersion(_ version: String, kind: String) async throws { _ = try await object("/api/hermes/runtime-versions/active-\(kind == "runtime" ? "runtime" : "webui")", method: "POST", body: ["version": version]) }
    func deleteVersion(_ version: String, kind: String) async throws { _ = try await object("/api/hermes/runtime-versions/\(kind)/\(version.urlEncoded)", method: "DELETE") }
    func restartVersionedWebUI() async throws { _ = try await object("/api/hermes/runtime-versions/restart-webui", method: "POST") }
    func themeSettings() async throws -> ThemeSettings { ThemeSettings(try await object("/api/theme")) }
    func saveTheme(fontSize: Double, textColor: String?, accentColor: String?) async throws -> ThemeSettings {
        let body: JSON = [
            "fontSize": fontSize,
            "textColor": textColor ?? NSNull(),
            "accentColor": accentColor ?? NSNull()
        ]
        return ThemeSettings(try await object("/api/theme", method: "PUT", body: body))
    }
    func uploadThemeBackground(data: Data, name: String, mime: String) async throws { _ = try await multipart("/api/theme/background", data: data, name: name, mime: mime, field: "background", profile: nil) }
    func deleteThemeBackground() async throws { _ = try await object("/api/theme/background", method: "DELETE") }
    func kanbanStats(board: String) async throws -> JSON { try await object("/api/hermes/kanban/stats?board=\(board.urlEncoded)").object("stats") }
    func kanbanDiagnostics(board: String, task: String? = nil) async throws -> [JSON] { try await array("/api/hermes/kanban/diagnostics?board=\(board.urlEncoded)\(task.map { "&task=\($0.urlEncoded)" } ?? "")", keys: ["diagnostics"]) }
    func dispatchKanban(board: String, dryRun: Bool = false) async throws { _ = try await object("/api/hermes/kanban/dispatch?board=\(board.urlEncoded)", method: "POST", body: ["dryRun": dryRun]) }
    func blockKanban(board: String, id: String, reason: String) async throws { _ = try await object("/api/hermes/kanban/\(id.urlEncoded)/block?board=\(board.urlEncoded)", method: "POST", body: ["reason": reason]) }
    func unblockKanban(board: String, ids: [String]) async throws { _ = try await object("/api/hermes/kanban/unblock?board=\(board.urlEncoded)", method: "POST", body: ["task_ids": ids]) }
    func completeKanban(board: String, ids: [String], summary: String) async throws { _ = try await object("/api/hermes/kanban/complete?board=\(board.urlEncoded)", method: "POST", body: ["task_ids": ids, "summary": summary]) }
    func reassignKanban(board: String, id: String, profile: String, reclaim: Bool = true) async throws { _ = try await object("/api/hermes/kanban/\(id.urlEncoded)/reassign?board=\(board.urlEncoded)", method: "POST", body: ["profile": profile, "reclaim": reclaim]) }
    func kanbanLog(board: String, id: String) async throws -> JSON { try await object("/api/hermes/kanban/\(id.urlEncoded)/log?board=\(board.urlEncoded)&tail=400") }
    func kanbanAttachments(board: String, id: String) async throws -> [JSON] { try await array("/api/hermes/kanban/\(id.urlEncoded)/attachments?board=\(board.urlEncoded)", keys: ["attachments"]) }
    /// Downloads a Kanban attachment with the bearer token in the header and
    /// returns the local copy.
    func downloadKanbanAttachment(board: String, taskID: String, attachmentID: Int, name: String) async throws -> URL {
        let data = try await rawData("/api/hermes/kanban/\(taskID.urlEncoded)/attachments/\(attachmentID)?board=\(board.urlEncoded)")
        return try Self.writeTemporaryFile(data, name: name.nilIfEmpty ?? "attachment-\(attachmentID)")
    }

    func cronJobs(profile: String) async throws -> [CronJob] {
        try await array("/api/hermes/jobs?include_disabled=true", keys: ["jobs"], profile: profile).map(CronJob.init)
    }
    func setCronEnabled(_ id: String, enabled: Bool, profile: String) async throws { _ = try await object("/api/hermes/jobs/\(id.urlEncoded)/\(enabled ? "resume" : "pause")", method: "POST", profile: profile) }
    func runCron(_ id: String, profile: String) async throws { _ = try await object("/api/hermes/jobs/\(id.urlEncoded)/run", method: "POST", profile: profile) }
    func deleteCron(_ id: String, profile: String) async throws { _ = try await object("/api/hermes/jobs/\(id.urlEncoded)", method: "DELETE", profile: profile) }
    func saveCron(id: String?, name: String, schedule: String, prompt: String, profile: String, enabled: Bool) async throws {
        let body: JSON = ["name": name, "schedule": schedule, "prompt": prompt, "profile": profile, "enabled": enabled, "timezone": TimeZone.current.identifier]
        let path = id.map { "/api/hermes/jobs/\($0.urlEncoded)" } ?? "/api/hermes/jobs"
        _ = try await object(path, method: id == nil ? "POST" : "PATCH", body: body, profile: profile)
    }

    func skills(profile: String) async throws -> [SkillItem] {
        let root = try await object("/api/hermes/skills?profile=\(profile.urlEncoded)&target=all", profile: profile)
        var result = root.objects("skills").map { SkillItem($0) }
        if result.isEmpty {
            for category in root.objects("categories") {
                let categoryName = category.string("name", "category").nilIfEmpty ?? "workspace"
                result += category.objects("skills").map { SkillItem($0, category: categoryName) }
            }
        }
        if result.isEmpty {
            for (category, raw) in root where raw is [Any] { result += (raw as? [Any] ?? []).objects.map { SkillItem($0, category: category) } }
        }
        return result
    }
    func skill(category: String, name: String, profile: String) async throws -> SkillItem {
        let result = try await object("/api/hermes/skills/\(category.urlEncoded)/\(name.urlEncoded)", profile: profile)
        return SkillItem(["name": name, "category": category, "content": result.string("content"), "enabled": true], category: category)
    }
    func saveSkill(_ skill: SkillItem, profile: String) async throws { _ = try await object("/api/hermes/skills/\(skill.category.urlEncoded)/\(skill.name.urlEncoded)", method: "PUT", body: ["content": skill.content], profile: profile) }
    func toggleSkill(_ skill: SkillItem, profile: String) async throws { _ = try await object("/api/hermes/skills/toggle", method: "PUT", body: ["name": skill.name, "enabled": !skill.enabled], profile: profile) }
    func pinSkill(_ skill: SkillItem, profile: String) async throws { _ = try await object("/api/hermes/skills/pin", method: "PUT", body: ["name": skill.name, "pinned": !skill.pinned], profile: profile) }
    func deleteSkill(_ skill: SkillItem, profile: String) async throws { _ = try await object("/api/hermes/skills/\(skill.category.urlEncoded)/\(skill.name.urlEncoded)", method: "DELETE", profile: profile) }

    func plugins() async throws -> [PluginItem] { try await array("/api/hermes/plugins", keys: ["plugins"]).map(PluginItem.init) }
    func setPlugin(_ plugin: PluginItem, enabled: Bool) async throws { _ = try await object("/api/hermes/plugins/\(plugin.key.urlEncoded)/\(enabled ? "enable" : "disable")", method: "POST") }

    func mcpServers() async throws -> [MCPServer] { try await array("/api/hermes/mcp/servers", keys: ["servers"]).map(MCPServer.init) }
    func saveMCP(name: String, command: String, arguments: [String], url: String, enabled: Bool, existing: Bool) async throws {
        var config: JSON = ["enabled": enabled]
        if !url.isEmpty { config["transport"] = "http"; config["url"] = url }
        else { config["transport"] = "stdio"; config["command"] = command; config["args"] = arguments }
        let body: JSON = existing ? ["config": config] : ["name": name, "config": config]
        _ = try await object(existing ? "/api/hermes/mcp/servers/\(name.urlEncoded)" : "/api/hermes/mcp/servers", method: existing ? "PATCH" : "POST", body: body)
    }
    func testMCP(_ name: String) async throws -> JSON { try await object("/api/hermes/mcp/servers/\(name.urlEncoded)/test", method: "POST") }
    func reloadMCP(_ name: String) async throws { _ = try await object("/api/hermes/mcp/reload?server=\(name.urlEncoded)", method: "POST") }
    func deleteMCP(_ name: String) async throws { _ = try await object("/api/hermes/mcp/servers/\(name.urlEncoded)", method: "DELETE") }

    func petManifest() async throws -> [Pet] { try await array("/api/hermes/petdex/manifest", keys: ["pets", "manifest"]).map { Pet($0) } }
    func activePets() async throws -> [Pet] {
        let result = try await object("/api/hermes/pets/active")
        let pet = result.object("pet")
        return pet.isEmpty ? [] : [Pet(pet, active: pet.bool("enabled", default: true))]
    }
    func adoptPet(_ id: String, profile: String) async throws { _ = try await object("/api/hermes/pets/adopt", method: "POST", body: ["slug": id]) }
    func setPet(_ id: String, profile: String, active: Bool) async throws { _ = try await object("/api/hermes/pets/active", method: "PATCH", body: ["enabled": active]) }

    func pendingSkillWrites(profile: String) async throws -> [PendingSkillWrite] {
        try await object("/api/hermes/write-gate/pending", profile: profile).objects("records")
            .filter { $0.string("subsystem") == "skills" }
            .map(PendingSkillWrite.init)
            .filter { !$0.id.isEmpty }
    }

    func resolvePendingSkillWrite(_ id: String, approve: Bool, profile: String) async throws {
        let action = approve ? "approve" : "reject"
        _ = try await object("/api/hermes/write-gate/pending/skills/\(id.urlEncoded)/\(action)", method: "POST", profile: profile)
    }

    func config(profile: String, section: String? = nil) async throws -> JSON {
        var path = "/api/hermes/config?profile=\(profile.urlEncoded)"
        if let section { path += "&section=\(section.urlEncoded)" }
        return try await object(path, profile: profile)
    }
    func updateConfig(profile: String, section: String, values: JSON, restart: Bool = false) async throws {
        let body: JSON = ["section": section, "values": values, "restart": restart]
        _ = try await object("/api/hermes/config?profile=\(profile.urlEncoded)", method: "PUT", body: body, profile: profile)
    }
    func updateCredentials(profile: String, platform: String, values: JSON) async throws {
        _ = try await object("/api/hermes/config/credentials?profile=\(profile.urlEncoded)", method: "PUT", body: ["platform": platform, "values": values], profile: profile)
    }
    func clearCredentials(profile: String, platform: String) async throws { _ = try await object("/api/hermes/config/credentials/\(platform.urlEncoded)?profile=\(profile.urlEncoded)", method: "DELETE", profile: profile) }

    func weixinQrCode(profile: String) async throws -> (id: String, url: URL) {
        let result = try await object("/api/hermes/weixin/qrcode", profile: profile)
        guard let id = result.string("qrcode").nilIfEmpty,
              let url = URL(string: result.string("qrcode_url")) else {
            throw HermesError.malformedResponse
        }
        return (id, url)
    }

    func weixinQrStatus(profile: String, code: String) async throws -> JSON {
        try await object("/api/hermes/weixin/qrcode/status?qrcode=\(code.urlEncoded)", profile: profile)
    }

    func saveWeixinCredentials(profile: String, status: JSON) async throws {
        let accountID = status.string("account_id")
        let issuedToken = status.string("token")
        guard !accountID.isEmpty, !issuedToken.isEmpty else { throw HermesError.malformedResponse }
        var body: JSON = ["account_id": accountID, "token": issuedToken]
        if let baseURL = status.string("base_url").nilIfEmpty { body["base_url"] = baseURL }
        _ = try await object("/api/hermes/weixin/save", method: "POST", body: body, profile: profile)
    }

    func changePassword(current: String, new: String) async throws { _ = try await object("/api/auth/change-password", method: "POST", body: ["currentPassword": current, "newPassword": new]) }
    func changeUsername(currentPassword: String, newUsername: String) async throws { _ = try await object("/api/auth/change-username", method: "POST", body: ["currentPassword": currentPassword, "newUsername": newUsername]) }
    func updateAvatar(dataURL: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["type": "image", "dataUrl": dataURL])
        _ = try await object("/api/auth/avatar", method: "PUT", body: ["avatar": String(data: data, encoding: .utf8) ?? ""])
    }
    func resetAvatar() async throws { _ = try await object("/api/auth/avatar", method: "PUT", body: ["avatar": ["type": "default"]]) }

    func upload(data: Data, name: String, mime: String, profile: String) async throws -> Upload {
        let result = try await multipart("/upload?profile=\(profile.urlEncoded)", data: data, name: name, mime: mime, field: "file", profile: profile)
        let item = result.object("file").isEmpty ? result : result.object("file")
        return Upload(name: item.string("name", "filename").nilIfEmpty ?? name, path: item.string("path", "filePath", "url"), mime: item.string("mime", "media_type", "type").nilIfEmpty ?? mime)
    }

    /// `GET /api/studio/stt/profile-status` → `{ configured, activeProvider, reason }`.
    func sttProfileStatus(profile: String) async throws -> SttProfileStatus {
        SttProfileStatus(try await object("/api/studio/stt/profile-status?profile=\(profile.urlEncoded)", profile: profile))
    }

    /// Multipart fields sent with every server transcription request.
    static func sttFormFields(provider: String, language: String?) -> [String: String] {
        var fields = ["provider": provider]
        if let language = language?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty { fields["language"] = language }
        return fields
    }

    /// `POST /api/studio/stt/transcribe` (multipart/form-data: `provider`,
    /// optional `language`, file part `audio` as `voice.wav`, `audio/wav`).
    /// Response `{ text, provider, model, language?, durationMs }`; a 400 with
    /// `code: "no_speech_detected"` becomes a readable error.
    func transcribe(wav data: Data, provider: String, language: String?, profile: String) async throws -> Transcription {
        let request = try multipartRequest(
            "/api/studio/stt/transcribe?profile=\(profile.urlEncoded)",
            data: data, name: "voice.wav", mime: "audio/wav", field: "audio",
            fields: Self.sttFormFields(provider: provider, language: language), profile: profile
        )
        let (responseData, http) = try await send(request)
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 400, Self.errorCode(responseData) == "no_speech_detected" {
                throw HermesError.server(String(localized: "No speech was detected. Try again closer to the microphone."))
            }
            throw HermesError.http(http.statusCode, Self.errorDetail(responseData))
        }
        guard let json = try JSONSerialization.jsonObject(with: responseData) as? JSON else { throw HermesError.malformedResponse }
        let result = Transcription(json)
        guard !result.text.isEmpty else { throw HermesError.server(String(localized: "The server returned an empty transcription")) }
        return result
    }

    /// `GET /api/studio/tts/settings` → `{ settings | providers, activeProvider }`.
    func ttsSettings(profile: String) async throws -> TtsSettings {
        TtsSettings(try await object("/api/studio/tts/settings", profile: profile))
    }

    /// `PUT /api/studio/tts/settings/active`. Called only when the owner picks
    /// a server voice in Settings → Voice; speaking a message never writes it.
    @discardableResult
    func setActiveTtsProvider(_ provider: String, profile: String) async throws -> String {
        let json = try await object("/api/studio/tts/settings/active", method: "PUT",
                                    body: ["provider": provider], profile: profile)
        return json.string("activeProvider", "active_provider")
    }

    /// `POST /api/studio/tts/synthesize`. `provider` and that provider's
    /// stored options are sent exactly like the web client: without them the
    /// server resolves a provider itself and falls back to `edge`, so the
    /// phone spoke with Microsoft's free voice instead of the profile's.
    /// Every failure carries the status, the server's error text and the
    /// provider name; nothing is swallowed into a silent device-voice fallback.
    func synthesize(text: String, provider: String?, options: [String: String], profile: String) async throws -> SynthesizedSpeech {
        var request = URLRequest(url: try url("/api/studio/tts/synthesize"))
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        // Let Studio negotiate the active provider's native audio format.
        request.setValue("audio/*", forHTTPHeaderField: "Accept")
        request.setValue(profile, forHTTPHeaderField: "X-Hermes-Profile")
        request.httpBody = try JSONSerialization.data(
            withJSONObject: TtsRequest.body(text: text, provider: provider, options: options))

        let response: (Data, HTTPURLResponse)
        do {
            response = try await send(request)
        } catch {
            throw TtsFailure(provider: provider ?? "", status: 0, detail: error.localizedDescription)
        }
        let data = response.0
        let http = response.1

        let usedProvider = http.value(forHTTPHeaderField: "X-TTS-Provider")?.nilIfEmpty ?? provider ?? ""
        guard (200..<300).contains(http.statusCode) else {
            throw TtsFailure(provider: usedProvider, status: http.statusCode, detail: TtsErrorBody.detail(data))
        }
        guard !data.isEmpty else {
            throw TtsFailure(provider: usedProvider, status: http.statusCode,
                             detail: String(localized: "The voice provider returned no audio."))
        }
        // A JSON body with HTTP 200 is a provider failure in disguise.
        if TtsErrorBody.looksLikeJSON(contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "", data: data) {
            throw TtsFailure(provider: usedProvider, status: http.statusCode, detail: TtsErrorBody.detail(data))
        }
        return SynthesizedSpeech(audio: data, provider: usedProvider,
                                 engine: http.value(forHTTPHeaderField: "X-TTS-Engine") ?? "")
    }

    func runChatREST(profile: String, sessionID: String, input: String, attachments: [Upload], reasoningEffort: String?, model: String?, provider: String?) async throws -> (String, String) {
        let content: Any
        if attachments.isEmpty { content = input }
        else {
            var blocks: [JSON] = input.isEmpty ? [] : [["type": "text", "text": input]]
            blocks += attachments.map { ["type": $0.mime.hasPrefix("image/") ? "image" : "file", "name": $0.name, "path": $0.path, "media_type": $0.mime] }
            content = blocks
        }
        var body: JSON = ["input": content, "profile": profile, "session_id": sessionID]
        if let reasoningEffort, !reasoningEffort.isEmpty { body["reasoning_effort"] = reasoningEffort }
        if let model, !model.isEmpty { body["model"] = model }
        if let provider, !provider.isEmpty { body["provider"] = provider }
        let result = try await object("/api/studio/chat-run/runs", method: "POST", body: body, profile: profile)
        return (result.string("output", "message", "text"), result.string("reasoning", "thinking"))
    }

    private func multipartRequest(_ path: String, data: Data, name: String, mime: String, field: String, fields: [String: String] = [:], profile: String?) throws -> URLRequest {
        let boundary = "HermesBoundary\(UUID().uuidString)"
        var body = Data()
        for (key, value) in fields {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"\(key.replacingOccurrences(of: "\"", with: ""))\"\r\n\r\n")
            body.append("\(value)\r\n")
        }
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(name.replacingOccurrences(of: "\"", with: ""))\"\r\n")
        body.append("Content-Type: \(mime)\r\n\r\n")
        body.append(data); body.append("\r\n--\(boundary)--\r\n")
        var request = URLRequest(url: try url(path)); request.httpMethod = "POST"; request.httpBody = body
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let profile { request.setValue(profile, forHTTPHeaderField: "X-Hermes-Profile") }
        return request
    }

    private func multipart(_ path: String, data: Data, name: String, mime: String, field: String, fields: [String: String] = [:], profile: String?) async throws -> JSON {
        let request = try multipartRequest(path, data: data, name: name, mime: mime, field: field, fields: fields, profile: profile)
        let (responseData, _) = try await checkedSend(request)
        guard let json = try JSONSerialization.jsonObject(with: responseData) as? JSON else { throw HermesError.malformedResponse }
        return json
    }

    private func rawData(_ path: String) async throws -> Data {
        let (data, _) = try await checkedSend(URLRequest(url: try url(path)))
        return data
    }

    /// Request for `/api/studio/files/download`. The bearer token travels in
    /// the `Authorization` header only — never in the query string.
    func downloadRequest(path: String, name: String, profile: String) throws -> URLRequest {
        var components = URLComponents(string: baseURL + "/api/studio/files/download")
        components?.queryItems = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "name", value: name), URLQueryItem(name: "profile", value: profile)]
        guard let url = components?.url else { throw HermesError.invalidServer }
        var request = URLRequest(url: url)
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    /// Downloads an agent file and returns a local copy in the temporary
    /// directory, ready for Quick Look or sharing.
    func downloadFile(path: String, name: String, profile: String) async throws -> URL {
        let (data, _) = try await checkedSend(try downloadRequest(path: path, name: name, profile: profile))
        return try Self.writeTemporaryFile(data, name: name)
    }

    static func writeTemporaryFile(_ data: Data, name: String) throws -> URL {
        let safeName = name.replacingOccurrences(of: "/", with: "-").nilIfEmpty ?? "file"
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("downloads-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(safeName)
        try data.write(to: destination, options: .atomic)
        return destination
    }

    func logoData() async -> Data? {
        guard let url = try? url("/logo.png") else { return nil }
        guard let result = try? await send(URLRequest(url: url)), (200..<300).contains(result.1.statusCode) else { return nil }
        return result.0
    }

    private static func errorDetail(_ data: Data) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? JSON { return json.string("error", "message", "detail") }
        return String(data: data, encoding: .utf8)?.prefix(300).description ?? ""
    }

    private static func errorCode(_ data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? JSON else { return "" }
        return json.string("code")
    }
}

/// `GET /api/studio/stt/profile-status`.
struct SttProfileStatus: Equatable {
    let configured: Bool
    let activeProvider: String
    let reason: String

    init(_ json: JSON) {
        configured = json.bool("configured")
        activeProvider = json.string("activeProvider", "active_provider")
        reason = json.string("reason")
    }

    /// Human-readable explanation when the server cannot transcribe.
    var message: String {
        switch reason {
        case "active_stt_provider_missing":
            return String(localized: "No speech provider is active on the Core Hub server. Choose one under Studio → Voice.")
        case "browser_stt_not_available_for_mcu":
            return String(localized: "The server's active speech provider is the browser, which apps cannot use. Choose a server provider under Studio → Voice.")
        case "active_stt_provider_unsupported":
            return String(localized: "The server's active speech provider is not supported for uploads. Choose another provider under Studio → Voice.")
        case "local_stt_model_unavailable":
            return String(localized: "The server's local speech model is not downloaded yet. Download it under Studio → Voice.")
        case "active_stt_provider_secret_missing":
            return String(localized: "The server's speech provider has no API key. Add it under Studio → Voice.")
        default:
            return String(localized: "Speech transcription is not configured on the Core Hub server.")
        }
    }
}

/// `POST /api/studio/stt/transcribe` response.
struct Transcription: Equatable {
    let text: String
    let provider: String
    let model: String
    let language: String
    let durationMs: Int

    init(_ json: JSON) {
        text = json.string("text", "transcript").trimmingCharacters(in: .whitespacesAndNewlines)
        provider = json.string("provider")
        model = json.string("model")
        language = json.string("language")
        durationMs = json.int("durationMs")
    }
}

private extension Data {
    mutating func append(_ string: String) { if let data = string.data(using: .utf8) { append(data) } }
}

extension String {
    var urlEncoded: String { addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=?#/"))) ?? self }
}

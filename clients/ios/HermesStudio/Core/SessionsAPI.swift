import Foundation

/// M4: session, account-management and model-catalog routes that the web
/// client uses (`packages/client/src/api/studio/{sessions,auth}.ts`,
/// `api/hermes/{system,model-context}.ts`).
extension APIClient {
    // MARK: Sessions

    /// `GET /api/studio/sessions/search?q=` — matches titles and message
    /// text; every hit carries the matched snippet.
    func searchSessionMatches(_ query: String, profile: String? = nil, limit: Int = 100) async throws -> [SessionSearchResult] {
        var path = "/api/studio/sessions/search?q=\(query.urlEncoded)&limit=\(limit)"
        if let profile = profile?.nilIfEmpty { path += "&profile=\(profile.urlEncoded)" }
        return try await array(path, keys: ["results"]).map { SessionSearchResult($0, profile: profile ?? "") }.filter { !$0.session.id.isEmpty }
    }

    /// `GET /api/studio/sessions/hermes/groups?limit=&profile=` — the History
    /// groups per source; unlike `/sessions` they include archived sessions,
    /// which is how the web lists them with "Unarchive".
    func historySessionGroups(profile: String? = nil, limit: Int = 100) async throws -> [SessionSummary] {
        var path = "/api/studio/sessions/hermes/groups?limit=\(limit)"
        if let profile = profile?.nilIfEmpty { path += "&profile=\(profile.urlEncoded)" }
        let root = try await object(path)
        var seen: Set<String> = []
        var result: [SessionSummary] = []
        for group in root.objects("groups") {
            for row in group.objects("sessions") {
                let session = SessionSummary(row, profile: profile ?? "")
                guard !session.id.isEmpty, !seen.contains(session.id) else { continue }
                seen.insert(session.id); result.append(session)
            }
        }
        for row in root.objects("included") {
            let session = SessionSummary(row, profile: profile ?? "")
            guard !session.id.isEmpty, !seen.contains(session.id) else { continue }
            seen.insert(session.id); result.append(session)
        }
        return result
    }

    /// `GET /sessions/conversations/{id}/messages/paginated?offset=&limit=`.
    func messagePage(sessionID: String, offset: Int, limit: Int, profile: String? = nil) async throws -> MessagePage {
        var path = "/api/studio/sessions/conversations/\(sessionID.urlEncoded)/messages/paginated?offset=\(max(0, offset))&limit=\(max(1, limit))"
        if let profile = profile?.nilIfEmpty { path += "&profile=\(profile.urlEncoded)" }
        return MessagePage(try await object(path, profile: profile))
    }

    /// `GET /sessions/{id}/context` — what the model currently sees.
    func sessionContext(_ id: String, profile: String? = nil) async throws -> [SessionContextMessage] {
        let query = profile?.nilIfEmpty.map { "?profile=\($0.urlEncoded)" } ?? ""
        return try await object("/api/studio/sessions/\(id.urlEncoded)/context\(query)", profile: profile).objects("messages").map(SessionContextMessage.init)
    }

    /// `GET /sessions/{id}/usage`.
    func sessionUsage(_ id: String) async throws -> SessionUsage {
        SessionUsage(try await object("/api/studio/sessions/\(id.urlEncoded)/usage"))
    }

    /// `GET /sessions/usage?ids=a,b` → id → usage.
    func sessionUsages(_ ids: [String]) async throws -> [String: SessionUsage] {
        guard !ids.isEmpty else { return [:] }
        let root = try await object("/api/studio/sessions/usage?ids=\(ids.joined(separator: ",").urlEncoded)")
        var result: [String: SessionUsage] = [:]
        for (key, value) in root { if let json = value as? JSON { result[key] = SessionUsage(json) } }
        return result
    }

    /// `POST /sessions/batch-archive { ids, archived }`.
    func batchArchiveSessions(_ ids: [String], archived: Bool) async throws -> BatchResult {
        BatchResult(try await object("/api/studio/sessions/batch-archive", method: "POST", body: ["ids": ids, "archived": archived]), successKey: "updated")
    }

    func batchDeleteSessionsResult(_ sessions: [SessionSummary]) async throws -> BatchResult {
        BatchResult(try await batchDeleteSessions(sessions), successKey: "deleted")
    }

    /// `POST /sessions/{id}/reasoning-effort { reasoningEffort }`.
    func setSessionReasoningEffort(_ id: String, effort: String) async throws {
        _ = try await object("/api/studio/sessions/\(id.urlEncoded)/reasoning-effort", method: "POST", body: ["reasoningEffort": effort])
    }

    // MARK: Account management (super-admin)

    func managedUsers() async throws -> (users: [ManagedUser], profiles: [String]) {
        let root = try await object("/api/auth/users")
        return (root.objects("users").map(ManagedUser.init), root.strings("profiles"))
    }

    static func managedUserBody(username: String, password: String, role: String, status: String, profiles: [String], defaultProfile: String) -> JSON {
        var body: JSON = ["username": username, "role": role, "status": status, "profiles": profiles]
        if !password.isEmpty { body["password"] = password }
        body["defaultProfile"] = defaultProfile.nilIfEmpty.map { $0 as Any } ?? NSNull()
        return body
    }

    func createManagedUser(_ body: JSON) async throws { _ = try await object("/api/auth/users", method: "POST", body: body) }
    func updateManagedUser(_ id: Int, body: JSON) async throws { _ = try await object("/api/auth/users/\(id)", method: "PUT", body: body) }
    func deleteManagedUser(_ id: Int) async throws { _ = try await object("/api/auth/users/\(id)", method: "DELETE") }

    // MARK: Models tab

    func modelCatalog(profile: String) async throws -> ModelCatalog {
        ModelCatalog(try await object("/api/hermes/available-models?profile=\(profile.urlEncoded)", profile: profile))
    }

    /// `PUT /api/hermes/config/providers/{poolKey}` — API key / base URL / name.
    func updateProviderPool(_ poolKey: String, apiKey: String?, baseURL: String?, name: String?) async throws {
        var body: JSON = [:]
        if let apiKey { body["api_key"] = apiKey }
        if let baseURL { body["base_url"] = baseURL }
        if let name { body["name"] = name }
        _ = try await object("/api/hermes/config/providers/\(poolKey.urlEncoded)", method: "PUT", body: body)
    }

    /// `POST /api/hermes/config/providers` — a custom provider pool.
    func addCustomProvider(name: String, baseURL: String, apiKey: String, apiMode: String?) async throws {
        var body: JSON = ["name": name, "base_url": baseURL, "api_key": apiKey]
        if let apiMode = apiMode?.nilIfEmpty { body["api_mode"] = apiMode }
        _ = try await object("/api/hermes/config/providers", method: "POST", body: body)
    }

    func removeCustomProvider(_ poolKey: String) async throws {
        _ = try await object("/api/hermes/config/providers/\(poolKey.urlEncoded)", method: "DELETE")
    }

    /// `PUT /api/hermes/model-alias { provider, model, alias }` (empty alias clears).
    func setModelAlias(provider: String, model: String, alias: String) async throws {
        _ = try await object("/api/hermes/model-alias", method: "PUT", body: ["provider": provider, "model": model, "alias": alias])
    }

    /// `PUT /api/hermes/model-visibility { provider, mode, models }`.
    func setModelVisibility(provider: String, mode: String, models: [String]) async throws {
        _ = try await object("/api/hermes/model-visibility", method: "PUT", body: ["provider": provider, "mode": mode, "models": models])
    }

    /// `PUT /api/hermes/custom-model { provider, model }`.
    func addCustomModel(provider: String, model: String) async throws {
        _ = try await object("/api/hermes/custom-model", method: "PUT", body: ["provider": provider, "model": model])
    }

    /// `DELETE /api/hermes/custom-model?provider=&model=`.
    func removeCustomModel(provider: String, model: String) async throws {
        _ = try await object("/api/hermes/custom-model?provider=\(provider.urlEncoded)&model=\(model.urlEncoded)", method: "DELETE")
    }

    /// `GET /api/hermes/model-context?provider=&model=` (404 → nil).
    func modelContextLimit(provider: String, model: String) async throws -> ModelContextLimit? {
        do {
            let root = try await object("/api/hermes/model-context?provider=\(provider.urlEncoded)&model=\(model.urlEncoded)")
            let data = root.object("data").isEmpty ? root : root.object("data")
            return data.int("context_limit") > 0 ? ModelContextLimit(data) : nil
        } catch HermesError.http(404, _) {
            return nil
        }
    }

    /// `PUT /api/hermes/model-context/{provider}/{model} { context_limit }`.
    func setModelContextLimit(provider: String, model: String, limit: Int) async throws {
        _ = try await object("/api/hermes/model-context/\(provider.urlEncoded)/\(model.urlEncoded)", method: "PUT", body: ["provider": provider, "model": model, "context_limit": limit])
    }
}

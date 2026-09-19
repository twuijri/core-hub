import Foundation

/// Room detail returned by `GET /api/studio/group-chat/rooms/{roomId}`.
struct RoomDetail {
    let room: Room
    let messages: [GroupMessage]
    let agents: [RoomAgent]
    let members: [RoomMember]
    let handoffs: [HandoffChain]
    let total: Int
    let hasMore: Bool

    init(_ json: JSON) {
        let roomJSON = json.object("room").isEmpty ? json : json.object("room")
        room = Room(roomJSON)
        messages = json.objects("messages").map(GroupMessage.init)
        agents = json.objects("agents").map(RoomAgent.init)
        members = json.objects("members").map(RoomMember.init)
        handoffs = json.objects("handoffChains").map(HandoffChain.init)
        total = json.int("total")
        hasMore = json.bool("hasMore")
    }
}

/// Group-chat REST routes (`packages/client/src/api/studio/group-chat.ts`).
extension APIClient {
    static let groupChatBase = "/api/studio/group-chat"

    func rooms() async throws -> [Room] {
        try await array("\(Self.groupChatBase)/rooms", keys: ["rooms"]).map(Room.init).filter { !$0.id.isEmpty }
    }

    /// `?limit=&offset=` pages the persisted history (`before` = message id
    /// for older pages, `history=1` lets the server page past the live window).
    func roomDetail(_ id: String, limit: Int = 150, before: String? = nil) async throws -> RoomDetail {
        var path = "\(Self.groupChatBase)/rooms/\(id.urlEncoded)?limit=\(limit)"
        if let before = before?.nilIfEmpty { path += "&before=\(before.urlEncoded)&history=1" }
        return RoomDetail(try await object(path))
    }

    /// `POST /rooms` — `summary` is required by the server (profile, provider,
    /// model, apiMode, everyTurns); `agents` may reference presets.
    func createRoom(name: String, inviteCode: String, agents: [RoomAgentInput], summary: JSON, workspace: String?, memberName: String?) async throws -> Room {
        var body: JSON = ["name": name, "inviteCode": inviteCode, "agents": agents.map(\.body), "summary": summary]
        if let workspace = workspace?.nilIfEmpty { body["workspace"] = workspace }
        if let memberName = memberName?.nilIfEmpty { body["memberName"] = memberName }
        let root = try await object("\(Self.groupChatBase)/rooms", method: "POST", body: body)
        return Room(root.object("room"))
    }

    func cloneRoom(_ id: String, name: String?, inviteCode: String?) async throws -> Room {
        var body: JSON = [:]
        if let name = name?.nilIfEmpty { body["name"] = name }
        if let inviteCode = inviteCode?.nilIfEmpty { body["inviteCode"] = inviteCode }
        return Room(try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/clone", method: "POST", body: body).object("room"))
    }

    func deleteRoom(_ id: String) async throws { _ = try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)", method: "DELETE") }

    /// `PUT /rooms/{roomId}/config` — name, summary settings and handoff policy.
    func updateRoomConfig(_ id: String, config: JSON) async throws -> Room {
        Room(try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/config", method: "PUT", body: config).object("room"))
    }

    func updateRoomWorkspace(_ id: String, workspace: String) async throws -> Room {
        Room(try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/workspace", method: "PUT", body: ["workspace": workspace]).object("room"))
    }

    func updateRoomInviteCode(_ id: String, inviteCode: String) async throws {
        _ = try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/invite-code", method: "PUT", body: ["inviteCode": inviteCode])
    }

    func roomAgents(_ id: String) async throws -> [RoomAgent] {
        try await array("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/agents", keys: ["agents"]).map(RoomAgent.init)
    }

    func addRoomAgent(_ id: String, input: RoomAgentInput) async throws -> RoomAgent {
        RoomAgent(try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/agents", method: "POST", body: input.body).object("agent"))
    }

    func updateRoomAgent(_ id: String, agentID: String, input: RoomAgentInput) async throws -> [RoomAgent] {
        let root = try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/agents/\(agentID.urlEncoded)", method: "PUT", body: input.body)
        return root.objects("agents").map(RoomAgent.init)
    }

    func removeRoomAgent(_ id: String, agentID: String) async throws {
        _ = try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/agents/\(agentID.urlEncoded)", method: "DELETE")
    }

    func removeRoomMember(_ id: String, userID: String) async throws {
        _ = try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/members/\(userID.urlEncoded)", method: "DELETE")
    }

    func clearRoomContext(_ id: String) async throws -> Room {
        Room(try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/clear-context", method: "POST").object("room"))
    }

    func roomSummary(_ id: String) async throws -> RoomSummaryState {
        let root = try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/summary")
        return RoomSummaryState(root.object("summary"), anchor: root.object("anchor"))
    }

    func updateRoomSummary(_ id: String, summary: String) async throws -> RoomSummaryState {
        RoomSummaryState(try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/summary", method: "PUT", body: ["summary": summary]).object("summary"))
    }

    func roomHandoffs(_ id: String) async throws -> [HandoffChain] {
        try await array("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/handoffs", keys: ["chains"]).map(HandoffChain.init)
    }

    func continueRoomHandoff(_ id: String, chainID: String) async throws -> HandoffChain {
        HandoffChain(try await object("\(Self.groupChatBase)/rooms/\(id.urlEncoded)/handoffs/\(chainID.urlEncoded)/continue", method: "POST").object("chain"))
    }

    /// `GET /rooms/join/{code}` — resolves an invite code to its room.
    func resolveInvite(_ code: String) async throws -> Room {
        Room(try await object("\(Self.groupChatBase)/rooms/join/\(code.urlEncoded)").object("room"))
    }

    // MARK: Agent presets

    func agentPresets(profile: String? = nil) async throws -> [GroupAgentPreset] {
        let query = profile?.nilIfEmpty.map { "?profile=\($0.urlEncoded)" } ?? ""
        return try await array("\(Self.groupChatBase)/agent-presets\(query)", keys: ["presets"]).map(GroupAgentPreset.init)
    }

    static func presetBody(_ input: RoomAgentInput) -> JSON {
        var body = input.body
        body.removeValue(forKey: "presetId")
        body["name"] = input.name
        body["description"] = input.description
        body["avatar"] = input.avatar
        return body
    }

    func createAgentPreset(_ input: RoomAgentInput) async throws -> GroupAgentPreset {
        GroupAgentPreset(try await object("\(Self.groupChatBase)/agent-presets", method: "POST", body: Self.presetBody(input)).object("preset"))
    }

    func updateAgentPreset(_ id: String, input: RoomAgentInput) async throws -> GroupAgentPreset {
        GroupAgentPreset(try await object("\(Self.groupChatBase)/agent-presets/\(id.urlEncoded)", method: "PUT", body: Self.presetBody(input)).object("preset"))
    }

    func deleteAgentPreset(_ id: String) async throws {
        _ = try await object("\(Self.groupChatBase)/agent-presets/\(id.urlEncoded)", method: "DELETE")
    }

    // MARK: Attachments

    /// `POST /rooms/{roomId}/attachments` (multipart `file`) → `{ files: [{ name, path }] }`.
    func uploadRoomAttachment(roomID: String, data: Data, name: String, mime: String) async throws -> Upload {
        let root = try await multipartUpload("\(Self.groupChatBase)/rooms/\(roomID.urlEncoded)/attachments", data: data, name: name, mime: mime, field: "file")
        guard let file = root.objects("files").first, let path = file.string("path").nilIfEmpty else { throw HermesError.malformedResponse }
        return Upload(name: file.string("name").nilIfEmpty ?? name, path: path, mime: mime)
    }

    /// Chunked room upload (same shape as `app-uploads`): `POST …/attachment-uploads`
    /// → `PUT …/attachment-uploads/{id}/chunks?offset=` → `POST …/complete`.
    func uploadRoomAttachmentChunked(roomID: String, id: String, name: String, mime: String, data: Data, progress: @escaping @Sendable (Int) -> Void) async throws -> Upload {
        guard data.count <= AppUploadPlan.maxBytes else { throw HermesError.server(String(localized: "Attachments are limited to 50 MB.")) }
        let base = "\(Self.groupChatBase)/rooms/\(roomID.urlEncoded)/attachment-uploads"
        let session = AppUploadSession(try await object(base, method: "POST", body: ["id": id, "name": name, "size": data.count]))
        var offset = session.nextOffset
        do {
            for range in AppUploadPlan.chunks(size: data.count, maxChunkBytes: session.maxChunkBytes) where range.lowerBound >= offset {
                try Task.checkCancellation()
                var request = URLRequest(url: try url("\(base)/\(session.id.urlEncoded)/chunks?offset=\(range.lowerBound)"))
                request.httpMethod = "PUT"
                request.httpBody = data.subdata(in: range)
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                let (responseData, http) = try await send(request)
                guard (200..<300).contains(http.statusCode) else { throw HermesError.http(http.statusCode, Self.errorDetailText(responseData)) }
                let json = (try? JSONSerialization.jsonObject(with: responseData) as? JSON) ?? [:]
                let next = json.int("nextOffset", default: json.int("next_offset", default: -1))
                offset = next >= 0 ? next : range.upperBound
                progress(offset)
            }
            try Task.checkCancellation()
            let root = try await object("\(base)/\(session.id.urlEncoded)/complete", method: "POST")
            guard let file = root.objects("files").first, let path = file.string("path").nilIfEmpty else { throw HermesError.malformedResponse }
            return Upload(name: file.string("name").nilIfEmpty ?? name, path: path, mime: mime)
        } catch {
            _ = try? await object("\(base)/\(session.id.urlEncoded)", method: "DELETE")
            throw error
        }
    }

    /// Bearer request for `/rooms/{roomId}/attachments/{file}?name=` — used
    /// by media players and download cards for room files.
    func roomAttachmentRequest(roomID: String, path: String, name: String) throws -> URLRequest {
        let stored = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? path
        var components = URLComponents(string: baseURL + "\(Self.groupChatBase)/rooms/\(roomID.urlEncoded)/attachments/\(stored.urlEncoded)")
        if !name.isEmpty { components?.queryItems = [URLQueryItem(name: "name", value: name)] }
        guard let url = components?.url else { throw HermesError.invalidServer }
        var request = URLRequest(url: url)
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    func downloadRoomAttachment(roomID: String, path: String, name: String) async throws -> URL {
        let request = try roomAttachmentRequest(roomID: roomID, path: path, name: name)
        let (data, http) = try await send(request)
        guard (200..<300).contains(http.statusCode) else { throw HermesError.http(http.statusCode, Self.errorDetailText(data)) }
        return try Self.writeTemporaryFile(data, name: name.nilIfEmpty ?? "attachment")
    }

    private func multipartUpload(_ path: String, data: Data, name: String, mime: String, field: String) async throws -> JSON {
        let boundary = "HermesBoundary\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { if let chunk = text.data(using: .utf8) { body.append(chunk) } }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(name.replacingOccurrences(of: "\"", with: ""))\"\r\n")
        append("Content-Type: \(mime)\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")
        var request = URLRequest(url: try url(path))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (responseData, http) = try await send(request)
        guard (200..<300).contains(http.statusCode) else { throw HermesError.http(http.statusCode, Self.errorDetailText(responseData)) }
        guard let json = try JSONSerialization.jsonObject(with: responseData) as? JSON else { throw HermesError.malformedResponse }
        return json
    }
}

/// Invite link and QR payload for a room (rendered with CoreImage).
enum RoomInviteLink {
    /// `{server}/share/group-chat/{code}` — the web's public join route
    /// (`packages/client/src/router/index.ts`).
    static func url(server: String, inviteCode: String) -> URL? {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty, !inviteCode.isEmpty else { return nil }
        return URL(string: trimmed + "/share/group-chat/" + inviteCode.urlEncoded)
    }

    /// Random 8-character invite code (A–Z, 2–9, no ambiguous glyphs).
    static func generateCode(length: Int = 8) -> String {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        return String((0..<max(4, length)).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
    }
}

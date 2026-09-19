import Foundation

/// One `tool.started` / `tool.completed` / `tool.failed` payload.
struct ToolEvent: Hashable {
    let id: String
    let name: String
    let status: ToolStatus
    let detail: String?
    let arguments: String?
    let output: String?
    let outputTruncated: Bool
    let outputOriginalLength: Int?
    let previewTruncated: Bool
    let reasoning: String?
    let duration: Double?

    static func parse(event: String, json: JSON) -> ToolEvent {
        let rawID = json.string("tool_call_id", "call_id", "id")
        let name = json.string("tool", "name", "tool_name", "function_name").nilIfEmpty ?? "tool"
        let status: ToolStatus = event == "tool.started" ? .running : (event == "tool.failed" || json.bool("error") || json.bool("is_error") ? .error : .done)
        let duration: Double? = json["duration"] != nil ? json.double("duration") : (json["duration_seconds"] != nil ? json.double("duration_seconds") : nil)
        let originalLength = json["output_original_length"] == nil ? nil : json.int("output_original_length")
        return ToolEvent(
            id: rawID.isEmpty ? "\(name)-\(UUID().uuidString)" : rawID,
            name: name,
            status: status,
            detail: detailText(json),
            arguments: argumentsText(json),
            output: outputText(json),
            outputTruncated: json.bool("output_truncated"),
            outputOriginalLength: originalLength,
            previewTruncated: json.bool("preview_truncated"),
            reasoning: json.string("reasoning", "thinking").nilIfEmpty,
            duration: duration
        )
    }

    /// Single-line preview: the server `preview`, else the most descriptive argument.
    static func detailText(_ json: JSON) -> String? {
        if let detail = json.string("preview", "detail").nilIfEmpty { return detail.replacingOccurrences(of: "\n", with: " ") }
        if let object = json["arguments"] as? JSON {
            for key in ["command", "cmd", "path", "file_path", "query", "url", "prompt"] { if let value = object.string(key).nilIfEmpty { return value.replacingOccurrences(of: "\n", with: " ") } }
        }
        return (json["arguments"] as? String)?.replacingOccurrences(of: "\n", with: " ").nilIfEmpty
    }

    static func argumentsText(_ json: JSON) -> String? {
        if let text = json["arguments"] as? String { return text.nilIfEmpty }
        if let object = json["arguments"] as? JSON, let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) { return String(data: data, encoding: .utf8) }
        return nil
    }

    static func outputText(_ json: JSON) -> String? {
        if let text = json["output"] as? String { return text.nilIfEmpty }
        if let text = json["result"] as? String { return text.nilIfEmpty }
        if let any = json["output"] ?? json["result"], JSONSerialization.isValidJSONObject(any), let data = try? JSONSerialization.data(withJSONObject: any, options: [.prettyPrinted, .sortedKeys]) { return String(data: data, encoding: .utf8) }
        if let message = json.string("error", "message").nilIfEmpty, json.bool("error") == false { return message }
        return json.string("error").nilIfEmpty
    }
}

struct ResumeState: Hashable {
    var workspace: String
    var model: String
    var provider: String
    var apiMode: String
    var pushEnabled: Bool
    var workspaceChanges: [String]
}

struct ResumeCompletion: Hashable {
    let output: String
    let reasoning: String
}

struct SessionSettingsUpdate: Hashable {
    var model: String
    var provider: String
    var apiMode: String
    var reasoningEffort: String?
    var pushEnabled: Bool?

    init(_ json: JSON) {
        model = json.string("model"); provider = json.string("provider"); apiMode = json.string("api_mode")
        reasoningEffort = json["reasoning_effort"] == nil ? nil : json.string("reasoning_effort")
        pushEnabled = json["push_enabled"] == nil ? nil : json.bool("push_enabled")
    }
}

struct SessionCommandResult: Hashable {
    let command: String
    let ok: Bool
    let action: String
    let message: String
    let terminal: Bool

    init(_ json: JSON) {
        command = json.string("command")
        ok = json["ok"] == nil ? true : json.bool("ok")
        action = json.string("action")
        message = json.string("message", "text", "error")
        terminal = json["terminal"] == nil ? true : json.bool("terminal")
    }
}

/// `location.requested` from the server (this phone is the target device).
struct LocationRequest: Hashable {
    let id: String
    let sessionID: String
    let purpose: String
    let accuracy: String
    let timeoutMs: Int

    init(_ json: JSON) {
        id = json.string("location_request_id")
        sessionID = json.string("session_id")
        purpose = json.string("purpose")
        accuracy = json.string("accuracy").nilIfEmpty ?? "coarse"
        timeoutMs = json.int("timeout_ms", default: 30_000)
    }
}

enum LiveRunEvent {
    case connected
    case disconnected(String?)
    case started(Date)
    case text(String)
    case interim(String)
    case reasoning(String)
    case thinkingAvailable
    case tool(ToolEvent)
    case usage(contextTokens: Int, contextWindow: Int?)
    case completed(output: String, reasoning: String, interrupted: Bool)
    case requiresAction(ChatInteraction)
    case actionResolved(id: String, choice: String)
    case queued([QueuedRun])
    case queueInsertion(id: String, phase: String)
    case subagent(id: String, event: String, title: String, detail: String)
    case resumeState(ResumeState)
    case resumed(isWorking: Bool, completion: ResumeCompletion?)
    case settingsUpdated(SessionSettingsUpdate)
    case titleUpdated(String)
    case workspaceUpdated(String)
    case compression(phase: String, messageCount: Int, tokenCount: Int)
    case abort(phase: String)
    case peerMessage(role: String, content: String, timestamp: Date?)
    case sessionCommand(SessionCommandResult)
    case locationRequested(LocationRequest)
    case deviceRequested(kind: String, requestID: String)
    case workspaceDiff(summary: String)
    case failed(String, retryable: Bool)
}

struct QueuedRun: Identifiable, Hashable {
    let id: String
    let text: String
    init(_ json: JSON) { id = json.string("id", "queue_id"); text = json.string("content", "input", "text") }
}

private final class ChatReconnectTask: @unchecked Sendable {
    var value: Task<Void, Never>?
    var closed = false
    var attempt = 0
}

final class SocketIOConnection: @unchecked Sendable {
    private let baseURL: String
    private let token: String
    private let namespace: String
    private let profile: String?
    private let platform: String?
    private var socket: URLSessionWebSocketTask?
    private var readTask: Task<Void, Never>?
    private var onPacket: ((String) -> Void)?
    private(set) var isConnected = false

    init(baseURL: String, token: String, namespace: String, profile: String? = nil, platform: String? = nil) {
        self.baseURL = baseURL; self.token = token; self.namespace = namespace; self.profile = profile; self.platform = platform
    }

    /// `/socket.io/?EIO=4&transport=websocket&profile=…&platform=ios`; the
    /// `platform` query registers the phone as a mobile device target.
    static func handshakeURL(baseURL: String, profile: String?, platform: String?) -> URL? {
        guard var components = URLComponents(string: baseURL) else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/socket.io/"
        var items = [URLQueryItem(name: "EIO", value: "4"), URLQueryItem(name: "transport", value: "websocket")]
        if let profile, !profile.isEmpty { items.append(URLQueryItem(name: "profile", value: profile)) }
        if let platform, !platform.isEmpty { items.append(URLQueryItem(name: "platform", value: platform)) }
        components.queryItems = items
        return components.url
    }

    func connect(onPacket: @escaping (String) -> Void) {
        close()
        self.onPacket = onPacket
        guard let url = Self.handshakeURL(baseURL: baseURL, profile: profile, platform: platform) else { onPacket("__error__:invalid server"); return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let task = URLSession(configuration: .default).webSocketTask(with: request)
        socket = task; task.resume()
        readTask = Task { [weak self] in await self?.readLoop() }
    }

    func emit(_ event: String, payload: Any, ackID: Int? = nil) {
        guard let data = try? JSONSerialization.data(withJSONObject: [event, payload]), let json = String(data: data, encoding: .utf8) else { return }
        let ack = ackID.map(String.init) ?? ""
        send("42\(namespace),\(ack)\(json)")
    }

    private var nextAckID = 1
    private var acks: [Int: (Any?) -> Void] = [:]
    private let ackLock = NSLock()

    /// Emits with a Socket.IO acknowledgement (`42{ns},{id}[...]` →
    /// `43{ns},{id}[response]`). The callback receives the first ack argument.
    func emitWithAck(_ event: String, payload: Any, timeout: TimeInterval = 30, completion: @escaping (Any?) -> Void) {
        ackLock.lock()
        let id = nextAckID
        nextAckID += 1
        acks[id] = completion
        ackLock.unlock()
        emit(event, payload: payload, ackID: id)
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self else { return }
            self.ackLock.lock()
            let pending = self.acks.removeValue(forKey: id)
            self.ackLock.unlock()
            pending?(["error": "timeout"])
        }
    }

    /// Async wrapper around `emitWithAck`.
    func request(_ event: String, payload: Any, timeout: TimeInterval = 30) async -> JSON {
        await withCheckedContinuation { continuation in
            emitWithAck(event, payload: payload, timeout: timeout) { response in
                continuation.resume(returning: (response as? JSON) ?? [:])
            }
        }
    }

    /// Handles `43{ns},{id}[...]`. Returns true when the packet was an ack.
    private func handleAck(_ packet: String) -> Bool {
        let prefix = "43\(namespace),"
        guard packet.hasPrefix(prefix), let bracket = packet.firstIndex(of: "[") else { return false }
        let idText = packet[packet.index(packet.startIndex, offsetBy: prefix.count)..<bracket]
        guard let id = Int(idText) else { return false }
        ackLock.lock()
        let pending = acks.removeValue(forKey: id)
        ackLock.unlock()
        guard let pending else { return true }
        let jsonText = String(packet[bracket...])
        let array = jsonText.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [Any] } ?? []
        pending(array.first)
        return true
    }

    func close() {
        readTask?.cancel(); readTask = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        isConnected = false
        onPacket = nil
        ackLock.lock()
        let pending = acks
        acks = [:]
        ackLock.unlock()
        for (_, callback) in pending { callback(["error": "disconnected"]) }
    }

    private func send(_ text: String) { socket?.send(.string(text)) { [weak self] error in if let error { self?.onPacket?("__error__:\(error.localizedDescription)") } } }

    private func readLoop() async {
        while !Task.isCancelled, let socket {
            do {
                let message = try await socket.receive()
                let text: String
                switch message { case let .string(value): text = value; case let .data(data): text = String(data: data, encoding: .utf8) ?? ""; @unknown default: text = "" }
                for packet in text.components(separatedBy: "\u{001e}") { process(packet) }
            } catch {
                if !Task.isCancelled { onPacket?("__error__:\(error.localizedDescription)") }
                break
            }
        }
    }

    private func process(_ packet: String) {
        if packet == "2" || packet.hasPrefix("2") && packet.dropFirst().allSatisfy(\.isNumber) { send("3" + String(packet.dropFirst())); return }
        if packet.hasPrefix("0") {
            let auth = token.isEmpty ? JSON() : ["token": token]
            let data = (try? JSONSerialization.data(withJSONObject: auth)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            send("40\(namespace),\(data)")
            return
        }
        if packet.hasPrefix("40\(namespace)") { isConnected = true; onPacket?("__connected__"); return }
        if packet.hasPrefix("41\(namespace)") { isConnected = false; onPacket?("__disconnected__"); return }
        if handleAck(packet) { return }
        onPacket?(packet)
    }
}

/// Persistent `/chat-run` connection for one conversation. It stays open while
/// the conversation is on screen so device requests (location, calendar…)
/// and peer messages arrive even when no run is active; it reconnects with
/// exponential backoff and re-attaches through `app.resume`.
final class ChatSocket: @unchecked Sendable {
    private var connection: SocketIOConnection?
    private var sessionID = ""
    private(set) var isConnected = false
    /// Whether the server already knows this session id.
    ///
    /// Every per-session event (`app.resume`, `abort`, the queue events…)
    /// is answered with `run.failed: Session not found` when it does not,
    /// which is the case for a brand-new chat — its id is minted on the
    /// phone and only the first `run` persists it — and for a session that
    /// was deleted on the server. `app.resume` is emitted on every connect
    /// and on every reconnect, so sending it blind is what stacked the red
    /// rows on Android.
    private(set) var sessionExists = false

    /// The first accepted `run` persists the session, so from then on the
    /// per-session events are safe.
    func markSessionExists() { sessionExists = true }
    /// The server reported the session gone; stop talking about it.
    func markSessionGone() { sessionExists = false }

    /// Per-session events are pointless — and answered with an error —
    /// without a live connection and a session the server knows.
    private func emitForSession(_ event: String, _ payload: JSON) {
        guard let id = payload["session_id"] as? String, !id.isEmpty, sessionExists else { return }
        connection?.emit(event, payload: payload)
    }

    func abort(sessionID: String) { emitForSession("abort", ["session_id": sessionID]) }
    func resumeApp(sessionID: String) { emitForSession("app.resume", ["session_id": sessionID, "id": Self.cachedResumeID(sessionID)]) }
    func respondToApproval(sessionID: String, approvalID: String, choice: String) {
        emitForSession("approval.respond", ["session_id": sessionID, "approval_id": approvalID, "choice": choice])
    }
    func respondToClarification(sessionID: String, clarificationID: String, answer: String) {
        emitForSession("clarify.respond", Self.clarificationPayload(sessionID: sessionID, clarificationID: clarificationID, answer: answer))
    }
    static func clarificationPayload(sessionID: String, clarificationID: String, answer: String) -> JSON { ["session_id": sessionID, "clarify_id": clarificationID, "response": answer] }
    func cancelQueued(sessionID: String, queueID: String) { emitForSession("cancel_queued_run", ["session_id": sessionID, "queue_id": queueID]) }
    func insertQueued(sessionID: String, queueID: String) { emitForSession("insert_queued_run", ["session_id": sessionID, "queue_id": queueID]) }
    func steerQueued(sessionID: String, queueID: String) { emitForSession("steer_queued_run", ["session_id": sessionID, "queue_id": queueID]) }
    func respondToLocation(_ payload: JSON) { connection?.emit("location.respond", payload: payload) }
    /// Calendar / reminder / health requests are answered `denied` until the
    /// native integrations land (see docs/mobile/PLAN.md).
    func denyDeviceRequest(kind: String, sessionID: String, requestID: String) {
        emitForSession("\(kind).respond", ["session_id": sessionID, "\(kind)_request_id": requestID, "status": "denied"])
    }

    /// Emits `run`. Returns false when the socket is not connected so the
    /// caller can fall back to the REST endpoint.
    @discardableResult
    func run(_ payload: JSON) -> Bool {
        guard let connection, connection.isConnected else { return false }
        guard let id = payload["session_id"] as? String, !id.isEmpty else { return false }
        connection.emit("run", payload: payload)
        // `run` is the one event that creates the session when the id is
        // unknown, so after it the session exists.
        sessionExists = true
        return true
    }

    func enqueue(_ payload: JSON) -> Bool {
        var queued = payload
        queued["queue_id"] = UUID().uuidString
        return run(queued)
    }

    func close() { connection?.close(); connection = nil; isConnected = false }

    /// Opens the connection and streams every session event until `close()`.
    func open(baseURL: String, token: String, profile: String, sessionID: String, sessionExists: Bool) -> AsyncStream<LiveRunEvent> {
        close()
        self.sessionID = sessionID
        self.sessionExists = sessionExists && !sessionID.isEmpty
        return AsyncStream { continuation in
            let live = SocketIOConnection(baseURL: baseURL, token: token, namespace: "/chat-run", profile: profile, platform: "ios")
            self.connection = live
            let retryTask = ChatReconnectTask()
            var handlePacket: ((String) -> Void)!

            func scheduleReconnect() {
                guard !retryTask.closed, retryTask.value == nil else { return }
                let delay = min(pow(2.0, Double(retryTask.attempt)), 30.0)
                retryTask.attempt += 1
                retryTask.value = Task {
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled, !retryTask.closed else { return }
                    retryTask.value = nil
                    live.connect(onPacket: handlePacket)
                }
            }

            handlePacket = { [weak self] packet in
                if packet == "__connected__" {
                    retryTask.attempt = 0
                    self?.isConnected = true
                    continuation.yield(.connected)
                    // Resuming a session the server never stored answers
                    // `run.failed: Session not found`, once per reconnect.
                    if self?.sessionExists == true {
                        live.emit("app.resume", payload: ["session_id": sessionID, "id": Self.cachedResumeID(sessionID)])
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
                guard let (event, json) = Self.event(packet, namespace: "/chat-run") else { return }
                for item in Self.events(for: event, json: json, sessionID: sessionID) { continuation.yield(item) }
            }
            live.connect(onPacket: handlePacket)
            continuation.onTermination = { [weak self] _ in retryTask.closed = true; retryTask.value?.cancel(); self?.close() }
        }
    }

    /// Translates one server event into stream events (pure; unit-tested).
    static func events(for event: String, json: JSON, sessionID: String) -> [LiveRunEvent] {
        var out: [LiveRunEvent] = []
        switch event {
        case "resumed", "app.resumed":
            let restored = restoredResume(json, sessionID: sessionID)
            if let usage = usage(restored) { out.append(usage) }
            out.append(.resumeState(ResumeState(workspace: restored.string("workspace"), model: restored.string("model"), provider: restored.string("provider"), apiMode: restored.string("api_mode"), pushEnabled: restored.bool("push_enabled", default: true), workspaceChanges: restored.objects("workspaceRunChanges").map(workspaceChangeSummary))))
            out.append(.queued(restored.objects("queueMessages").map(QueuedRun.init)))
            let insertion = restored.object("queueInsertion")
            if !insertion.isEmpty { out.append(.queueInsertion(id: insertion.string("queue_id"), phase: insertion.string("phase"))) }
            for row in restored.objects("backgroundTasks") { out.append(subagentEvent(row.string("event").nilIfEmpty ?? (row.string("status") == "completed" ? "subagent.complete" : "subagent.progress"), row)) }
            let working = restored.bool("isWorking") || restored.int("queueLength") > 0 || restored.int("backgroundPending") > 0
            for envelope in restored.objects("events") {
                let replay = envelope.string("event"), data = envelope.object("data")
                guard replay != "resumed", replay != "app.resumed" else { continue }
                if !working && replay != "approval.requested" && replay != "clarify.requested" && replay != "run.reattach_failed" && !replay.hasPrefix("subagent.") && replay != "delegation.updated" { continue }
                out += events(for: replay, json: data, sessionID: sessionID)
            }
            out.append(.resumed(isWorking: working, completion: completion(fromResume: restored).map { ResumeCompletion(output: $0.output, reasoning: $0.reasoning) }))
        case "run.started": out.append(.started(.now))
        case "run.queued": out.append(.queued(json.objects("queued_messages").map(QueuedRun.init)))
        case "run.queue_insertion.updated": out.append(.queueInsertion(id: json.string("queue_id"), phase: json.string("phase")))
        case let value where value.hasPrefix("subagent.") || value == "delegation.updated" || value == "subagent.event":
            out.append(subagentEvent(value == "subagent.event" ? json.string("event") : value, json))
        case "message.delta":
            let delta = json.string("delta", "text"); if !delta.isEmpty { out.append(.text(delta)) }
        case "message.interim":
            let text = json.string("text", "output"); if !text.isEmpty && !json.bool("already_streamed") { out.append(.interim(text)) }
        case "reasoning.delta", "thinking.delta":
            let delta = json.string("delta", "text"); if !delta.isEmpty { out.append(.reasoning(delta)) }
        case "reasoning.available": out.append(.thinkingAvailable)
        case "tool.started", "tool.completed", "tool.failed": out.append(.tool(ToolEvent.parse(event: event, json: json)))
        case "workspace.diff.completed": out.append(.workspaceDiff(summary: workspaceChangeSummary(json)))
        case "usage.updated": if let usage = usage(json) { out.append(usage) }
        case "run.completed":
            if let usage = usage(json) { out.append(usage) }
            let interrupted = json.bool("interrupted") || json.object("result").bool("interrupted")
            out.append(.completed(output: json.string("output"), reasoning: json.string("reasoning"), interrupted: interrupted))
        case "approval.requested", "clarify.requested": out.append(.requiresAction(ChatInteraction(event: event, payload: json)))
        case "approval.resolved", "clarify.resolved": out.append(.actionResolved(id: json.string("approval_id", "clarify_id", "id"), choice: json.string("choice", "response")))
        case "run.failed", "run.reattach_failed": out.append(.failed(json.string("error", "message", "text").nilIfEmpty ?? String(localized: "Run failed"), retryable: false))
        case "session.settings.updated": out.append(.settingsUpdated(SessionSettingsUpdate(json)))
        case "session.title.updated": if let title = json.string("title").nilIfEmpty { out.append(.titleUpdated(title)) }
        case "session.workspace.updated": out.append(.workspaceUpdated(json.string("workspace")))
        case "compression.started", "compression.completed":
            out.append(.compression(phase: event == "compression.started" ? "started" : "completed", messageCount: json.int("message_count"), tokenCount: json.int("token_count", default: json.int("compressed_tokens"))))
        case "abort.started": out.append(.abort(phase: "started"))
        case "abort.timeout": out.append(.abort(phase: "timeout"))
        case "abort.completed": out.append(.abort(phase: "completed"))
        case "run.peer_user_message":
            let message = json.object("message")
            let content: String
            if let text = message["content"] as? String { content = text } else { content = Message(message).content }
            out.append(.peerMessage(role: message.string("role").nilIfEmpty ?? "user", content: content, timestamp: StudioTimestamp.date(from: message.string("timestamp"))))
        case "session.command": out.append(.sessionCommand(SessionCommandResult(json)))
        case "location.requested": out.append(.locationRequested(LocationRequest(json)))
        case "calendar.requested", "reminder.requested", "health.requested":
            let kind = String(event.prefix(while: { $0 != "." }))
            out.append(.deviceRequested(kind: kind, requestID: json.string("\(kind)_request_id")))
        default: break
        }
        return out
    }

    private static func subagentEvent(_ event: String, _ json: JSON) -> LiveRunEvent {
        .subagent(id: json.string("delegation_id", "subagent_id", "id").nilIfEmpty ?? UUID().uuidString, event: event, title: json.string("goal", "name", "summary").nilIfEmpty ?? String(localized: "Subagent"), detail: json.string("text", "summary", "status", "tool", "error"))
    }

    static func workspaceChangeSummary(_ json: JSON) -> String {
        let files = json.objects("files").count + json.objects("changes").count
        let count = files > 0 ? files : json.int("file_count", default: json.int("files_changed"))
        let path = json.string("path", "workspace", "file")
        if count > 0 { return String(localized: "\(count) files changed") }
        return path.nilIfEmpty ?? json.string("summary").nilIfEmpty ?? String(localized: "Workspace changes")
    }

    /// Run payload for `run` / queued runs (unit-tested contract).
    static func runPayload(profile: String, sessionID: String, input: String, attachments: [Upload], reasoningEffort: String?, model: String?, provider: String?, session: SessionSummary, pushEnabled: Bool? = nil) -> JSON {
        var payload: JSON = ["input": content(input, attachments), "profile": profile, "session_id": sessionID, "push_enabled": pushEnabled ?? session.pushEnabled]
        if let reasoningEffort, !reasoningEffort.isEmpty { payload["reasoning_effort"] = reasoningEffort }
        if let model, !model.isEmpty { payload["model"] = model }
        if let provider, !provider.isEmpty { payload["provider"] = provider }
        if !session.workspace.isEmpty { payload["workspace"] = session.workspace }
        if let category = session.categoryID { payload["category_id"] = category }
        let agent = AgentIdentity.canonicalID(session.agentID)
        if session.source == "global_agent" { payload["source"] = "global_agent"; payload["session_source"] = "global_agent"; payload["coding_agent_id"] = agent }
        else if agent != "hermes" { payload["source"] = "coding_agent"; payload["coding_agent_id"] = agent; payload["agent_id"] = agent; payload["mode"] = session.agentMode == "global" ? "global" : "scoped"; if session.agentMode != "global" { if !session.baseURL.isEmpty { payload["base_url"] = session.baseURL }; if !session.apiKey.isEmpty { payload["api_key"] = session.apiKey }; if !session.apiMode.isEmpty { payload["api_mode"] = session.apiMode } } }
        else if !session.source.isEmpty { payload["source"] = session.source }
        return payload
    }

    private static func cacheKey(_ sessionID: String) -> String { "studio.resume.\(sessionID)" }
    static func cachedResumeID(_ sessionID: String) -> String { (UserDefaults.standard.dictionary(forKey: cacheKey(sessionID))?["id"] as? String) ?? "" }
    static func restoredResume(_ json: JSON, sessionID: String) -> JSON {
        var result = json
        let key = cacheKey(sessionID)
        if json.bool("messagesCached"), let cached = UserDefaults.standard.dictionary(forKey: key), let data = cached["messages"] as? Data, let rows = try? JSONSerialization.jsonObject(with: data) as? [JSON] { result["messages"] = rows }
        if !json.objects("messages").isEmpty, let id = json.string("id").nilIfEmpty, let data = try? JSONSerialization.data(withJSONObject: json.objects("messages")) { UserDefaults.standard.set(["id": id, "messages": data], forKey: key) }
        return result
    }

    static func usage(_ json: JSON) -> LiveRunEvent? {
        func integer(_ keys: [String]) -> Int? {
            for key in keys {
                if let value = json[key] as? NSNumber { return value.intValue }
                if let value = json[key] as? String, let parsed = Int(value) { return parsed }
            }
            return nil
        }
        guard let used = integer(["contextTokens", "context_tokens", "tokenCount", "token_count"]) else { return nil }
        let window = integer(["contextWindow", "context_window", "contextLength", "context_length"])
        return .usage(contextTokens: max(0, used), contextWindow: window.flatMap { $0 > 0 ? $0 : nil })
    }

    /// Recovers the final assistant message persisted while the phone was
    /// changing networks or temporarily suspended.
    static func completion(fromResume json: JSON) -> (output: String, reasoning: String)? {
        guard !json.bool("isWorking") else { return nil }
        let messages = json.objects("messages")
        guard let lastUser = messages.lastIndex(where: { ["user", "command"].contains($0.string("role")) }),
              lastUser + 1 < messages.count
        else { return nil }
        for message in messages[(lastUser + 1)...].reversed() where message.string("role") == "assistant" {
            let output = message.string("display_content", "content")
            if !output.isEmpty { return (output, message.string("reasoning")) }
        }
        return nil
    }

    /// `input` is a plain string, or content blocks when files are attached.
    static func content(_ input: String, _ attachments: [Upload]) -> Any {
        guard !attachments.isEmpty else { return input }
        var blocks: [JSON] = []
        if !input.isEmpty { blocks.append(["type": "text", "text": input]) }
        blocks += attachments.map { upload -> JSON in
            var block: JSON = ["type": upload.mime.hasPrefix("image/") ? "image" : "file", "name": upload.name, "path": upload.path]
            if !upload.mime.isEmpty { block["media_type"] = upload.mime }
            return block
        }
        return blocks
    }

    static func event(_ packet: String, namespace: String) -> (String, JSON)? {
        guard packet.hasPrefix("42\(namespace),"), let bracket = packet.firstIndex(of: "[") else { return nil }
        let jsonText = String(packet[bracket...])
        guard let data = jsonText.data(using: .utf8), let array = try? JSONSerialization.jsonObject(with: data) as? [Any], let event = array.first as? String else { return nil }
        return (event, array.count > 1 ? (array[1] as? JSON ?? [:]) : [:])
    }
}

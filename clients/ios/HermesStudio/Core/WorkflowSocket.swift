import Foundation

/// Events of the `/workflow` namespace.
enum LiveWorkflowEvent: Equatable {
    case connected
    case disconnected(String?)
    case statuses([WorkflowRuntimeStatus])
    case statusUpdated(WorkflowRuntimeStatus)
    case statusError(workflowID: String, error: String)
}

private final class WorkflowReconnectTask: @unchecked Sendable {
    var value: Task<Void, Never>?
    var closed = false
    var attempt = 0
}

/// `/workflow` socket (`packages/client/src/api/studio/workflow-socket.ts`):
/// `auth: { token }`, `query: { profile }`, acknowledged `workflows.list` /
/// `workflow.status.subscribe`, and `workflow.status.updated` pushes.
final class WorkflowSocket: @unchecked Sendable {
    private var connection: SocketIOConnection?
    private(set) var isConnected = false

    func close() { connection?.close(); connection = nil; isConnected = false }

    /// Unwraps the `{ ok, data, error }` acknowledgement envelope.
    static func unwrap(_ response: JSON) -> Result<JSON, HermesError> {
        if response.bool("ok") { return .success(response.object("data")) }
        return .failure(HermesError.server(response.string("error").nilIfEmpty ?? String(localized: "Workflow request failed")))
    }

    func listWorkflows(profile: String) async throws -> [WorkflowItem] {
        guard let connection else { throw HermesError.server(String(localized: "Not connected")) }
        let response = await connection.request("workflows.list", payload: profile.isEmpty ? [:] : ["profile": profile])
        return try Self.unwrap(response).get().objects("workflows").map(WorkflowItem.init)
    }

    /// Subscribes to every workflow of the profile (or one workflow) and
    /// returns the current statuses.
    func subscribe(workflowID: String? = nil) async throws -> [WorkflowRuntimeStatus] {
        guard let connection else { throw HermesError.server(String(localized: "Not connected")) }
        let payload: JSON = workflowID.map { ["workflowId": $0] } ?? [:]
        let response = await connection.request("workflow.status.subscribe", payload: payload)
        return try Self.unwrap(response).get().objects("statuses").map(WorkflowRuntimeStatus.init)
    }

    func unsubscribe(workflowID: String? = nil) {
        let payload: JSON = workflowID.map { ["workflowId": $0] } ?? [:]
        connection?.emit("workflow.status.unsubscribe", payload: payload)
    }

    /// Opens the connection and streams status pushes; the caller subscribes
    /// after `.connected`.
    func open(baseURL: String, token: String, profile: String) -> AsyncStream<LiveWorkflowEvent> {
        close()
        return AsyncStream { continuation in
            let live = SocketIOConnection(baseURL: baseURL, token: token, namespace: "/workflow", profile: profile, platform: "ios")
            self.connection = live
            let retry = WorkflowReconnectTask()
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
                    return
                }
                if packet == "__disconnected__" || packet.hasPrefix("__error__:") {
                    self?.isConnected = false
                    continuation.yield(.disconnected(packet.hasPrefix("__error__:") ? String(packet.dropFirst(10)) : nil))
                    scheduleReconnect()
                    return
                }
                guard let (event, json) = ChatSocket.event(packet, namespace: "/workflow") else { return }
                if let item = Self.event(for: event, json: json) { continuation.yield(item) }
            }
            live.connect(onPacket: handlePacket)
            continuation.onTermination = { [weak self] _ in retry.closed = true; retry.value?.cancel(); self?.close() }
        }
    }

    /// Pure event mapping (unit-tested).
    static func event(for event: String, json: JSON) -> LiveWorkflowEvent? {
        switch event {
        case "workflow.status.updated": return .statusUpdated(WorkflowRuntimeStatus(json))
        case "workflow.status.error": return .statusError(workflowID: json.string("workflowId"), error: json.string("error"))
        default: return nil
        }
    }
}

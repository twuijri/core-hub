import Foundation

/// Live workflow statuses from the `/workflow` namespace, shared by the
/// workflow list and the run screen: it connects once, subscribes on every
/// (re)connect and keeps the latest status per workflow.
@MainActor
final class WorkflowLiveStatuses: ObservableObject {
    @Published private(set) var statuses: [String: WorkflowRuntimeStatus] = [:]
    @Published private(set) var connected = false
    @Published var error: String?

    private let socket = WorkflowSocket()
    private var task: Task<Void, Never>?
    private var workflowID: String?

    /// Opens the socket (or reopens it for another profile / workflow).
    func start(baseURL: String, token: String, profile: String, workflowID: String? = nil) {
        stop()
        self.workflowID = workflowID
        task = Task { [weak self] in
            guard let self else { return }
            for await event in socket.open(baseURL: baseURL, token: token, profile: profile) {
                await self.handle(event, profile: profile)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        socket.close()
        connected = false
    }

    /// Merges one live event; `nil` statuses are never dropped so a chip
    /// keeps its last known value while the socket reconnects.
    private func handle(_ event: LiveWorkflowEvent, profile: String) async {
        switch event {
        case .connected:
            connected = true
            error = nil
            await subscribe()
        case let .disconnected(message):
            connected = false
            if let message, !message.isEmpty { error = message }
        case let .statuses(list):
            for status in list { statuses[status.workflowID] = status }
        case let .statusUpdated(status):
            statuses[status.workflowID] = status
        case let .statusError(id, message):
            error = message
            if var current = statuses[id] { current.error = message; statuses[id] = current }
        }
    }

    private func subscribe() async {
        do {
            let list = try await socket.subscribe(workflowID: workflowID)
            for status in list { statuses[status.workflowID] = status }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func status(for id: String) -> WorkflowRuntimeStatus? { statuses[id] }
}

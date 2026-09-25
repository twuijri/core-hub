// The hub's realtime namespaces (`/rt/sessions`, `/rt/devices`, …) over one WebSocket, with no
// third-party library: Engine.IO v4 framing and Socket.IO v5 packets (SocketIOPacket.swift) on
// URLSessionWebSocketTask. What it does is what events/README.md asks of every client:
// the bearer and the profile in every namespace handshake, a refreshed token after a refused
// one, reconnection with backoff capped at 30 s, and `connect` callbacks so a screen can
// resubscribe with `after_seq`.
import Foundation

@MainActor
final class RealtimeClient {
    enum State: Equatable {
        case offline
        case connecting
        case connected
    }

    private(set) var state: State = .offline {
        didSet { if oldValue != state { onStateChange?(state) } }
    }

    var onStateChange: ((State) -> Void)?

    private let keeper: TokenKeeper
    private let session: URLSession
    private var hubURL: URL?
    private var socket: URLSessionWebSocketTask?
    /// The Engine.IO `open` packet arrived on the current socket: namespaces may connect. A
    /// namespace connected twice on one socket would hear every event twice.
    private var engineOpen = false
    private var namespaces: [String: RealtimeNamespace] = [:]
    private var generation = 0
    private var attempt = 0
    private var lastHeard = Date()
    private var deadline: TimeInterval = 50
    private var reconnectTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var nextAckID = 0
    private var pendingAcks: [Int: CheckedContinuation<Data?, Error>] = [:]
    private var refusedAt: [String: Date] = [:]

    init(keeper: TokenKeeper, session: URLSession = URLSession(configuration: .default)) {
        self.keeper = keeper
        self.session = session
    }

    /// Opens the connection to `hub` (closing any other first).
    func start(hub: URL) {
        stop(keepNamespaces: true)
        hubURL = hub
        attempt = 0
        connect()
    }

    /// Closes everything; `keepNamespaces: false` also forgets every listener (sign-out).
    func stop(keepNamespaces: Bool = false) {
        generation += 1
        engineOpen = false
        reconnectTask?.cancel()
        watchdog?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        failPendingAcks()
        for namespace in namespaces.values { namespace.markDisconnected() }
        if !keepNamespaces {
            namespaces.removeAll()
            hubURL = nil
        }
        state = .offline
    }

    /// Back in the foreground: a dropped connection comes back now, not after its backoff.
    func resume() {
        guard hubURL != nil, state == .offline else { return }
        attempt = 0
        reconnectTask?.cancel()
        connect()
    }

    /// The namespace at `path`; `auth` builds its handshake (`{ token, profile, profiles }`)
    /// each time it connects, so a refreshed token or another profile is used on the next one.
    func namespace(_ path: String, auth: @escaping () async -> [String: Any]) -> RealtimeNamespace {
        if let existing = namespaces[path] {
            existing.authProvider = auth
            return existing
        }
        let namespace = RealtimeNamespace(path: path, client: self, auth: auth)
        namespaces[path] = namespace
        if engineOpen { connectNamespace(namespace) }
        return namespace
    }

    /// Reconnects one namespace with a fresh handshake (the profile changed).
    func reconnect(_ namespace: RealtimeNamespace) {
        guard engineOpen else { return }
        send(SocketIOPacket(kind: .disconnect, namespace: namespace.path))
        namespace.markDisconnected()
        connectNamespace(namespace)
    }

    // MARK: - Connection

    private func connect() {
        guard let hubURL, let url = HubAddress.realtimeURL(for: hubURL) else { return }
        generation += 1
        let current = generation
        engineOpen = false
        state = .connecting
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 16 * 1024 * 1024
        socket = task
        task.resume()
        Task { await self.receive(from: task, generation: current) }
    }

    private func receive(from task: URLSessionWebSocketTask, generation current: Int) async {
        while current == generation {
            do {
                let message = try await task.receive()
                guard current == generation else { return }
                lastHeard = Date()
                switch message {
                case .string(let text): handle(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) { handle(text) }
                @unknown default: break
                }
            } catch {
                if current == generation { dropped() }
                return
            }
        }
    }

    private func handle(_ text: String) {
        guard let packet = EngineIOPacket.decode(text) else { return }
        switch packet {
        case .open(let json):
            if let data = json.data(using: .utf8),
               let handshake = try? JSONDecoder().decode(EngineIOHandshake.self, from: data) {
                deadline = TimeInterval(handshake.pingInterval + handshake.pingTimeout) / 1000 + 5
            }
            attempt = 0
            engineOpen = true
            startWatchdog()
            for namespace in namespaces.values { connectNamespace(namespace) }
        case .ping(let data):
            sendRaw(EngineIOPacket.pong(data).encoded)
        case .message(let inner):
            if let socketPacket = SocketIOPacket.decode(inner) { dispatch(socketPacket) }
        case .close:
            dropped()
        default:
            break
        }
    }

    private func dispatch(_ packet: SocketIOPacket) {
        let namespace = namespaces[packet.namespace]
        switch packet.kind {
        case .connect:
            namespace?.markConnected()
            state = .connected
        case .connectError:
            guard let namespace else { return }
            namespace.markDisconnected()
            let code = packet.connectErrorCode ?? ""
            // A refused token: refresh once, then try again. A refusal that repeats within a
            // few seconds is left alone (the keeper signs out when the refresh itself fails).
            if code == "unauthorized" || code == "token_expired" {
                let last = refusedAt[namespace.path]
                refusedAt[namespace.path] = Date()
                if let last, Date().timeIntervalSince(last) < 5 { return }
                Task {
                    if await self.keeper.refresh() { self.connectNamespace(namespace) }
                }
            }
        case .disconnect:
            // The hub dropped this namespace (a restart, a kicked socket): the session is
            // still ours, so come back like after any other drop.
            namespace?.markDisconnected()
            if let namespace {
                Task {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    self.connectNamespace(namespace)
                }
            }
        case .event, .binaryEvent:
            if let content = packet.eventContent { namespace?.deliver(content.name, content.argument) }
        case .ack, .binaryAck:
            if let id = packet.id, let continuation = pendingAcks.removeValue(forKey: id) {
                continuation.resume(returning: packet.ackArgument)
            }
        }
    }

    private func connectNamespace(_ namespace: RealtimeNamespace) {
        let current = generation
        Task {
            let auth = await namespace.authProvider()
            guard current == self.generation, self.engineOpen else { return }
            self.send(SocketIOPacket(kind: .connect, namespace: namespace.path, payload: JSON.text(auth)))
        }
    }

    private func dropped() {
        engineOpen = false
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        watchdog?.cancel()
        failPendingAcks()
        for namespace in namespaces.values { namespace.markDisconnected() }
        state = .offline
        guard hubURL != nil else { return }
        let delay = RealtimeClient.backoff(attempt: attempt)
        attempt += 1
        let current = generation
        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, current == self.generation else { return }
            self.connect()
        }
    }

    /// 1 s, 2 s, 4 s … capped at 30 s (events/README.md §Reconnection).
    nonisolated static func backoff(attempt: Int) -> TimeInterval {
        min(30, pow(2, Double(min(attempt, 10))))
    }

    private func startWatchdog() {
        watchdog?.cancel()
        let current = generation
        watchdog = Task {
            while !Task.isCancelled, current == self.generation {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if current == self.generation, Date().timeIntervalSince(self.lastHeard) > self.deadline {
                    self.dropped()
                    return
                }
            }
        }
    }

    // MARK: - Sending

    fileprivate func send(_ packet: SocketIOPacket) {
        sendRaw(EngineIOPacket.message(packet.encoded).encoded)
    }

    private func sendRaw(_ text: String) {
        socket?.send(.string(text)) { _ in }
    }

    fileprivate func emit(_ event: String, data: [String: Any], namespace: String, timeout: TimeInterval) async throws -> Data? {
        guard socket != nil else { throw RealtimeError.offline }
        let id = nextAckID
        nextAckID += 1
        return try await withCheckedThrowingContinuation { continuation in
            pendingAcks[id] = continuation
            send(SocketIOPacket.event(event, data: data, namespace: namespace, id: id))
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                if let waiting = self.pendingAcks.removeValue(forKey: id) {
                    waiting.resume(throwing: RealtimeError.timedOut)
                }
            }
        }
    }

    private func failPendingAcks() {
        let waiting = pendingAcks
        pendingAcks.removeAll()
        for continuation in waiting.values { continuation.resume(throwing: RealtimeError.offline) }
    }
}

enum RealtimeError: Error {
    case offline
    case timedOut
    case refused(String)
}

/// One namespace: listeners for its events and for each (re)connection.
@MainActor
final class RealtimeNamespace {
    let path: String
    fileprivate var authProvider: () async -> [String: Any]
    private weak var client: RealtimeClient?
    private(set) var isConnected = false
    private var eventHandlers: [UUID: @MainActor (String, Data?) -> Void] = [:]
    private var connectHandlers: [UUID: @MainActor () -> Void] = [:]

    fileprivate init(path: String, client: RealtimeClient, auth: @escaping () async -> [String: Any]) {
        self.path = path
        self.client = client
        self.authProvider = auth
    }

    /// Every event of the namespace: its name and its argument (the envelope) as JSON.
    @discardableResult
    func onEvent(_ handler: @escaping @MainActor (String, Data?) -> Void) -> UUID {
        let id = UUID()
        eventHandlers[id] = handler
        return id
    }

    /// Each time the namespace (re)connects — the moment to (re)subscribe.
    @discardableResult
    func onConnect(_ handler: @escaping @MainActor () -> Void) -> UUID {
        let id = UUID()
        connectHandlers[id] = handler
        return id
    }

    func remove(_ id: UUID) {
        eventHandlers[id] = nil
        connectHandlers[id] = nil
    }

    /// A command with an acknowledgement (`subscribe`, `unsubscribe`); the ack's JSON.
    func emit(_ event: String, _ data: [String: Any], timeout: TimeInterval = 10) async throws -> Data? {
        guard let client else { throw RealtimeError.offline }
        return try await client.emit(event, data: data, namespace: path, timeout: timeout)
    }

    func reconnect() { client?.reconnect(self) }

    fileprivate func markConnected() {
        isConnected = true
        for handler in connectHandlers.values { handler() }
    }

    fileprivate func markDisconnected() {
        isConnected = false
    }

    fileprivate func deliver(_ name: String, _ argument: Data?) {
        for handler in eventHandlers.values { handler(name, argument) }
    }
}

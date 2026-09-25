// Opens one conversation: HTTP for the base document (`sessions.get` + `sessions.listMessages`),
// `/rt/sessions` for everything after, `after_seq` on every reconnect, and the documented
// resync when the hub says the replay was truncated (events/README.md §Resuming).
import CoreHubClient
import Foundation
import Observation

@MainActor
@Observable
final class ChatModel {
    enum Load: Equatable {
        case loading
        case ready
        case failed(String)
    }

    private(set) var state: ChatState
    private(set) var load: Load = .loading
    private(set) var sending = false
    /// The last action that failed (send, stop, answer), in one sentence.
    var actionError: String?
    private(set) var loadingOlder = false

    let sessionID: String
    /// The session's own profile: every request about it carries this, whatever the selector.
    let profile: String

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listeners: [UUID] = []
    @ObservationIgnored private var hydrated = false
    @ObservationIgnored private var buffer: [(SessionEvent, Envelope)] = []
    @ObservationIgnored private var subscribedOnce = false
    @ObservationIgnored private var firstSubscription: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var pendingFirstMessage: String?
    @ObservationIgnored private var started = false

    init(app: AppModel, sessionID: String, profile: String, firstMessage: String? = nil) {
        self.app = app
        self.sessionID = sessionID
        self.profile = profile
        self.state = ChatState(sessionID: sessionID)
        self.state.profile = profile
        self.pendingFirstMessage = firstMessage
    }

    var l10n: L10n { app?.l10n ?? L10n(.en) }

    func start() {
        guard !started, let app else { return }
        started = true
        if let namespace = app.sessions {
            listeners.append(namespace.onEvent { [weak self] name, argument in
                self?.receive(name, argument)
            })
            listeners.append(namespace.onConnect { [weak self] in
                self?.subscribe()
            })
        }
        Task { await open() }
    }

    func stop() {
        guard started else { return }
        started = false
        if let namespace = app?.sessions {
            for id in listeners { namespace.remove(id) }
            if namespace.isConnected {
                let sessionID = sessionID
                Task { _ = try? await namespace.emit("unsubscribe", ["session_id": sessionID]) }
            }
        }
        listeners.removeAll()
        firstSubscription?.resume()
        firstSubscription = nil
    }

    // MARK: - Opening

    /// `ready` must mean *subscribed*, not merely fetched: the hub replays only on a resume,
    /// so a run started before the first subscription would lose its opening events. The wait
    /// is capped, so an unreachable hub still shows the transcript.
    private func open() async {
        if let namespace = app?.sessions, namespace.isConnected {
            subscribe()
        }
        if !subscribedOnce {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                firstSubscription = continuation
                Task {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    self.releaseFirstSubscription()
                }
            }
        }
        do {
            try await fetchBase()
            hydrated = true
            for (event, envelope) in buffer {
                state.apply(event, seq: envelope.seq, profile: envelope.profile)
            }
            buffer.removeAll()
            load = .ready
            if let text = pendingFirstMessage {
                pendingFirstMessage = nil
                await send(text)
            }
        } catch {
            load = .failed(HubFailure(error).describe(l10n))
        }
    }

    private func releaseFirstSubscription() {
        firstSubscription?.resume()
        firstSubscription = nil
    }

    private func fetchBase() async throws {
        guard let app else { return }
        let profile = profile
        let sessionID = sessionID
        async let detail = app.api.call {
            try await SessionsAPI.sessionsGet(xHubProfile: profile, sessionId: sessionID, apiConfiguration: $0)
        }
        async let page = app.api.call {
            try await SessionsAPI.sessionsListMessages(xHubProfile: profile, sessionId: sessionID, limit: 100, apiConfiguration: $0)
        }
        let (d, p) = try await (detail, page)
        state.hydrate(d, messages: p)
    }

    func reload() {
        load = .loading
        hydrated = false
        Task { await open() }
    }

    private func subscribe() {
        guard started, let namespace = app?.sessions else { return }
        let initial = !subscribedOnce
        let afterSeq = initial ? 0 : state.lastSeq
        var payload: [String: Any] = ["session_id": sessionID]
        if afterSeq > 0 { payload["after_seq"] = afterSeq }
        Task {
            do {
                let ack = try await namespace.emit("subscribe", payload)
                let result = SubscribeAck.parse(ack)
                guard result.ok else {
                    self.actionError = result.error ?? result.code ?? "subscribe_failed"
                    return
                }
                self.subscribedOnce = true
                self.releaseFirstSubscription()
                if !initial, result.truncated, afterSeq > 0, self.hydrated {
                    try? await self.fetchBase()
                }
            } catch {
                // The next `connect` subscribes again.
            }
        }
    }

    private func receive(_ name: String, _ argument: Data?) {
        guard SessionEvents.names.contains(name), let envelope = Envelope.parse(argument),
              let event = SessionEvent.decode(envelope) else { return }
        if hydrated {
            state.apply(event, seq: envelope.seq, profile: envelope.profile)
            if case .runCompleted(let run, let message) = event, run.sessionId == sessionID,
               app?.device.spokenReplies == true {
                Speaker.shared.speak(message.text)
            }
        } else {
            buffer.append((event, envelope))
        }
    }

    // MARK: - Actions (HTTP, never the socket)

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let app else { return }
        sending = true
        actionError = nil
        defer { sending = false }
        let profile = profile
        let sessionID = sessionID
        let run = RunCreate(content: [.typeTextBlock(TextBlock(type: .text, text: trimmed))], when: .queue)
        let key = ULID.make()
        do {
            _ = try await app.api.call {
                try await SessionsAPI.sessionsCreateRun(
                    xHubProfile: profile,
                    sessionId: sessionID,
                    runCreate: run,
                    idempotencyKey: key,
                    apiConfiguration: $0
                )
            }
        } catch {
            actionError = HubFailure(error).describe(l10n)
        }
    }

    func stopRun() async {
        guard let app, let run = state.activeRun else { return }
        let profile = profile
        let sessionID = sessionID
        do {
            _ = try await app.api.call {
                try await SessionsAPI.sessionsCancelRun(xHubProfile: profile, sessionId: sessionID, runId: run.id, apiConfiguration: $0)
            }
        } catch {
            actionError = HubFailure(error).describe(l10n)
        }
    }

    func respond(_ approval: Approval, decision: ApprovalDecision?, answer: String?) async {
        guard let app else { return }
        let profile = approval.profile
        do {
            _ = try await app.api.call {
                try await SessionsAPI.sessionsRespondApproval(
                    xHubProfile: profile,
                    approvalId: approval.id,
                    approvalResponse: ApprovalResponse(decision: decision, answer: answer),
                    apiConfiguration: $0
                )
            }
            // The resolution also arrives as `approval.resolved`; drop it now so the card goes.
            state.apply(.approvalResolved(approval), seq: 0, profile: nil)
        } catch {
            actionError = HubFailure(error).describe(l10n)
        }
    }

    func loadOlder() async {
        guard let app, state.hasOlder, !loadingOlder, let oldest = state.messages.first else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        let profile = profile
        let sessionID = sessionID
        do {
            let page = try await app.api.call {
                try await SessionsAPI.sessionsListMessages(
                    xHubProfile: profile, sessionId: sessionID, before: oldest.id, limit: 50, apiConfiguration: $0
                )
            }
            state.prependOlder(page)
        } catch {
            actionError = HubFailure(error).describe(l10n)
        }
    }
}

/// The ack of `subscribe`: `{ ok, replayed, truncated }` or `{ ok: false, error, code }`.
struct SubscribeAck: Equatable {
    var ok: Bool
    var replayed: Int
    var truncated: Bool
    var error: String?
    var code: String?

    static func parse(_ data: Data?) -> SubscribeAck {
        guard let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return SubscribeAck(ok: false, replayed: 0, truncated: false, error: nil, code: "bad_ack")
        }
        return SubscribeAck(
            ok: object["ok"] as? Bool ?? false,
            replayed: (object["replayed"] as? NSNumber)?.intValue ?? 0,
            truncated: object["truncated"] as? Bool ?? false,
            error: object["error"] as? String,
            code: object["code"] as? String
        )
    }
}

/// A client-generated ULID for `Idempotency-Key` (the contract's `Ulid`: 26 Crockford base32
/// characters, time first).
enum ULID {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func make(now: Date = Date()) -> String {
        var time = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        var timeChars = [Character](repeating: "0", count: 10)
        for index in stride(from: 9, through: 0, by: -1) {
            timeChars[index] = alphabet[Int(time % 32)]
            time /= 32
        }
        var random = [Character]()
        for _ in 0..<16 { random.append(alphabet[Int.random(in: 0..<32)]) }
        return String(timeChars + random)
    }
}

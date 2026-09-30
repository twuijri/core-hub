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
    /// The outcome of the last compress or steer, in one sentence (not an error).
    var notice: String?
    private(set) var compressing = false
    private(set) var loadingOlder = false
    /// Messages held back while a turn runs (MessageQueue.swift).
    private(set) var outbox: [QueuedMessage] = []
    @ObservationIgnored private var draining = false

    let sessionID: String
    /// The session's own profile: every request about it carries this, whatever the selector.
    let profile: String

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listeners: [UUID] = []
    @ObservationIgnored private var hydrated = false
    @ObservationIgnored private var buffer: [(SessionEvent, Envelope)] = []
    @ObservationIgnored private var subscribedOnce = false
    @ObservationIgnored private var firstSubscription: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var pendingFirstMessage: OutgoingMessage?
    @ObservationIgnored private var started = false
    /// Whether the person is looking at this conversation (it is open, the app in front): the
    /// hub then skips the phone push for a reply here (DECISIONS §149).
    @ObservationIgnored private var viewing = false
    @ObservationIgnored private var viewingHeartbeat: Task<Void, Never>?

    init(app: AppModel, sessionID: String, profile: String, firstMessage: OutgoingMessage? = nil) {
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
                // After a reconnect the hub knows nothing of this screen: say it again.
                if self?.viewing == true { self?.sayViewing() }
            })
        }
        Task { await open() }
    }

    func stop() {
        guard started else { return }
        setViewing(false)
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

    // MARK: - Viewing (DECISIONS §149)

    /// The conversation is on screen with the app in front (`true`), or not. While it is, the
    /// hub hears `viewing { session_id }` every 20 s (it forgets it after 45 s); when it stops,
    /// `viewing { session_id: null }`. A hub older than this ignores it and pushes as before.
    func setViewing(_ wanted: Bool) {
        // A screen that is not open (the app came to the front on another page) views nothing.
        let on = wanted && started
        guard on != viewing else { return }
        viewing = on
        viewingHeartbeat?.cancel()
        viewingHeartbeat = nil
        sayViewing()
        guard on else { return }
        viewingHeartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled else { return }
                self?.sayViewing()
            }
        }
    }

    private func sayViewing() {
        guard let namespace = app?.sessions, namespace.isConnected else { return }
        let payload: [String: Any] = ["session_id": viewing ? sessionID : NSNull()]
        Task { _ = try? await namespace.emit("viewing", payload, timeout: 5) }
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
            if let first = pendingFirstMessage {
                pendingFirstMessage = nil
                await send(first)
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
            if !state.isBusy && !outbox.isEmpty { Task { await drainOutbox() } }
            if case .runCompleted(let run, let message) = event, run.sessionId == sessionID,
               app?.device.spokenReplies == true {
                Speaker.shared.speak(message.text, app: app, profile: profile)
            }
        } else {
            buffer.append((event, envelope))
        }
    }

    // MARK: - Actions (HTTP, never the socket)

    func send(_ text: String) async {
        await send(OutgoingMessage(text: text))
    }

    /// The person's words and the files they attached, as one run (web: `blocksFor`). While a turn
    /// runs and "Sending while the agent works" is «wait in line», it waits on the phone instead.
    func send(_ message: OutgoingMessage, replyTo: String? = nil) async {
        guard !message.isEmpty, let app else { return }
        let mode = ChatLook(app.preferences).busyInput
        if MessageQueueRules.holdsBack(mode, busy: state.isBusy) {
            outbox.append(QueuedMessage(id: UUID().uuidString, message: message, replyTo: replyTo))
            return
        }
        await post(message, replyTo: replyTo, when: mode)
    }

    /// A waiting message goes now: `next` after the live turn, or `interrupt` in its place.
    func release(_ item: QueuedMessage, when: RunCreate.When) async {
        guard outbox.contains(item) else { return }
        outbox.removeAll { $0.id == item.id }
        await post(item.message, replyTo: item.replyTo, when: when)
    }

    func removeQueued(_ item: QueuedMessage) {
        outbox.removeAll { $0.id == item.id }
    }

    /// The turn ended: the first waiting message goes (the next turn's end sends the one after).
    func drainOutbox() async {
        guard !draining, !state.isBusy, let first = outbox.first else { return }
        draining = true
        defer { draining = false }
        await release(first, when: .queue)
    }

    private func post(_ message: OutgoingMessage, replyTo: String?, when: RunCreate.When) async {
        guard let app else { return }
        sending = true
        actionError = nil
        defer { sending = false }
        let profile = profile
        let sessionID = sessionID
        let run = RunCreate(content: message.blocks, when: when, replyToMessageId: replyTo)
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

// MARK: - The chat's own actions (apps batch 1)

extension ChatModel {
    /// Rename, pin, archive and their undo: the hub's answer replaces what the screen shows.
    @discardableResult
    func change(_ patch: SessionPatch) async -> Bool {
        guard let app else { return false }
        do {
            let session = try await ChatActions.update(app, id: sessionID, profile: profile, patch)
            state.absorb(session)
            return true
        } catch {
            actionError = HubFailure(error).describe(l10n)
            return false
        }
    }

    func rename(_ typed: String) async {
        guard let title = ChatControls.renameTitle(typed) else { return }
        await change(SessionPatch(title: title))
    }

    /// The chat's model from the profile's catalogue (`<provider>/<model>`); `nil` goes back to
    /// the agent's default.
    func setModel(_ value: String?) async {
        guard value != state.model else { return }
        await change(ChatControls.modelPatch(value))
    }

    func delete() async -> Bool {
        guard let app else { return false }
        do {
            try await ChatActions.delete(app, id: sessionID, profile: profile)
            state.deleted = true
            return true
        } catch {
            actionError = HubFailure(error).describe(l10n)
            return false
        }
    }

    /// A new chat with this one's transcript up to `message` (all of it when nil).
    func fork(at message: String? = nil) async -> Session? {
        guard let app else { return nil }
        do {
            return try await ChatActions.fork(app, id: sessionID, profile: profile, at: message)
        } catch {
            actionError = HubFailure(error).describe(l10n)
            return nil
        }
    }

    /// `focus`: what the summary should keep in view (the context sheet, apps batch 6); empty is the whole chat.
    func compress(focus: String = "") async {
        guard let app, !compressing else { return }
        compressing = true
        notice = l10n("chat_controls.compressing")
        defer { compressing = false }
        do {
            let result = try await ChatActions.compress(app, id: sessionID, profile: profile, focus: focus)
            if let context = result.context { state.context = context }
            let line = ChatControls.compressionText(ChatControls.compression(result))
            notice = l10n(line.key, line.params)
        } catch {
            notice = nil
            actionError = HubFailure(error).describe(l10n)
        }
    }

    /// Guides the running reply with `text`; when it cannot take it, the words go as the next
    /// message instead (what Hermes itself does with a steer that has no turn to join).
    func steer(_ text: String) async {
        guard let app else { return }
        guard let run = state.activeRun else {
            await send(OutgoingMessage(text: text))
            return
        }
        do {
            let result = try await ChatActions.steer(app, id: sessionID, profile: profile, run: run.id, text: text)
            if result.status == .queued {
                notice = l10n("chat_controls.steered")
            } else {
                notice = l10n("chat_controls.steer_queued")
                await send(OutgoingMessage(text: text))
            }
        } catch {
            actionError = HubFailure(error).describe(l10n)
        }
    }
}

extension ChatModel {
    /// The hub's Markdown transcript of the conversation (`sessions.export`), written where the
    /// share sheet can hand it on. The request is the generated client's own; only the answer
    /// is read as text, since the client would read it as JSON.
    func exportMarkdown() async -> URL? {
        guard let app else { return nil }
        let profile = profile
        let sessionID = sessionID
        let title = state.title
        do {
            let text = try await app.api.call { configuration -> String in
                let builder = SessionsAPI.sessionsExportWithRequestBuilder(
                    xHubProfile: profile, sessionId: sessionID, format: .markdown, apiConfiguration: configuration
                )
                guard let url = URL(string: builder.URLString) else { throw HubFailure.signedOut }
                var request = URLRequest(url: url)
                for (name, value) in builder.headers { request.setValue(value, forHTTPHeaderField: name) }
                request.setValue("text/markdown", forHTTPHeaderField: "Accept")
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(status) else {
                    throw ErrorResponse.error(status, data, response, ChatExport.Refused())
                }
                return String(decoding: data, as: UTF8.self)
            }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(sessionID)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent(ChatExport.fileName(title: title, sessionID: sessionID))
            try text.write(to: file, atomically: true, encoding: .utf8)
            return file
        } catch {
            actionError = HubFailure(error).describe(l10n)
            return nil
        }
    }
}

enum ChatExport {
    /// The hub answered the export with an error (its envelope is in the response).
    struct Refused: Error {}

    /// The file a conversation is shared as: its title, made safe for a file name.
    static func fileName(title: String?, sessionID: String) -> String {
        let bad = CharacterSet(charactersIn: "\\/:*?\"<>|\n\r\t")
        let cleaned = (title ?? "").components(separatedBy: bad).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        let short = String(cleaned.prefix(80))
        return (short.isEmpty ? sessionID : short) + ".md"
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

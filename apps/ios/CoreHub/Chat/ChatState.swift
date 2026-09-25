// A pure reducer from `/rt/sessions` events to the state of one open conversation. Nothing
// here touches a socket or a view, so streaming, tool folding, approvals and resume are
// unit-tested on their own (ChatStateTests).
import CoreHubClient
import Foundation

struct ChatState {
    /// Highest `seq` seen in this session's profile; sent back as `after_seq` on resubscribe.
    var lastSeq = 0
    var sessionID: String
    var profile: String?
    var title: String?
    var agentID: String?
    var status: SessionStatus = .idle
    var messages: [Message] = []
    var runs: [String: Run] = [:]
    /// Pending approvals and questions by id.
    var approvals: [String: Approval] = [:]
    var context: ContextUsage?
    var deleted = false
    /// Whether older messages than `messages.first` exist on the hub.
    var hasOlder = false

    init(sessionID: String) {
        self.sessionID = sessionID
    }

    /// Replaces the base state with what HTTP returned, keeping the realtime cursor.
    mutating func hydrate(_ detail: SessionDetail, messages page: MessagePage) {
        profile = detail.profile
        title = detail.title
        agentID = detail.agentId
        status = detail.status
        context = detail.context
        runs = Dictionary(detail.runs.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        approvals = Dictionary(
            detail.pendingApprovals.filter { $0.status == .pending }.map { ($0.id, $0) },
            uniquingKeysWith: { _, last in last }
        )
        messages = page.items.sorted { $0.seq < $1.seq }
        hasOlder = page.hasMore
    }

    /// A page of older messages joins the top; messages already held are not repeated.
    mutating func prependOlder(_ page: MessagePage) {
        let held = Set(messages.map(\.id))
        let fresh = page.items.filter { !held.contains($0.id) }
        messages = (fresh + messages).sorted { $0.seq < $1.seq }
        hasOlder = page.hasMore
    }

    /// The active run: waiting or running, else queued.
    var activeRun: Run? {
        let all = runs.values.sorted { $0.createdAt < $1.createdAt }
        return all.first { $0.status == .running || $0.status == .waiting }
            ?? all.first { $0.status == .queued }
    }

    var isBusy: Bool { activeRun != nil }

    var pendingApprovals: [Approval] {
        approvals.values.sorted { $0.createdAt < $1.createdAt }
    }

    mutating func apply(_ event: SessionEvent, seq: Int, profile envelopeProfile: String?) {
        // `seq` counts per profile, and the socket hears every profile the lists gather
        // (ADR 0016): only this session's profile moves the cursor it resumes from.
        if profile == nil || envelopeProfile == nil || envelopeProfile == profile {
            lastSeq = max(lastSeq, seq)
        }
        guard event.sessionID == sessionID else { return }
        switch event {
        case .sessionCreated(let session), .sessionUpdated(let session):
            title = session.title
            status = session.status
            profile = session.profile
        case .sessionDeleted:
            deleted = true
        case .messageCreated(let message):
            upsert(message)
        case .messageDelta(_, let messageID, let runID, let delta):
            ensureMessage(messageID, runID: runID, profile: envelopeProfile)
            patch(messageID) { $0.appendText(delta) }
        case .reasoningDelta(_, let messageID, let runID, let delta):
            ensureMessage(messageID, runID: runID, profile: envelopeProfile)
            patch(messageID) { message in
                let text = (message.reasoning?.text ?? "") + delta
                message.reasoning = Reasoning(text: text, durationMs: message.reasoning?.durationMs)
            }
        case .tool(_, let messageID, let runID, let call):
            ensureMessage(messageID, runID: runID, profile: envelopeProfile)
            patch(messageID) { $0.upsertTool(call) }
        case .run(let run, let ended):
            runs[run.id] = run
            if let ended {
                for index in messages.indices where messages[index].runId == run.id && messages[index].status == .streaming {
                    messages[index].status = ended == .failed ? .failed : .interrupted
                }
            }
        case .runCompleted(let run, let message):
            runs[run.id] = run
            upsert(message)
        case .approvalRequested(let approval):
            if approval.status == .pending { approvals[approval.id] = approval }
        case .approvalResolved(let approval):
            approvals[approval.id] = nil
        case .contextUpdated(_, let context):
            self.context = context
        }
    }

    private mutating func upsert(_ message: Message) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
        } else {
            messages.append(message)
            messages.sort { $0.seq < $1.seq }
        }
    }

    private mutating func patch(_ id: String, _ change: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
    }

    /// A shell for a delta whose `message.created` never arrived (a gap the replay could not
    /// cover), so the text still lands somewhere.
    private mutating func ensureMessage(_ id: String, runID: String, profile envelopeProfile: String?) {
        guard !messages.contains(where: { $0.id == id }) else { return }
        let now = Date()
        messages.append(Message(
            id: id,
            profile: envelopeProfile ?? profile ?? "default",
            ownerId: id,
            createdAt: now,
            updatedAt: now,
            sessionId: sessionID,
            seq: (messages.last?.seq ?? 0) + 1,
            role: .assistant,
            author: Author(kind: .agent, name: ""),
            content: [],
            toolCalls: [],
            runId: runID,
            status: .streaming,
            mentions: []
        ))
    }
}

extension Message {
    /// The message's text blocks joined, which is what Markdown renders.
    var text: String {
        content.compactMap { block -> String? in
            if case .typeTextBlock(let text) = block { return text.text }
            return nil
        }.joined(separator: "\n")
    }

    /// A message with nothing in it is not a turn (DESIGN.md): the empty shell of a run that
    /// has not written yet.
    var isEmpty: Bool {
        text.isEmpty && toolCalls.isEmpty && (reasoning?.text ?? "").isEmpty
            && !content.contains { if case .typeTextBlock = $0 { return false } else { return true } }
    }

    mutating func appendText(_ delta: String) {
        if let last = content.last, case .typeTextBlock(var block) = last {
            block.text += delta
            content[content.count - 1] = .typeTextBlock(block)
        } else {
            content.append(.typeTextBlock(TextBlock(type: .text, text: delta)))
        }
        status = .streaming
    }

    mutating func upsertTool(_ call: ToolCall) {
        if let index = toolCalls.firstIndex(where: { $0.id == call.id }) {
            toolCalls[index] = call
        } else {
            toolCalls.append(call)
        }
    }
}

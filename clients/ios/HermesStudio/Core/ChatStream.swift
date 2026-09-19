import Foundation

/// Everything the conversation screen derives from the `/chat-run` stream.
/// The reducer below is pure so the event handling can be unit-tested
/// without a socket or a view.
struct ChatStreamState: Equatable {
    struct Compression: Equatable {
        var phase: String
        var messageCount: Int
        var tokenCount: Int
    }

    var lines: [ChatLine] = []
    /// The assistant line that receives deltas.
    var activeReplyID: UUID?
    var isRunning = false
    var abortPhase: String?
    var compression: Compression?
    var queued: [QueuedRun] = []
    var queueInsertionID = ""
    var contextTokens = 0
    var contextWindow = 0
    var model = ""
    var provider = ""
    var apiMode = ""
    var reasoningEffort: String?
    var pushEnabled: Bool?
    var workspace = ""
    var workspaceChanges: [String] = []
    var title: String?
    var pendingLocation: LocationRequest?
    var connected = false
    var connectionError: String?
    /// The server answered that this session no longer exists. The
    /// transcript shows one neutral empty state instead of a red row, and
    /// the next send creates the session again.
    var sessionMissing = false

    var activeIndex: Int? {
        guard let id = activeReplyID else { return nil }
        return lines.firstIndex { $0.id == id }
    }

    var pendingInteractions: [ChatInteraction] {
        lines.compactMap { line in
            guard let interaction = line.interaction, !interaction.resolved else { return nil }
            return interaction
        }
    }
}

enum ChatRunReducer {
    /// Applies one stream event. `sender` labels new assistant lines.
    static func apply(_ event: LiveRunEvent, to state: inout ChatStreamState, sender: String, now: Date = .now) {
        switch event {
        case .connected:
            state.connected = true; state.connectionError = nil
        case let .disconnected(message):
            state.connected = false
            if let message, !message.isEmpty { state.connectionError = message }
        case let .started(date):
            state.isRunning = true
            state.abortPhase = nil
            if state.compression?.phase == "completed" { state.compression = nil }
            let index = ensureActiveReply(&state, sender: sender, now: date)
            state.lines[index].startedAt = date
        case let .text(delta):
            let index = ensureActiveReply(&state, sender: sender, now: now)
            state.lines[index].text += delta
            state.lines[index].interim = ""
            if state.lines[index].thinkingStartedAt != nil && state.lines[index].thinkingEndedAt == nil { state.lines[index].thinkingEndedAt = now }
            state.isRunning = true
        case let .interim(text):
            let index = ensureActiveReply(&state, sender: sender, now: now)
            if state.lines[index].text.isEmpty { state.lines[index].interim = text }
        case let .reasoning(delta):
            let index = ensureActiveReply(&state, sender: sender, now: now)
            state.lines[index].reasoning += delta
            if state.lines[index].thinkingStartedAt == nil { state.lines[index].thinkingStartedAt = now }
            state.isRunning = true
        case .thinkingAvailable:
            let index = ensureActiveReply(&state, sender: sender, now: now)
            if state.lines[index].thinkingStartedAt == nil { state.lines[index].thinkingStartedAt = now }
        case let .tool(tool):
            let index = ensureActiveReply(&state, sender: sender, now: now)
            upsertTool(tool, in: &state.lines[index], now: now)
            state.isRunning = true
        case let .subagent(id, subEvent, title, detail):
            let index = ensureActiveReply(&state, sender: sender, now: now)
            let status: ToolStatus = subEvent == "subagent.complete" ? .done : (subEvent.hasSuffix("failed") || subEvent.hasSuffix("error") ? .error : .running)
            let key = "subagent-\(id)"
            if let toolIndex = state.lines[index].tools.firstIndex(where: { $0.id == key }) {
                state.lines[index].tools[toolIndex].status = status
                if !detail.isEmpty { state.lines[index].tools[toolIndex].detail = detail }
                if subEvent == "subagent.text" || subEvent == "subagent.thinking" { state.lines[index].tools[toolIndex].output = (state.lines[index].tools[toolIndex].output ?? "") + detail }
            } else {
                var step = ToolStep(id: key, name: title, detail: detail.nilIfEmpty ?? subEvent, status: status, startedAt: now, isSubagent: true)
                if subEvent == "subagent.text" { step.output = detail }
                state.lines[index].tools.append(step)
            }
        case let .usage(tokens, window):
            state.contextTokens = tokens
            if let window { state.contextWindow = window }
        case let .completed(output, reasoning, interrupted):
            if let index = state.activeIndex {
                finish(&state.lines[index], output: output, reasoning: reasoning, now: now)
                if interrupted { markRunningTools(&state.lines[index], as: .interrupted) }
            }
            state.isRunning = false
        case let .requiresAction(interaction):
            if let existing = state.lines.firstIndex(where: { $0.interaction?.id == interaction.id }) {
                var updated = interaction; updated.resolved = state.lines[existing].interaction?.resolved ?? false
                state.lines[existing].interaction = updated
            } else {
                state.lines.append(ChatLine(interaction: interaction, timestamp: now))
            }
        case let .actionResolved(id, choice):
            for index in state.lines.indices where state.lines[index].interaction != nil && (id.isEmpty || state.lines[index].interaction?.id == id) {
                state.lines[index].interaction?.resolved = true
                state.lines[index].interaction?.resolution = choice
            }
        case let .queued(items):
            state.queued = items
        case let .queueInsertion(id, phase):
            state.queueInsertionID = phase == "cancelled" || phase == "completed" ? "" : id
        case let .resumeState(resume):
            state.workspace = resume.workspace
            if !resume.model.isEmpty { state.model = resume.model }
            if !resume.provider.isEmpty { state.provider = resume.provider }
            if !resume.apiMode.isEmpty { state.apiMode = resume.apiMode }
            state.pushEnabled = resume.pushEnabled
            state.workspaceChanges = resume.workspaceChanges
        case let .resumed(isWorking, completion):
            if isWorking {
                state.isRunning = true
                _ = ensureActiveReply(&state, sender: sender, now: now)
            } else if let index = state.activeIndex, state.lines[index].isStreaming {
                if let completion { finish(&state.lines[index], output: completion.output, reasoning: completion.reasoning, now: now) }
                else if state.lines[index].text.isEmpty && state.lines[index].tools.isEmpty && state.lines[index].reasoning.isEmpty { state.lines.remove(at: index); state.activeReplyID = nil }
                else { finish(&state.lines[index], output: "", reasoning: "", now: now) }
                state.isRunning = false
            } else {
                state.isRunning = false
            }
        case let .settingsUpdated(settings):
            if !settings.model.isEmpty { state.model = settings.model }
            if !settings.provider.isEmpty { state.provider = settings.provider }
            if !settings.apiMode.isEmpty { state.apiMode = settings.apiMode }
            if let effort = settings.reasoningEffort { state.reasoningEffort = effort }
            if let push = settings.pushEnabled { state.pushEnabled = push }
        case let .titleUpdated(title):
            state.title = title
        case let .workspaceUpdated(workspace):
            state.workspace = workspace
        case let .compression(phase, messages, tokens):
            state.compression = ChatStreamState.Compression(phase: phase, messageCount: messages, tokenCount: tokens)
        case let .abort(phase):
            state.abortPhase = phase
            if phase == "completed" {
                if let index = state.activeIndex {
                    markRunningTools(&state.lines[index], as: .interrupted)
                    if state.lines[index].text.isEmpty && state.lines[index].tools.isEmpty && state.lines[index].reasoning.isEmpty { state.lines.remove(at: index); state.activeReplyID = nil }
                    else { finish(&state.lines[index], output: "", reasoning: "", now: now) }
                }
                state.isRunning = false
                state.abortPhase = nil
            }
        case let .peerMessage(role, content, timestamp):
            guard !content.isEmpty else { return }
            let kind = ChatLine.kind(forRole: role)
            state.lines.append(ChatLine(text: content, fromUser: kind == .user, timestamp: timestamp ?? now, sender: kind == .assistant ? sender : nil, kind: kind))
        case let .sessionCommand(result):
            if !result.message.isEmpty {
                state.lines.append(ChatLine(text: result.message, fromUser: false, timestamp: now, kind: result.ok ? .system : .error))
            }
            if result.terminal {
                if let index = state.activeIndex, state.lines[index].isStreaming {
                    if state.lines[index].text.isEmpty && state.lines[index].tools.isEmpty && state.lines[index].reasoning.isEmpty { state.lines.remove(at: index); state.activeReplyID = nil }
                    else { finish(&state.lines[index], output: "", reasoning: "", now: now) }
                }
                state.isRunning = false
            }
        case let .locationRequested(request):
            state.pendingLocation = request
        case .deviceRequested:
            break
        case let .workspaceDiff(summary):
            state.workspaceChanges.append(summary)
        case let .failed(message, _):
            guard !isSessionGone(message) else {
                // `app.resume`, `abort` and the queue events all answer with
                // this for an id the server does not know, and they are
                // re-sent on every reconnect. One empty state, never a stack
                // of red rows.
                state.sessionMissing = true
                if let index = state.activeIndex, state.lines[index].isStreaming,
                   state.lines[index].text.isEmpty, state.lines[index].tools.isEmpty, state.lines[index].reasoning.isEmpty {
                    state.lines.remove(at: index)
                    state.activeReplyID = nil
                }
                state.isRunning = false
                return
            }
            if let index = state.activeIndex, state.lines[index].isStreaming {
                if state.lines[index].text.isEmpty && state.lines[index].tools.isEmpty {
                    state.lines[index].text = message
                    state.lines[index].kind = .error
                    finish(&state.lines[index], output: "", reasoning: "", now: now)
                } else {
                    finish(&state.lines[index], output: "", reasoning: "", now: now)
                    markRunningTools(&state.lines[index], as: .error)
                    state.lines.append(ChatLine(text: message, fromUser: false, timestamp: now, kind: .error))
                }
            } else if !repeatsLastError(message, in: state) {
                state.lines.append(ChatLine(text: message, fromUser: false, timestamp: now, kind: .error))
            }
            state.isRunning = false
        }
    }

    /// The server's wording for an id it cannot resolve (`chat-run`
    /// `requireSocketSessionAccess`, and the 404 of the session routes).
    static func isSessionGone(_ message: String) -> Bool {
        let text = message.lowercased()
        return text.contains("session not found") || text.contains("conversation not found")
    }

    /// A reconnect loop can deliver the same failure again and again; one
    /// row is enough.
    private static func repeatsLastError(_ message: String, in state: ChatStreamState) -> Bool {
        guard let last = state.lines.last else { return false }
        return last.kind == .error && last.text == message
    }

    /// Appends the user's message and an empty streaming reply.
    static func beginRun(_ state: inout ChatStreamState, text: String, attachments: [ChatAttachmentRef], sender: String, now: Date = .now) {
        var user = ChatLine(text: text, fromUser: true, timestamp: now, attachments: attachments)
        if text.hasPrefix("/") && attachments.isEmpty { user.kind = .command }
        state.lines.append(user)
        let reply = ChatLine(text: "", fromUser: false, timestamp: now, sender: sender, isStreaming: true)
        state.lines.append(reply)
        state.activeReplyID = reply.id
        state.isRunning = true
        state.abortPhase = nil
        // This run re-creates the session on the server.
        state.sessionMissing = false
        if state.compression?.phase == "completed" { state.compression = nil }
    }

    /// Returns the index of the streaming reply, creating one when the last
    /// reply already finished (queued runs, peer runs, resumed runs).
    @discardableResult
    static func ensureActiveReply(_ state: inout ChatStreamState, sender: String, now: Date) -> Int {
        if let index = state.activeIndex, state.lines[index].isStreaming { return index }
        let reply = ChatLine(text: "", fromUser: false, timestamp: now, sender: sender, isStreaming: true)
        state.lines.append(reply)
        state.activeReplyID = reply.id
        return state.lines.count - 1
    }

    static func upsertTool(_ tool: ToolEvent, in line: inout ChatLine, now: Date) {
        if let index = line.tools.firstIndex(where: { $0.id == tool.id }) {
            line.tools[index].status = tool.status
            if let detail = tool.detail { line.tools[index].detail = detail }
            if let arguments = tool.arguments { line.tools[index].arguments = arguments }
            if let output = tool.output { line.tools[index].output = output }
            if let reasoning = tool.reasoning { line.tools[index].reasoning = reasoning }
            line.tools[index].outputTruncated = tool.outputTruncated || line.tools[index].outputTruncated
            if let length = tool.outputOriginalLength { line.tools[index].outputOriginalLength = length }
            line.tools[index].previewTruncated = tool.previewTruncated || line.tools[index].previewTruncated
            line.tools[index].duration = tool.duration ?? (tool.status == .running ? nil : now.timeIntervalSince(line.tools[index].startedAt))
        } else {
            var step = ToolStep(id: tool.id, name: tool.name, detail: tool.detail, status: tool.status, duration: tool.duration, startedAt: now)
            step.arguments = tool.arguments; step.output = tool.output; step.reasoning = tool.reasoning
            step.outputTruncated = tool.outputTruncated; step.outputOriginalLength = tool.outputOriginalLength; step.previewTruncated = tool.previewTruncated
            line.tools.append(step)
        }
        if line.thinkingStartedAt != nil && line.thinkingEndedAt == nil { line.thinkingEndedAt = now }
    }

    static func finish(_ line: inout ChatLine, output: String, reasoning: String, now: Date) {
        if line.text.isEmpty && !output.isEmpty { line.text = output }
        if line.text.isEmpty && !line.interim.isEmpty { line.text = line.interim }
        line.interim = ""
        if line.reasoning.isEmpty { line.reasoning = reasoning }
        if line.thinkingStartedAt != nil && line.thinkingEndedAt == nil { line.thinkingEndedAt = now }
        line.isStreaming = false
        line.finishedAt = now
        for index in line.tools.indices where line.tools[index].status == .running && !line.tools[index].isSubagent {
            line.tools[index].status = .done
            if line.tools[index].duration == nil { line.tools[index].duration = now.timeIntervalSince(line.tools[index].startedAt) }
        }
    }

    static func markRunningTools(_ line: inout ChatLine, as status: ToolStatus) {
        for index in line.tools.indices where line.tools[index].status == .running { line.tools[index].status = status }
    }
}

/// Header of the collapsible "N tools" card.
struct ToolSummary: Equatable {
    let count: Int
    /// Up to three unique names joined with " · ", then "+N".
    let names: String
    let hasError: Bool
    let hasInterrupted: Bool
    let isActive: Bool

    init(tools: [ToolStep]) {
        count = tools.count
        var unique: [String] = []
        for tool in tools where !tool.name.isEmpty && !unique.contains(tool.name) { unique.append(tool.name) }
        let visible = unique.prefix(3).joined(separator: " · ")
        names = unique.count > 3 ? "\(visible) · +\(unique.count - 3)" : visible
        hasError = tools.contains { $0.status == .error }
        hasInterrupted = tools.contains { $0.status == .interrupted }
        isActive = tools.contains { $0.status == .running }
    }

    /// "3 tools" / "3 أداة".
    var countLabel: String { String(localized: "\(count) tools") }
}

enum ThinkingFormat {
    /// Web `formatDuration`: seconds under a minute, else "1m 20s".
    static func duration(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval.rounded(.down)))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60, rest = seconds % 60
        return rest == 0 ? "\(minutes)m" : "\(minutes)m \(rest)s"
    }

    /// Observed duration for a line: from the first reasoning delta until the
    /// first content / tool / completion (or `now` while still thinking).
    static func observed(for line: ChatLine, now: Date = .now) -> TimeInterval? {
        guard let start = line.thinkingStartedAt else { return nil }
        let end = line.thinkingEndedAt ?? (line.isStreaming ? now : start)
        return max(0, end.timeIntervalSince(start))
    }

    static func characterCount(_ text: String) -> Int { text.count }
}

enum ReferenceQuote {
    /// Quotes a message into the composer the way the web reference action
    /// does: `> ` per line, at most eight lines, then the reply below.
    static func compose(quoted: String, reply: String, maxLines: Int = 8) -> String {
        let lines = quoted.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var quote = lines.prefix(maxLines).map { "> \($0)" }.joined(separator: "\n")
        if lines.count > maxLines { quote += "\n> …" }
        return [quote, reply].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "\n\n")
    }
}

enum ContextUsageFormat {
    /// ≥ 1e6 → "1.2M", ≥ 1e3 → "45.0k", else the integer.
    static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
        return String(value)
    }

    /// "45.0k / 256.0k · remaining 211.0k" (the `remaining` word is localized).
    static func label(used: Int, limit: Int, remainingWord: String) -> String {
        "\(tokens(used)) / \(tokens(limit)) · \(remainingWord) \(tokens(max(0, limit - used)))"
    }

    static func ratio(used: Int, limit: Int) -> Double { limit > 0 ? min(1, max(0, Double(used) / Double(limit))) : 0 }

    static func isWarning(used: Int, limit: Int) -> Bool { ratio(used: used, limit: limit) > 0.8 }
}

/// Reasoning-effort options shared with the web composer.
enum ReasoningEffortOption: String, CaseIterable, Identifiable {
    case none, minimal, low, medium, high, xhigh, max
    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: return String(localized: "None")
        case .minimal: return String(localized: "Minimal")
        case .low: return String(localized: "Low")
        case .medium: return String(localized: "Medium")
        case .high: return String(localized: "High")
        case .xhigh: return String(localized: "Very high")
        case .max: return String(localized: "Max")
        }
    }

    static func label(for value: String) -> String {
        ReasoningEffortOption(rawValue: value)?.label ?? (value.isEmpty ? String(localized: "Default") : value)
    }
}

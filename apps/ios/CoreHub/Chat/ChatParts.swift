// The pieces around a reply: a tool call's card, the card that asks for a decision or an
// answer, and the composer.
import CoreHubClient
import SwiftUI

struct ToolCallCard: View {
    let call: ToolCall
    @Environment(\.l10n) private var l10n
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Button {
                withAnimation(.easeInOut(duration: Motion.fast)) { open.toggle() }
            } label: {
                HStack(spacing: Space.s2) {
                    statusIcon
                    Text(call.name)
                        .font(.system(size: FontSize.sizeSm, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Tone.text)
                    if let preview = call.preview, !preview.isEmpty {
                        Text(preview)
                            .font(.system(size: FontSize.sizeXs, design: .monospaced))
                            .foregroundStyle(Tone.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    if let ms = call.durationMs {
                        Text(l10n("tool.duration", ["seconds": String(format: "%.1f", Double(ms) / 1000)]))
                            .font(.system(size: FontSize.sizeXs))
                            .foregroundStyle(Tone.textFaint)
                            .monospacedDigit()
                    }
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.system(size: FontSize.sizeXs))
                        .foregroundStyle(Tone.textFaint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(call.name), \(l10n(statusKey))")

            if open {
                if let arguments = call.arguments, !arguments.isEmpty {
                    section(l10n("tool.arguments"), ToolText.json(arguments))
                }
                if let output = call.output, !output.isEmpty {
                    section(l10n("tool.output"), output)
                    if call.outputTruncated {
                        Text(l10n("tool.truncated"))
                            .font(.system(size: FontSize.sizeXs))
                            .foregroundStyle(Tone.textFaint)
                    }
                }
            }
        }
        .padding(Space.s2)
        .background(Tone.surface2, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
        .accessibilityIdentifier("tool.\(call.name)")
    }

    private var statusKey: String {
        switch call.status {
        case .running: return "tool.running"
        case .succeeded: return "tool.succeeded"
        case .failed: return "tool.failed"
        case .interrupted: return "tool.interrupted"
        case .awaitingApproval: return "tool.awaiting_approval"
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch call.status {
        case .running:
            ProgressView().controlSize(.mini)
        case .succeeded:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Tone.statusRunning)
        case .failed:
            Image(systemName: "xmark.circle.fill").foregroundStyle(Tone.danger)
        case .interrupted:
            Image(systemName: "stop.circle").foregroundStyle(Tone.textMuted)
        case .awaitingApproval:
            Image(systemName: "hand.raised.circle").foregroundStyle(Tone.warningSoftText)
        }
    }

    private func section(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            Text(title)
                .font(.system(size: FontSize.sizeXs, weight: .semibold))
                .foregroundStyle(Tone.textMuted)
            CodeBlockView(language: nil, code: text)
        }
    }
}

enum ToolText {
    /// Tool arguments as indented JSON with sorted keys.
    static func json(_ arguments: [String: JSONValue]) -> String {
        guard let data = try? encoder.encode(arguments), let text = String(data: data, encoding: .utf8) else {
            return String(describing: arguments)
        }
        return text
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}

/// A decision the agent waits for (tool, write, plan, workflow step) or a question it asks
/// (Hermes's `clarify`): the choices the hub offers, a text answer where the question takes
/// one, and the decisions for an approval.
struct ApprovalCard: View {
    let approval: Approval
    let respond: (ApprovalDecision?, String?) -> Void
    @Environment(\.l10n) private var l10n
    @State private var answer = ""
    @State private var busy = false

    private var isQuestion: Bool { approval.kind == .question }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Text(isQuestion ? l10n("approval.question") : l10n("approval.title"))
                .font(.system(size: FontSize.sizeXs, weight: .semibold))
                .foregroundStyle(Tone.warningSoftText)
            Text(approval.title)
                .font(.system(size: FontSize.sizeMd, weight: .semibold))
                .foregroundStyle(Tone.text)
                .contentDirection(of: approval.title)
            if let description = approval.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
                    .contentDirection(of: description)
            }
            if let command = approval.command, !command.isEmpty {
                CodeBlockView(language: nil, code: command)
            }
            if isQuestion {
                questionControls
            } else {
                decisionControls
            }
        }
        .padding(Space.s3)
        .background(Tone.warningSoft.opacity(0.35), in: RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg, style: .continuous).strokeBorder(Tone.border))
        .disabled(busy)
        .accessibilityIdentifier("approval.\(approval.id)")
    }

    @ViewBuilder
    private var questionControls: some View {
        if approval.answerMode != .text, !approval.choices.isEmpty {
            FlowButtons(choices: approval.choices) { choice in
                submit(decision: nil, answer: choice.value)
            }
        }
        if approval.answerMode != .choice || approval.choices.isEmpty {
            HStack(spacing: Space.s2) {
                TextField(l10n("approval.answer_placeholder"), text: $answer, axis: .vertical)
                    .lineLimit(1...4)
                    .padding(.horizontal, Space.s3)
                    .padding(.vertical, Space.s2)
                    .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                Button(l10n("approval.send_answer")) {
                    submit(decision: nil, answer: answer)
                }
                .buttonStyle(.borderedProminent)
                .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var decisionControls: some View {
        let offered = ApprovalChoices.decisions(for: approval)
        return FlowButtons(
            choices: offered.map { Choice(value: $0.rawValue, label: label(for: $0)) },
            prominent: ApprovalDecision.approveOnce.rawValue
        ) { choice in
            submit(decision: ApprovalDecision(rawValue: choice.value), answer: nil)
        }
    }

    private func label(for decision: ApprovalDecision) -> String {
        // The hub's own label for a choice wins; ours when it sent none.
        if let hub = approval.choices.first(where: { $0.value == decision.rawValue }) { return hub.label }
        switch decision {
        case .approveOnce: return l10n("approval.approve_once")
        case .approveSession: return l10n("approval.approve_session")
        case .approveAlways: return l10n("approval.approve_always")
        case .deny: return l10n("approval.deny")
        }
    }

    private func submit(decision: ApprovalDecision?, answer: String?) {
        busy = true
        respond(decision, answer?.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

enum ApprovalChoices {
    /// The decisions an approval offers: what the hub listed when its choices are decisions,
    /// else once / this chat / always (when allowed) / deny.
    static func decisions(for approval: Approval) -> [ApprovalDecision] {
        let listed = approval.choices.compactMap { ApprovalDecision(rawValue: $0.value) }
        if !listed.isEmpty { return listed }
        var all: [ApprovalDecision] = [.approveOnce, .approveSession]
        if approval.allowAlways { all.append(.approveAlways) }
        all.append(.deny)
        return all
    }
}

/// Buttons that wrap onto as many lines as they need.
struct FlowButtons: View {
    let choices: [Choice]
    var prominent: String?
    let action: (Choice) -> Void

    var body: some View {
        FlowLayout(spacing: Space.s2) {
            ForEach(choices, id: \.value) { choice in
                if choice.value == prominent {
                    Button(choice.label) { action(choice) }.buttonStyle(.borderedProminent)
                } else if choice.value == ApprovalDecision.deny.rawValue {
                    Button(choice.label, role: .destructive) { action(choice) }.buttonStyle(.bordered)
                } else {
                    Button(choice.label) { action(choice) }.buttonStyle(.bordered)
                }
            }
        }
    }
}

struct FlowLayout: SwiftUI.Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: LayoutSubviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: LayoutSubviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// The floating composer: glass chrome, grows to six lines, Send — or Stop while a run works
/// and nothing is typed.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    let busy: Bool
    let sending: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    @Environment(\.l10n) private var l10n
    @FocusState private var focused: Bool

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending }

    var body: some View {
        HStack(alignment: .bottom, spacing: Space.s2) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...6)
                .font(.system(size: FontSize.sizeMd))
                .focused($focused)
                .padding(.vertical, Space.s2)
                .contentDirection(of: text.isEmpty ? placeholder : text)
                .accessibilityIdentifier("composer.input")
            if busy && text.isEmpty {
                Button(action: onStop) {
                    Image(systemName: "stop.fill")
                        .frame(width: Control.heightMd, height: Control.heightMd)
                        .background(Tone.danger, in: Circle())
                        .foregroundStyle(Tone.dangerText)
                }
                .accessibilityLabel(l10n("chat.stop"))
                .accessibilityIdentifier("composer.stop")
            } else {
                Button(action: onSend) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: FontSize.sizeMd, weight: .bold))
                        .frame(width: Control.heightMd, height: Control.heightMd)
                        .background(canSend ? Tone.accent : Tone.surface3, in: Circle())
                        .foregroundStyle(canSend ? Tone.accentText : Tone.textFaint)
                }
                .disabled(!canSend)
                .accessibilityLabel(l10n("chat.send"))
                .accessibilityIdentifier("composer.send")
            }
        }
        .padding(.leading, Space.s3)
        .padding(.trailing, Space.s1)
        .padding(.vertical, Space.s1)
        .floatingChrome(cornerRadius: Radius.xl)
        .frame(maxWidth: Layout.composerMax)
    }
}

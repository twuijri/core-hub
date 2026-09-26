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
                    LucideIcon(.chevronDown, size: 14)
                        .foregroundStyle(Tone.textFaint)
                        .rotationEffect(.degrees(open ? 180 : 0))
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
            LucideIcon(.circleCheck, size: 16).foregroundStyle(Tone.statusRunning)
        case .failed:
            LucideIcon(.circleX, size: 16).foregroundStyle(Tone.danger)
        case .interrupted:
            LucideIcon(.circleStop, size: 16).foregroundStyle(Tone.textMuted)
        case .awaitingApproval:
            LucideIcon(.hand, size: 16).foregroundStyle(Tone.warningSoftText)
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
    /// Files waiting to go with the message (the «+» button and its chips); none when nil.
    var attachments: AttachmentTray? = nil
    /// The profile the files are uploaded into: the chat's own.
    var profile: String = ""
    /// The conversation's latest words: with Auto and no keyboard to go by, dictation listens
    /// in the language they are written in.
    var recentText: [String] = []
    @Environment(\.l10n) private var l10n
    @Environment(AppModel.self) private var app
    @FocusState private var focused: Bool
    @State private var dictation = Dictation()
    /// What was typed before dictation started; what is heard follows it.
    @State private var dictationBase = ""
    /// The strip's Send (or Send while listening) was pressed: the message goes once the words are in.
    @State private var sendWhenHeard = false
    @State private var choosingLanguage = false

    private var hasFiles: Bool { !(attachments?.attachments.isEmpty ?? true) }
    private var canSend: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasFiles)
            && !sending && !(attachments?.uploading ?? false)
    }
    private var dictating: Bool { dictation.state == .listening || dictation.state == .transcribing }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            if case .failed(let message) = dictation.state {
                Text(message)
                    .font(.system(size: FontSize.sizeXs))
                    .foregroundStyle(Tone.dangerSoftText)
                    .padding(.horizontal, Space.s3)
            }
            if let attachments, !attachments.isEmpty {
                AttachmentChips(tray: attachments)
            }
            if dictating {
                DictationStrip(
                    dictation: dictation,
                    badge: DictationLanguage.badge(dictation.listeningIn ?? DictationLanguage.auto),
                    onCancel: {
                        sendWhenHeard = false
                        dictation.cancel()
                        text = dictationBase
                    },
                    onStop: { dictation.stop() },
                    onSend: send
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            field
        }
        .animation(.easeOut(duration: Motion.fast), value: dictating)
        .onAppear { _ = KeyboardLanguage.shared }
        .onChange(of: dictation.heard) { _, heard in
            guard dictating || dictation.state == .idle else { return }
            text = Dictation.join(dictationBase, heard)
        }
        .onChange(of: dictation.state) { _, state in
            guard sendWhenHeard else { return }
            switch state {
            case .idle:
                sendWhenHeard = false
                if canSend { onSend() }
            case .failed:
                sendWhenHeard = false
            default:
                break
            }
        }
        .sheet(isPresented: $choosingLanguage) {
            NavigationStack {
                DictationLanguageList(choice: Bindable(app.device).dictationLanguage)
            }
        }
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: Space.s2) {
            if let attachments {
                AttachButton(tray: attachments, profile: profile)
            }
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...6)
                .font(.system(size: FontSize.sizeMd))
                .focused($focused)
                .padding(.vertical, Space.s2)
                .contentDirection(of: text.isEmpty ? placeholder : text)
                .accessibilityIdentifier("composer.input")
            if app.device.voiceInput {
                microphone
            }
            if busy && text.isEmpty && !hasFiles && !dictating {
                Button(action: onStop) {
                    // The stop glyph is a filled square, drawn as a shape: an outline icon
                    // cannot be filled (the web fills Lucide's square the same way).
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                        .fill(Tone.dangerText)
                        .frame(width: 12, height: 12)
                        .frame(width: Control.heightMd, height: Control.heightMd)
                        .background(Tone.danger, in: Circle())
                        .hitSlop()
                }
                .accessibilityLabel(l10n("chat.stop"))
                .accessibilityIdentifier("composer.stop")
            } else {
                Button(action: send) {
                    LucideIcon(.arrowUp, size: 18)
                        .frame(width: Control.heightMd, height: Control.heightMd)
                        .background(canSend ? Tone.accent : Tone.surface3, in: Circle())
                        .foregroundStyle(canSend ? Tone.accentText : Tone.textFaint)
                        .hitSlop()
                        .animation(.easeOut(duration: Motion.fast), value: canSend)
                }
                .disabled(!canSend && !dictating)
                .accessibilityLabel(l10n("chat.send"))
                .accessibilityIdentifier("composer.send")
            }
        }
        .padding(.leading, attachments == nil ? Space.s3 : Space.s1)
        .padding(.trailing, Space.s1)
        .padding(.vertical, Space.s1)
        .floatingChrome(cornerRadius: Radius.xl)
        .frame(maxWidth: Layout.composerMax)
    }

    /// A tap dictates (or stops); a long press chooses the language — Auto, the default,
    /// follows the keyboard. A chosen language shows as a small mark on the microphone.
    private var microphone: some View {
        Menu {
            Picker(l10n("voice.language"), selection: Bindable(app.device).dictationLanguage) {
                Text(l10n("voice.language_auto")).tag(DictationLanguage.auto)
                ForEach(menuLanguages, id: \.self) { tag in
                    Text(DictationLanguage.name(tag, in: app.language.rawValue)).tag(tag)
                }
            }
            .pickerStyle(.inline)
            Button(l10n("voice.language_more")) { choosingLanguage = true }
        } label: {
            Group {
                if dictation.state == .transcribing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(lucide: .mic)
                        .resizable()
                        .frame(width: 20, height: 20)
                        .foregroundStyle(dictation.state == .listening ? Tone.danger : Tone.textMuted)
                }
            }
            .frame(width: Control.heightMd, height: Control.heightMd)
            .overlay(alignment: .topTrailing) {
                if let badge = DictationLanguage.badge(app.device.dictationLanguage) {
                    Text(badge)
                        .font(.system(size: 8, weight: .bold))
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(Tone.accent, in: Capsule())
                        .foregroundStyle(Tone.accentText)
                        .accessibilityHidden(true)
                }
            }
        } primaryAction: {
            toggleDictation()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(dictation.state == .transcribing)
        .accessibilityLabel(
            dictation.state == .transcribing ? l10n("voice.transcribing")
                : dictation.state == .listening ? l10n("voice.stop") : l10n("voice.dictate")
        )
        .accessibilityValue(
            app.device.dictationLanguage == DictationLanguage.auto ? l10n("voice.language_auto")
                : DictationLanguage.name(app.device.dictationLanguage, in: app.language.rawValue)
        )
        .accessibilityHint(l10n("voice.language_hint"))
        .accessibilityIdentifier("composer.dictate")
    }

    /// The menu's languages: the one chosen from «More», then the keyboards', then popular ones.
    private var menuLanguages: [String] {
        let choice = app.device.dictationLanguage
        let offered = DictationLanguage.menu(keyboards: KeyboardLanguage.enabled, supported: nil)
        if choice == DictationLanguage.auto || offered.contains(where: { DictationLanguage.base($0) == DictationLanguage.base(choice) }) {
            return offered
        }
        return [choice] + offered
    }

    /// Send: while dictating, once the last words are in.
    private func send() {
        guard dictating else { return onSend() }
        sendWhenHeard = true
        if dictation.state == .listening { dictation.stop() }
    }

    private func toggleDictation() {
        if dictation.state == .listening {
            dictation.stop()
            return
        }
        dictationBase = text
        let languages = DictationLanguage.candidates(
            choice: app.device.dictationLanguage,
            keyboard: KeyboardLanguage.shared.refresh(),
            recent: recentText,
            keyboards: KeyboardLanguage.enabled,
            preferred: Locale.preferredLanguages,
            app: app.language.rawValue
        )
        // With Auto the hub's model detects the language itself; a chosen one goes as its hint.
        let language = app.device.hubDictationLanguage
        let target = profile.isEmpty ? app.currentProfile : profile
        Task {
            // The hub listens when the person chose Core Hub and the profile has a provider.
            var hub: Dictation.Transcribe?
            if app.device.voiceSource == .hub {
                let ready = await HubSpeech.shared.ready(app: app, profile: target)
                if VoiceRoute.choose(app.device.voiceSource, hubReady: ready?.stt) == .hub {
                    hub = { [app] audio, durationMs in
                        try await app.api.call {
                            try await ModelsAPI.modelsTranscribe(
                                xHubProfile: target, audio: audio, language: language, durationMs: durationMs,
                                apiConfiguration: $0
                            )
                        }.text
                    }
                }
            }
            await dictation.start(languages: languages, l10n: l10n, hub: hub)
        }
    }
}

/// Over the composer while dictating: cancel, the microphone's level, stop, and send.
struct DictationStrip: View {
    let dictation: Dictation
    /// The language the phone listens in, as its short mark; nil while the hub listens.
    let badge: String?
    let onCancel: () -> Void
    let onStop: () -> Void
    let onSend: () -> Void
    @Environment(\.l10n) private var l10n

    var body: some View {
        HStack(spacing: Space.s2) {
            if dictation.state == .listening {
                Button(action: onCancel) {
                    LucideIcon(.x, size: 16)
                        .frame(width: Control.heightSm, height: Control.heightSm)
                        .foregroundStyle(Tone.textMuted)
                        .hitSlop(8)
                }
                .accessibilityLabel(l10n("voice.cancel"))
                .accessibilityIdentifier("dictation.cancel")
                Waveform(levels: dictation.levels)
                if let badge {
                    Text(badge)
                        .font(.system(size: FontSize.sizeXs, weight: .semibold))
                        .foregroundStyle(Tone.textMuted)
                        .accessibilityHidden(true)
                }
                Button(action: onStop) {
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                        .fill(Tone.danger)
                        .frame(width: 12, height: 12)
                        .frame(width: Control.heightSm, height: Control.heightSm)
                        .hitSlop(8)
                }
                .accessibilityLabel(l10n("voice.stop"))
                .accessibilityIdentifier("dictation.stop")
            } else {
                ProgressView().controlSize(.small)
                Text(l10n("voice.transcribing"))
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
                Spacer(minLength: 0)
            }
            Button(action: onSend) {
                LucideIcon(.arrowUp, size: 16)
                    .frame(width: Control.heightSm, height: Control.heightSm)
                    .background(Tone.accent, in: Circle())
                    .foregroundStyle(Tone.accentText)
                    .hitSlop(8)
            }
            .accessibilityLabel(l10n("voice.send"))
            .accessibilityIdentifier("dictation.send")
        }
        .padding(.horizontal, Space.s2)
        .padding(.vertical, Space.s1)
        .floatingChrome(cornerRadius: Radius.xl)
        .frame(maxWidth: Layout.composerMax)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dictation.strip")
    }
}

/// The microphone's loudness over the last moments, as bars.
struct Waveform: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(Tone.accent)
                    .frame(width: 3, height: max(3, CGFloat(level) * 22))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24, maxHeight: 24)
        .animation(.linear(duration: 0.08), value: levels)
        .accessibilityHidden(true)
    }
}

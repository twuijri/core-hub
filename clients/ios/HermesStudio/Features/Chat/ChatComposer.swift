import SwiftUI

enum ComposerVoiceState: Equatable { case idle, listening, transcribing, error }

/// Values the composer renders; the conversation owns them.
struct ChatComposerState {
    var isRunning = false
    var contextTokens = 0
    var contextWindow = 0
    var loadingContext = false
    var models: [ModelOption] = []
    var selectedModel = ""
    var reasoningEffort = ""
    var showToolCalls = true
    var voiceMode = false
    var pushEnabled = true
    var profile = ""
    var voiceState: ComposerVoiceState = .idle
    var isRecording = false
    var recordingElapsed: TimeInterval = 0
    /// Dictation language of the active profile, shown while the mic is open.
    var speechLanguage = ""
}

struct ChatComposerActions {
    var send: () -> Void = {}
    var stop: () -> Void = {}
    var queue: () -> Void = {}
    var mic: () -> Void = {}
    /// Long press on the mic: pick the dictation language without leaving the chat.
    var micLanguage: () -> Void = {}
    var attachCamera: () -> Void = {}
    var attachPhotos: () -> Void = {}
    var attachFiles: () -> Void = {}
    var cancelUpload: (String) -> Void = { _ in }
    var selectModel: (ModelOption) -> Void = { _ in }
    var selectReasoning: (String) -> Void = { _ in }
    var toggleToolCalls: () -> Void = {}
    var toggleVoiceMode: () -> Void = {}
    var togglePush: () -> Void = {}
    var cancelReference: () -> Void = {}
}

/// Composer card (radius 18, min 150 pt, shadow): reference chip, attachment
/// strip with progress, 16 pt input with per-string direction, toolbar
/// [+] [🧠] [⚙] [model] … [mic 30] [send/stop 30], context indicator top-end.
/// Labels collapse to icons under 380 pt. The input is never auto-focused.
struct ChatComposer: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let uploads: [AttachmentUpload]
    let reference: ChatLine?
    let state: ChatComposerState
    let actions: ChatComposerActions
    let availableWidth: CGFloat
    @Environment(\.colorScheme) var colorScheme

    private var compact: Bool { availableWidth < 380 }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var uploading: Bool { uploads.contains { $0.phase == .uploading } }
    private var canSend: Bool { (!trimmed.isEmpty || uploads.contains { $0.phase == .done }) && !uploading }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reference { ReferenceChip(line: reference, onCancel: actions.cancelReference) }
            if !uploads.isEmpty { AttachmentStrip(uploads: uploads, onCancel: actions.cancelUpload) }
            if state.voiceState != .idle { VoiceStatusRow(state: state) }
            ComposerInput(text: $text, focused: focused, onSubmit: { if canSend { actions.send() } })
            ComposerToolbar(state: state, actions: actions, compact: compact, canSend: canSend, hasDraft: !trimmed.isEmpty)
        }
        .padding(.top, 22)
        .padding(.horizontal, 12)
        .padding(.bottom, 9)
        .frame(minHeight: CoreHubTokens.Layout.composerMinHeight, alignment: .bottom)
        .overlay(alignment: .topTrailing) {
            ContextUsageView(tokens: state.contextTokens, window: state.contextWindow, loading: state.loadingContext)
                .padding(.top, 8)
                .padding(.trailing, 14)
        }
        .background(CoreHubTokens.Palette.bgComposer, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.composer, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.composer, style: .continuous).stroke(focused.wrappedValue ? CoreHubTokens.Palette.accent : CoreHubTokens.Palette.borderLight))
        .coreHubShadow(focused.wrappedValue ? CoreHubTokens.Shadow.focused : CoreHubTokens.Shadow.composer(for: colorScheme))
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }
}

private struct ComposerInput: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let onSubmit: () -> Void
    @EnvironmentObject private var store: AppStore

    private var direction: LayoutDirection { text.isEmpty ? store.layoutDirection : MarkdownText.layoutDirection(for: text) }

    var body: some View {
        TextField("Type a message…", text: $text, axis: .vertical)
            .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.inputMinimum))
            .foregroundStyle(CoreHubTokens.Palette.textPrimary)
            .lineLimit(1...8)
            .focused(focused)
            .multilineTextAlignment(.leading)
            .environment(\.layoutDirection, direction)
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ComposerToolbar: View {
    let state: ChatComposerState
    let actions: ChatComposerActions
    let compact: Bool
    let canSend: Bool
    let hasDraft: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            AttachMenu(actions: actions)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ReasoningPill(value: state.reasoningEffort, compact: compact, select: actions.selectReasoning)
                    SettingsPill(state: state, actions: actions, compact: compact)
                    ModelPill(models: state.models, selected: state.selectedModel, compact: compact, select: actions.selectModel)
                }
            }
            Spacer(minLength: 2)
            if state.isRunning && hasDraft {
                Button(action: actions.queue) {
                    Image(systemName: "text.line.last.and.arrowtriangle.forward")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                        .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
                        .background(CoreHubTokens.Palette.bgSecondary, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Queue message")
            }
            MicButton(state: state, action: actions.mic, longPress: actions.micLanguage)
            SendButton(isRunning: state.isRunning, canSend: canSend, send: actions.send, stop: actions.stop)
        }
    }
}

private struct AttachMenu: View {
    let actions: ChatComposerActions

    var body: some View {
        Menu {
            Button(action: actions.attachCamera) { Label("Take photo", systemImage: "camera") }
            Button(action: actions.attachPhotos) { Label("Photo library", systemImage: "photo.on.rectangle") }
            Button(action: actions.attachFiles) { Label("Attach files", systemImage: "paperclip") }
        } label: {
            CoreHubIconView(icon: .plus, size: 18)
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
                .background(CoreHubTokens.Palette.bgCard, in: Circle())
                .overlay(Circle().stroke(CoreHubTokens.Palette.inputBorderIdle))
        }
        .accessibilityLabel("Attach")
    }
}

private struct ReasoningPill: View {
    let value: String
    let compact: Bool
    let select: (String) -> Void

    var body: some View {
        Menu {
            Button { select("") } label: { MenuChoice(text: String(localized: "Default"), selected: value.isEmpty) }
            ForEach(ReasoningEffortOption.allCases) { option in
                Button { select(option.rawValue) } label: { MenuChoice(text: option.label, selected: value == option.rawValue) }
            }
        } label: {
            ComposerPill(symbol: "brain.head.profile", text: compact ? nil : ReasoningEffortOption.label(for: value))
        }
        .accessibilityLabel("Reasoning effort")
    }
}

private struct SettingsPill: View {
    let state: ChatComposerState
    let actions: ChatComposerActions
    let compact: Bool

    var body: some View {
        Menu {
            Button(action: actions.toggleVoiceMode) { MenuChoice(text: String(localized: "Voice mode"), selected: state.voiceMode) }
            Button(action: actions.toggleToolCalls) { MenuChoice(text: String(localized: "Show tool calls"), selected: state.showToolCalls) }
            Button(action: actions.togglePush) { MenuChoice(text: String(localized: "Push"), selected: state.pushEnabled) }
        } label: {
            ComposerPill(symbol: "gearshape", text: compact ? nil : String(localized: "Settings"))
        }
        .accessibilityLabel("Settings")
    }
}

private struct ModelPill: View {
    let models: [ModelOption]
    let selected: String
    let compact: Bool
    let select: (ModelOption) -> Void

    var body: some View {
        Menu {
            if models.isEmpty { Text("No models available") }
            ForEach(models) { model in
                Button { select(model) } label: { MenuChoice(text: model.name, selected: model.id == selected) }
            }
        } label: {
            ComposerPill(symbol: "cpu", text: compact && selected.isEmpty ? nil : (selected.nilIfEmpty ?? String(localized: "Model")), technical: true)
        }
        .accessibilityLabel("Model")
    }
}

/// Menu row with a check mark when selected (an empty SF Symbol name logs a warning).
struct MenuChoice: View {
    let text: String
    let selected: Bool

    var body: some View {
        if selected { Label(text, systemImage: "checkmark") } else { Text(text) }
    }
}

private struct MicButton: View {
    let state: ChatComposerState
    let action: () -> Void
    let longPress: () -> Void

    private var symbol: String {
        switch state.voiceState {
        case .listening: return "stop.fill"
        case .transcribing: return "ellipsis"
        case .error: return "mic.slash.fill"
        case .idle: return "mic.fill"
        }
    }
    private var foreground: Color {
        switch state.voiceState {
        case .listening: return CoreHubTokens.Palette.textOnAccent
        case .error: return CoreHubTokens.Palette.error
        default: return CoreHubTokens.Palette.textPrimary
        }
    }
    private var background: Color { state.voiceState == .listening ? CoreHubTokens.Palette.error : CoreHubTokens.Palette.bgSecondary }
    private var isDisabled: Bool { state.voiceState == .transcribing }

    /// A plain `Button` plus `simultaneousGesture` fires both callbacks on a
    /// long press, so tap and long press are separate gestures here.
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(foreground)
            .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
            .background(background, in: Circle())
            .opacity(isDisabled ? 0.55 : 1)
            .contentShape(Circle())
            .onTapGesture { if !isDisabled { action() } }
            .onLongPressGesture(minimumDuration: 0.45) { longPress() }
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(state.voiceState == .listening ? "Stop" : "Voice input")
            .accessibilityHint("Touch and hold to choose the dictation language")
            .accessibilityAction(named: Text("Dictation language")) { longPress() }
    }
}

/// Accent circle with an arrow; a stop square while a run is streaming.
private struct SendButton: View {
    let isRunning: Bool
    let canSend: Bool
    let send: () -> Void
    let stop: () -> Void

    var body: some View {
        Button { isRunning ? stop() : send() } label: {
            Group {
                if isRunning {
                    RoundedRectangle(cornerRadius: 2).fill(CoreHubTokens.Palette.textOnAccent).frame(width: 11, height: 11)
                } else {
                    Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)).foregroundStyle(CoreHubTokens.Palette.textOnAccent)
                }
            }
            .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
            .background(isRunning || canSend ? CoreHubTokens.Palette.accent : CoreHubTokens.Palette.accentMuted, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isRunning && !canSend)
        .accessibilityLabel(isRunning ? "Stop" : "Send")
    }
}

/// Toolbar pill (radius 999, 11 pt, icon + optional label; the model label is
/// technical text limited to 190 pt).
struct ComposerPill: View {
    let symbol: String
    let text: String?
    var technical = false

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 11, weight: .medium))
            if let text {
                if technical {
                    TechnicalText(text: text, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textSecondary)
                        .frame(maxWidth: CoreHubTokens.Layout.modelPillMaxWidth)
                } else {
                    Text(text).font(CoreHubTokens.Typography.metaFont).lineLimit(1)
                }
            }
        }
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        .padding(.horizontal, 9)
        .frame(height: 26)
        .background(CoreHubTokens.Palette.bgCard, in: Capsule())
        .overlay(Capsule().stroke(CoreHubTokens.Palette.inputBorderIdle))
    }
}

private struct ReferenceChip: View {
    let line: ChatLine
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Replying to").font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.author, weight: .semibold)).foregroundStyle(CoreHubTokens.Palette.accent)
                DirectionalText(text: line.text, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textSecondary, lineLimit: 2)
            }
            Spacer()
            Button(action: onCancel) { Image(systemName: "xmark.circle.fill").foregroundStyle(CoreHubTokens.Palette.textMuted) }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel reference")
        }
        .padding(10)
        .background(CoreHubTokens.Palette.bgSecondary, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble))
    }
}

/// Attachment chips with upload progress and a cancel/remove button.
struct AttachmentStrip: View {
    let uploads: [AttachmentUpload]
    let onCancel: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(uploads) { upload in AttachmentChip(upload: upload, onCancel: onCancel) }
            }
        }
    }
}

private struct AttachmentChip: View {
    let upload: AttachmentUpload
    let onCancel: (String) -> Void

    private var symbol: String {
        switch MediaKind.classify(path: upload.name, mime: upload.mime) {
        case .image: return "photo"
        case .video: return "video"
        case .audio: return "waveform"
        case .file: return "doc"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
            VStack(alignment: .leading, spacing: 2) {
                TechnicalText(text: upload.name, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textSecondary).frame(maxWidth: 140)
                switch upload.phase {
                case .uploading:
                    ProgressView(value: upload.fraction).progressViewStyle(.linear).frame(width: 90, height: 3).tint(CoreHubTokens.Palette.accent)
                case .done:
                    EmptyView()
                case let .failed(message):
                    Text(message).font(CoreHubTokens.Typography.font(10)).foregroundStyle(CoreHubTokens.Palette.error).lineLimit(1)
                case .cancelled:
                    Text("Cancelled").font(CoreHubTokens.Typography.font(10)).foregroundStyle(CoreHubTokens.Palette.textMuted)
                }
            }
            Button { onCancel(upload.id) } label: { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .accessibilityLabel(upload.phase == .uploading ? "Cancel upload" : "Remove attachment")
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(CoreHubTokens.Palette.bgSecondary, in: Capsule())
    }
}

/// Which language the mic is listening for, so a wrong language is visible
/// before the words come back wrong. Its own direction: an Arabic endonym must
/// not be reordered by an English layout.
private struct SpeechLanguageChip: View {
    let label: String

    var body: some View {
        if !label.isEmpty {
            Text(label)
                .font(CoreHubTokens.Typography.metaFont)
                .foregroundStyle(CoreHubTokens.Palette.textMuted)
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(CoreHubTokens.Palette.bgSecondary, in: Capsule())
                .environment(\.layoutDirection, MarkdownText.layoutDirection(for: label))
                .accessibilityLabel(Text("Dictation language"))
                .accessibilityValue(Text(label))
        }
    }
}

private struct VoiceStatusRow: View {
    let state: ChatComposerState

    var body: some View {
        HStack(spacing: 8) {
            switch state.voiceState {
            case .listening:
                Circle().fill(CoreHubTokens.Palette.error).frame(width: 8, height: 8)
                if state.isRecording {
                    Text("Recording \(state.recordingElapsed.formatted(.number.precision(.fractionLength(0))))s").font(CoreHubTokens.Typography.metaFont.monospacedDigit())
                } else {
                    Text("Listening…").font(CoreHubTokens.Typography.metaFont)
                }
                SpeechLanguageChip(label: state.speechLanguage)
                Spacer(minLength: 6)
                Text("Tap the microphone to finish").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted).lineLimit(1)
            case .transcribing:
                ProgressView().controlSize(.mini)
                Text("Transcribing…").font(CoreHubTokens.Typography.metaFont)
                SpeechLanguageChip(label: state.speechLanguage)
                Spacer()
            case .error:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(CoreHubTokens.Palette.error)
                Text("Voice input failed. Tap the microphone to try again.").font(CoreHubTokens.Typography.metaFont)
                Spacer()
            case .idle:
                EmptyView()
            }
        }
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
    }
}

/// "45.0k / 256.0k · remaining 211.0k", 11 pt muted, amber above 80 %, bar 42×4.
struct ContextUsageView: View {
    let tokens: Int
    let window: Int
    let loading: Bool

    private var ratio: Double { ContextUsageFormat.ratio(used: tokens, limit: window) }
    private var color: Color { ContextUsageFormat.isWarning(used: tokens, limit: window) ? CoreHubTokens.Palette.contextWarning : CoreHubTokens.Palette.textMuted }

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            Text(loading ? String(localized: "Context…") : label)
                .font(CoreHubTokens.Typography.metaFont)
                .lineLimit(1)
                .environment(\.layoutDirection, .leftToRight)
            ZStack(alignment: .leading) {
                Capsule().fill(CoreHubTokens.Palette.border)
                Capsule().fill(color).frame(width: CoreHubTokens.Layout.contextBarWidthPhone * ratio)
            }
            .frame(width: CoreHubTokens.Layout.contextBarWidthPhone, height: CoreHubTokens.Layout.contextBarHeight)
        }
        .foregroundStyle(color)
        .accessibilityLabel(label)
    }

    private var label: String {
        guard window > 0 else { return String(localized: "Context —") }
        return ContextUsageFormat.label(used: tokens, limit: window, remainingWord: String(localized: "remaining"))
    }

    static func compact(_ value: Int) -> String { ContextUsageFormat.tokens(value) }
}

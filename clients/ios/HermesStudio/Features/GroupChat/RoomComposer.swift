import SwiftUI

struct RoomComposerState {
    var connected = true
    var sending = false
    /// Seat names (plus `all` when allowed) offered by the @ menu.
    var mentionNames: [String] = []
}

struct RoomComposerActions {
    var send: () -> Void = {}
    var attachCamera: () -> Void = {}
    var attachPhotos: () -> Void = {}
    var attachFiles: () -> Void = {}
    var cancelUpload: (String) -> Void = { _ in }
    var insertMention: (String) -> Void = { _ in }
}

/// Room composer: the same card as the chat composer (radius 18, shadow,
/// 16 pt input with per-string direction) with the attach menu, the @mention
/// menu and the send button. Models and reasoning belong to the seats, not
/// to the room, so those pills are not shown.
struct RoomComposer: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let uploads: [AttachmentUpload]
    let state: RoomComposerState
    let actions: RoomComposerActions
    @Environment(\.colorScheme) private var colorScheme

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var uploading: Bool { uploads.contains { $0.phase == .uploading } }
    private var canSend: Bool { (!trimmed.isEmpty || uploads.contains { $0.phase == .done }) && !uploading && state.connected && !state.sending }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !uploads.isEmpty { AttachmentStrip(uploads: uploads, onCancel: actions.cancelUpload) }
            input
            toolbar
        }
        .padding(.top, 14)
        .padding(.horizontal, 12)
        .padding(.bottom, 9)
        .frame(minHeight: 120, alignment: .bottom)
        .background(CoreHubTokens.Palette.bgComposer, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.composer, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.composer, style: .continuous).stroke(focused.wrappedValue ? CoreHubTokens.Palette.accent : CoreHubTokens.Palette.borderLight))
        .coreHubShadow(focused.wrappedValue ? CoreHubTokens.Shadow.focused : CoreHubTokens.Shadow.composer(for: colorScheme))
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }

    private var input: some View {
        TextField("Message the group…", text: $text, axis: .vertical)
            .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.inputMinimum))
            .foregroundStyle(CoreHubTokens.Palette.textPrimary)
            .lineLimit(1...8)
            .focused(focused)
            .multilineTextAlignment(.leading)
            .environment(\.layoutDirection, MarkdownText.layoutDirection(for: text))
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var toolbar: some View {
        HStack(spacing: 6) {
            attachMenu
            mentionMenu
            Spacer(minLength: 0)
            sendButton
        }
    }

    private var attachMenu: some View {
        Menu {
            Button { actions.attachCamera() } label: { Label("Camera", systemImage: "camera") }
            Button { actions.attachPhotos() } label: { Label("Photo library", systemImage: "photo.on.rectangle") }
            Button { actions.attachFiles() } label: { Label("Files", systemImage: "folder") }
        } label: {
            CoreHubIconView(icon: .plus, size: 16)
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
                .background(CoreHubTokens.Palette.hover, in: Circle())
        }
        .accessibilityLabel("Attach")
    }

    @ViewBuilder private var mentionMenu: some View {
        if !state.mentionNames.isEmpty {
            Menu {
                ForEach(state.mentionNames, id: \.self) { name in
                    Button { actions.insertMention(name) } label: { Text(verbatim: "@\(name)") }
                }
            } label: {
                ComposerPill(symbol: "at", text: String(localized: "Mention"))
            }
            .accessibilityLabel("Mention an agent")
        }
    }

    private var sendButton: some View {
        Button { actions.send() } label: {
            Group {
                if state.sending { ProgressView().controlSize(.small) }
                else { Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)) }
            }
            .foregroundStyle(CoreHubTokens.Palette.textOnAccent)
            .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
            .background(canSend ? CoreHubTokens.Palette.accent : CoreHubTokens.Palette.accentMuted, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Send")
    }
}

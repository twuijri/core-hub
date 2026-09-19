import SwiftUI

/// Shared row inputs: the width bubbles may use, the assistant identity and
/// the action-row callbacks.
struct MessageRowContext {
    let availableWidth: CGFloat
    let session: SessionSummary
    let api: APIClient
    let agent: AgentAvatarAsset
    let showToolCalls: Bool
    let canFork: Bool
    let isSpeaking: (ChatLine) -> Bool
    let onSpeak: (ChatLine) -> Void
    let onCopy: (ChatLine) -> Void
    let onReference: (ChatLine) -> Void
    let onFork: (ChatLine) -> Void
    /// Approval choice or clarification answer.
    let onRespond: (ChatInteraction, String) -> Void
    /// Group rooms: the avatar of the agent that produced a given line.
    var agentFor: ((ChatLine) -> AgentAvatarAsset)? = nil
    /// Group rooms: files resolve through `/rooms/{roomId}/attachments`.
    var roomID: String? = nil

    var userMaxWidth: CGFloat { max(120, availableWidth * CoreHubTokens.Layout.userBubbleMaxFraction) }
    var assistantMaxWidth: CGFloat { max(160, availableWidth * CoreHubTokens.Layout.assistantBubbleMaxFraction) }
}

struct MessageRow: View {
    let line: ChatLine
    let context: MessageRowContext

    var body: some View {
        switch line.kind {
        case .user: UserMessageRow(line: line, context: context)
        case .assistant: AssistantMessageRow(line: line, context: context)
        case .system: SystemMessageRow(line: line, isError: false)
        case .error: SystemMessageRow(line: line, isError: true)
        case .command: CommandMessageRow(line: line, context: context)
        case .interaction: InteractionCard(line: line, context: context)
        }
    }
}

/// User bubble: end-aligned, max 75 %, `msg.user`, radius 10, padding 10×14.
struct UserMessageRow: View {
    let line: ChatLine
    let context: MessageRowContext

    var body: some View {
        let parsed = ChatFiles.parse(line.text)
        HStack(alignment: .top, spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 8) {
                AttachmentChips(attachments: line.attachments)
                if !parsed.text.isEmpty {
                    MarkdownText(text: parsed.text)
                        .font(CoreHubTokens.Typography.messageFont)
                        .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                }
                MessageFiles(files: parsed.files, context: context)
                MessageActionRow(line: line, context: context)
            }
            .padding(.horizontal, CoreHubTokens.Layout.bubblePaddingHorizontal)
            .padding(.vertical, CoreHubTokens.Layout.bubblePaddingVertical)
            .background(CoreHubTokens.Palette.msgUser, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous))
            .frame(maxWidth: context.userMaxWidth, alignment: .trailing)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Assistant bubble: 22 pt agent avatar + author label, max 80 %.
struct AssistantMessageRow: View {
    let line: ChatLine
    let context: MessageRowContext

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            let asset = context.agentFor?(line) ?? context.agent
            AgentAvatarView(asset: asset, size: CoreHubTokens.Layout.assistantAvatar, streaming: line.isStreaming)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 8) {
                Text(line.sender?.nilIfEmpty ?? asset.label)
                    .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.author, weight: .medium))
                    .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                AssistantBubbleBody(line: line, context: context)
                MessageActionRow(line: line, context: context)
            }
            .padding(.horizontal, CoreHubTokens.Layout.bubblePaddingHorizontal)
            .padding(.vertical, CoreHubTokens.Layout.bubblePaddingVertical)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CoreHubTokens.Palette.msgAssistant, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous))
            .frame(maxWidth: context.assistantMaxWidth, alignment: .leading)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Thinking → tools → text (or streaming dots) → files, in the web order.
private struct AssistantBubbleBody: View {
    let line: ChatLine
    let context: MessageRowContext

    var body: some View {
        let parsed = ChatFiles.parse(line.displayText)
        if !line.reasoning.isEmpty || (line.isStreaming && line.thinkingStartedAt != nil && line.text.isEmpty) {
            ThinkingBlock(line: line)
        }
        if context.showToolCalls && !line.tools.isEmpty {
            ToolSummaryCard(tools: line.tools)
        }
        if !parsed.text.isEmpty {
            MarkdownText(text: parsed.text)
                .font(CoreHubTokens.Typography.messageFont)
                .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                .opacity(line.text.isEmpty && !line.interim.isEmpty ? 0.7 : 1)
        } else if line.isStreaming {
            StreamingDots()
        }
        MessageFiles(files: parsed.files, context: context)
    }
}

/// System notice: 3 pt inline-start warning border. Errors: error text on error @ 6 %.
struct SystemMessageRow: View {
    let line: ChatLine
    let isError: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if !isError { Rectangle().fill(CoreHubTokens.Palette.warning).frame(width: 3) }
            MarkdownText(text: line.text)
                .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.sidebarTab))
                .foregroundStyle(isError ? CoreHubTokens.Palette.error : CoreHubTokens.Palette.textSecondary)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isError ? CoreHubTokens.Palette.error.opacity(CoreHubTokens.Alpha.hover) : Color.clear, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.control))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(isError ? Text("Error") : Text("Notice"))
    }
}

/// Slash command the user sent (`/fork`, `/compress`…): monospace, end-aligned.
struct CommandMessageRow: View {
    let line: ChatLine
    let context: MessageRowContext

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 6) {
                TechnicalText(text: line.text, font: CoreHubTokens.Typography.mono(CoreHubTokens.Typography.code), color: CoreHubTokens.Palette.textPrimary)
                if let timestamp = line.timestamp {
                    Text(timestamp.chatTime).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
                }
            }
            .padding(.horizontal, CoreHubTokens.Layout.bubblePaddingHorizontal)
            .padding(.vertical, 8)
            .background(CoreHubTokens.Palette.codeBackground, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous))
            .frame(maxWidth: context.userMaxWidth, alignment: .trailing)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Three pulsing dots while the reply has no text yet.
struct StreamingDots: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(CoreHubTokens.Palette.textMuted)
                    .frame(width: 6, height: 6)
                    .opacity(phase == index ? 1 : 0.35)
            }
        }
        .frame(height: 16)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(320))
                withAnimation(.easeInOut(duration: 0.25)) { phase = (phase + 1) % 3 }
            }
        }
        .accessibilityLabel("Thinking")
    }
}

/// Chips for the files the user attached to a message.
struct AttachmentChips: View {
    let attachments: [ChatAttachmentRef]

    var body: some View {
        if !attachments.isEmpty {
            FlowLayout(spacing: 6) {
                ForEach(attachments, id: \.self) { item in
                    HStack(spacing: 5) {
                        Image(systemName: MediaKind.classify(path: item.path, mime: item.mime) == .image ? "photo" : "doc")
                            .font(.system(size: 11))
                        TechnicalText(text: item.name, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textSecondary)
                            .frame(maxWidth: 180)
                    }
                    .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(CoreHubTokens.Palette.hover, in: Capsule())
                }
            }
        }
    }
}

/// Media players and download cards for the files a message references.
struct MessageFiles: View {
    let files: [DownloadLink]
    let context: MessageRowContext

    var body: some View {
        ForEach(files) { link in
            MediaAttachmentView(link: link, api: context.api, profile: context.session.profile, roomID: context.roomID)
        }
    }
}

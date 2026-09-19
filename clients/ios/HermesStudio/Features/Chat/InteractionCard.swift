import SwiftUI

/// Approval or clarification request rendered inline in the stream.
struct InteractionCard: View {
    let line: ChatLine
    let context: MessageRowContext

    var body: some View {
        if let interaction = line.interaction {
            VStack(alignment: .leading, spacing: 10) {
                InteractionHeader(interaction: interaction)
                if !interaction.command.isEmpty && interaction.command != interaction.prompt {
                    TechnicalText(text: interaction.command, font: CoreHubTokens.Typography.mono(CoreHubTokens.Typography.code), color: CoreHubTokens.Palette.textPrimary)
                        .lineLimit(4)
                        .padding(8)
                        .background(CoreHubTokens.Palette.codeBackground, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button))
                }
                DirectionalText(text: interaction.prompt, font: CoreHubTokens.Typography.messageFont, color: CoreHubTokens.Palette.textPrimary, lineLimit: nil)
                if interaction.resolved {
                    InteractionResolved(interaction: interaction)
                } else if interaction.kind == .approval {
                    ApprovalChoices(interaction: interaction) { choice in context.onRespond(interaction, choice) }
                } else {
                    ClarificationAnswer(interaction: interaction) { answer in context.onRespond(interaction, answer) }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CoreHubTokens.Palette.bgCard, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous).stroke(interaction.resolved ? CoreHubTokens.Palette.borderLight : CoreHubTokens.Palette.warning.opacity(0.6)))
        }
    }
}

private struct InteractionHeader: View {
    let interaction: ChatInteraction

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: interaction.kind == .approval ? "hand.raised.fill" : "questionmark.circle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(CoreHubTokens.Palette.warning)
            Text(interaction.kind == .approval ? "Approval required" : "Clarification required")
                .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.author, weight: .semibold))
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
            Spacer()
            if !interaction.resolved && interaction.remainingSeconds > 0 {
                Text("\(interaction.remainingSeconds)s")
                    .font(CoreHubTokens.Typography.metaFont.monospacedDigit())
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
        }
    }
}

private struct InteractionResolved: View {
    let interaction: ChatInteraction

    private var text: String {
        if interaction.kind == .clarify { return String(localized: "Answered") }
        switch interaction.resolution {
        case "deny", "reject", "denied": return String(localized: "Rejected")
        case "": return String(localized: "Resolved")
        default: return String(localized: "Approved: \(ApprovalChoices.label(for: interaction.resolution))")
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "checkmark.circle").font(.system(size: 11))
            Text(text)
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.textMuted)
    }
}

struct ApprovalChoices: View {
    let interaction: ChatInteraction
    let respond: (String) -> Void

    static func label(for choice: String) -> String {
        switch choice {
        case "once": return String(localized: "Allow once")
        case "session": return String(localized: "Allow for this session")
        case "always": return String(localized: "Always allow")
        case "deny", "reject": return String(localized: "Reject")
        default: return choice
        }
    }

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(interaction.choices, id: \.self) { choice in
                Button { respond(choice) } label: {
                    Text(Self.label(for: choice))
                        .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.sidebarTab, weight: .medium))
                        .foregroundStyle(CoreHubTokens.Palette.textOnAccent)
                        .padding(.horizontal, 12)
                        .frame(height: 30)
                        .background(CoreHubTokens.Palette.accent, in: Capsule())
                }
                .buttonStyle(.plain)
            }
            Button { respond("deny") } label: {
                Text("Reject")
                    .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.sidebarTab, weight: .medium))
                    .foregroundStyle(CoreHubTokens.Palette.error)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .background(CoreHubTokens.Palette.error.opacity(CoreHubTokens.Alpha.selected), in: Capsule())
            }
            .buttonStyle(.plain)
        }
    }
}

struct ClarificationAnswer: View {
    let interaction: ChatInteraction
    let respond: (String) -> Void
    @State private var answer = ""

    private var trimmed: String { answer.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !interaction.responseMode.isEmpty {
                HStack(spacing: 4) {
                    Text("Response mode").foregroundStyle(CoreHubTokens.Palette.textMuted)
                    TechnicalText(text: interaction.responseMode, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textSecondary)
                }
                .font(CoreHubTokens.Typography.metaFont)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Type clarification", text: $answer, axis: .vertical)
                    .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.inputMinimum))
                    .lineLimit(1...5)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(CoreHubTokens.Palette.bgInput, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.control))
                    .overlay(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.control).stroke(CoreHubTokens.Palette.inputBorderIdle))
                    .contentDirection(of: answer)
                Button { respond(trimmed); answer = "" } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(CoreHubTokens.Palette.textOnAccent)
                        .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
                        .background(trimmed.isEmpty ? CoreHubTokens.Palette.accentMuted : CoreHubTokens.Palette.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(trimmed.isEmpty)
                .accessibilityLabel("Send")
            }
        }
        .onAppear { if answer.isEmpty { answer = interaction.initialResponse } }
    }
}

import SwiftUI

/// Queued runs: insert (run next), steer (interrupt the current turn), cancel.
struct QueuedRunsPanel: View {
    let items: [QueuedRun]
    let insertionID: String
    let onInsert: (QueuedRun) -> Void
    let onSteer: (QueuedRun) -> Void
    let onCancel: (QueuedRun) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { item in QueuedRunChip(item: item, inserting: insertionID == item.id, onInsert: onInsert, onSteer: onSteer, onCancel: onCancel) }
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 5)
    }
}

private struct QueuedRunChip: View {
    let item: QueuedRun
    let inserting: Bool
    let onInsert: (QueuedRun) -> Void
    let onSteer: (QueuedRun) -> Void
    let onCancel: (QueuedRun) -> Void

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: inserting ? "arrow.down.to.line.compact" : "clock")
            Text(item.text.nilIfEmpty ?? String(localized: "Queued message")).lineLimit(1).frame(maxWidth: 160)
            Button { onInsert(item) } label: { Image(systemName: "arrow.up.to.line.compact") }.accessibilityLabel("Run next")
            Button { onSteer(item) } label: { Image(systemName: "arrow.uturn.forward") }.accessibilityLabel("Steer now")
            Button { onCancel(item) } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Cancel queued message")
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        .padding(8)
        .background(CoreHubTokens.Palette.bgSecondary, in: Capsule())
    }
}

/// The stored session id is not on the server any more (deleted there, or
/// an id from an older install). One neutral notice instead of a red row per
/// failed attempt; the next message starts a new conversation.
struct MissingSessionNotice: View {
    var body: some View {
        VStack(spacing: 8) {
            CoreHubIconView(icon: .newChat, size: 22)
            Text("This conversation is no longer on the server.")
                .font(CoreHubTokens.Typography.bodyFont)
                .foregroundStyle(CoreHubTokens.Palette.textPrimary)
            Text("Send a message to start a new one.")
                .font(CoreHubTokens.Typography.metaFont)
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
    }
}

/// "Compressing context…" while the summariser runs, then "Context compressed".
struct CompressionBanner: View {
    let compression: ChatStreamState.Compression

    var body: some View {
        HStack(spacing: 8) {
            if compression.phase == "started" { ProgressView().controlSize(.mini) } else { Image(systemName: "checkmark.circle").font(.system(size: 11)) }
            Text(compression.phase == "started" ? "Compressing context…" : "Context compressed")
            if compression.messageCount > 0 || compression.tokenCount > 0 {
                Text(verbatim: "· ")
                Text("\(compression.messageCount) messages · \(ContextUsageFormat.tokens(compression.tokenCount)) tokens")
            }
            Spacer()
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(CoreHubTokens.Palette.bgSecondary)
    }
}

/// abort.started / abort.timeout.
struct AbortBanner: View {
    let phase: String

    var body: some View {
        HStack(spacing: 8) {
            if phase == "timeout" { Image(systemName: "exclamationmark.triangle").font(.system(size: 11)) } else { ProgressView().controlSize(.mini) }
            Text(phase == "timeout" ? "Stopping is taking longer than expected…" : "Stopping…")
            Spacer()
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(phase == "timeout" ? CoreHubTokens.Palette.warning : CoreHubTokens.Palette.textSecondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(CoreHubTokens.Palette.bgSecondary)
    }
}

/// Shown after the first successful connection drops.
struct ConnectionBanner: View {
    let error: String?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.mini)
            Text("Reconnecting to Core Hub…")
            if let error, !error.isEmpty { Text(verbatim: "· ") + Text(error) }
            Spacer()
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.warning)
        .lineLimit(1)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(CoreHubTokens.Palette.warning.opacity(CoreHubTokens.Alpha.hover))
    }
}

struct WorkspaceChangesRow: View {
    let changes: [String]
    let workspace: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 11))
            Text("\(changes.count) workspace changes")
            if let last = changes.last { Text(verbatim: "· "); TechnicalText(text: last, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textMuted) }
            Spacer()
            if !workspace.isEmpty { TechnicalText(text: WorkspaceChip.label(for: workspace)) }
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
    }
}

/// The occasional reminder that a long press on the microphone changes the
/// dictation language, shown above the composer the moment recording starts.
///
/// Transient by construction and never modal: it steals no focus, blocks
/// nothing, sits on the composer's own pill styling (11 pt meta, radius 999,
/// `bgCard` over a light border, card shadow), fades in and out with the
/// 250 ms motion token and takes itself away after a few seconds. Tapping it
/// is a shortcut to the same picker as the long press. How *often* it appears
/// is `DictationHintPolicy`, not this view.
struct DictationLanguageHint: View {
    /// Open the dictation-language picker (same destination as the gesture).
    let onTap: () -> Void
    /// Called when the hint has been on screen long enough.
    let onExpire: () -> Void

    /// Long enough to read one short line, short enough not to sit over a
    /// recording the owner is watching.
    private static let visibleSeconds: Double = 5

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                Image(systemName: "character.bubble")
                    .font(.system(size: 11, weight: .medium))
                Text("Touch and hold the microphone to change the dictation language")
                    .font(CoreHubTokens.Typography.metaFont)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .foregroundStyle(CoreHubTokens.Palette.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(CoreHubTokens.Palette.bgCard, in: Capsule())
            .overlay(Capsule().stroke(CoreHubTokens.Palette.borderLight))
            .coreHubShadow(CoreHubTokens.Shadow.card)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .padding(.bottom, 2)
        .accessibilityHint("Opens the dictation language picker")
        .task {
            try? await Task.sleep(for: .seconds(Self.visibleSeconds))
            guard !Task.isCancelled else { return }
            onExpire()
        }
    }
}

import SwiftUI

/// Live per-agent activity (`room_agent_activity`): avatar, seat name, what
/// it is doing and an interrupt button.
struct RoomActivityStrip: View {
    let activities: [GroupAgentActivity]
    let agents: [RoomAgent]
    let onInterrupt: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(activities) { activity in row(activity) }
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 38)
    }

    private func asset(for activity: GroupAgentActivity) -> AgentAvatarAsset {
        if let seat = agents.first(where: { $0.agentID == activity.agentID || $0.id == activity.agentID }) { return seat.avatarAsset }
        return AgentAvatarAsset.resolve(runtime: activity.agent, source: activity.agent == "hermes" ? "cli" : "coding_agent")
    }

    private func row(_ activity: GroupAgentActivity) -> some View {
        HStack(spacing: 6) {
            AgentAvatarView(asset: asset(for: activity), size: 18, streaming: true)
            Text(activity.agentName.nilIfEmpty ?? activity.agent).font(CoreHubTokens.Typography.metaFont).lineLimit(1)
            Text(GroupActivityLabel.text(for: activity.status)).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted).lineLimit(1)
            Button { onInterrupt(activity.agentName) } label: {
                Image(systemName: "stop.circle").font(.system(size: 13))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Interrupt agent")
        }
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        .padding(.horizontal, 9)
        .frame(height: 26)
        .background(CoreHubTokens.Palette.hover, in: Capsule())
    }
}

/// "Someone is typing…" under the transcript.
struct RoomTypingRow: View {
    let names: [String]

    var body: some View {
        HStack(spacing: 6) {
            StreamingDots()
            Text(names.joined(separator: "، ")).font(CoreHubTokens.Typography.metaFont).lineLimit(1)
            Text("is typing…").font(CoreHubTokens.Typography.metaFont)
            Spacer(minLength: 0)
        }
        .foregroundStyle(CoreHubTokens.Palette.textMuted)
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
    }
}

/// Execution queue (`execution_queue_updated`): who is waiting for which
/// agent, with cancel.
struct RoomQueuePanel: View {
    let items: [GroupQueueItem]
    let onCancel: (GroupQueueItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Execution queue")
                .font(CoreHubTokens.Typography.groupHeaderFont)
                .tracking(CoreHubTokens.Typography.groupHeaderTracking)
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
            ForEach(items) { item in row(item) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CoreHubTokens.Palette.bgSecondary)
    }

    private func row(_ item: GroupQueueItem) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: "\(max(1, item.position)).").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
            DirectionalText(text: item.targetAgentName.nilIfEmpty ?? item.targetAgentID, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textPrimary)
            DirectionalText(text: item.textSummary, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textMuted)
            Spacer(minLength: 0)
            StatusPill(text: item.status == "running" ? String(localized: "Running") : String(localized: "Queued"), color: item.status == "running" ? CoreHubTokens.Palette.info : CoreHubTokens.Palette.textMuted)
            Button { onCancel(item) } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 13)).foregroundStyle(CoreHubTokens.Palette.textMuted) }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel queued message")
        }
    }
}

/// Handoff chains that stopped at their depth limit; each can be continued
/// once (`POST /rooms/{id}/handoffs/{chainId}/continue`).
struct RoomHandoffPanel: View {
    let chains: [HandoffChain]
    let onContinue: (HandoffChain) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(chains) { chain in row(chain) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CoreHubTokens.Palette.warning.opacity(CoreHubTokens.Alpha.hover))
    }

    private func row(_ chain: HandoffChain) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 12)).foregroundStyle(CoreHubTokens.Palette.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text("Agent handoff stopped").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textPrimary)
                Text("Depth \(chain.currentDepth) of \(chain.maxDepth ?? chain.currentDepth)")
                    .font(CoreHubTokens.Typography.metaFont)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            Spacer(minLength: 0)
            Button { onContinue(chain) } label: { Text("Continue") }
                .buttonStyle(CoreHubPillButtonStyle())
        }
    }
}

/// A message from another person in the room: start-aligned with an initials
/// avatar and the member name above the bubble.
struct RoomMemberMessageRow: View {
    let line: ChatLine
    let memberName: String
    let context: MessageRowContext

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ProfileAvatar(name: memberName, size: CoreHubTokens.Layout.assistantAvatar)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 8) {
                DirectionalText(text: memberName, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.author, weight: .medium), color: CoreHubTokens.Palette.textSecondary)
                AttachmentChips(attachments: line.attachments)
                if !line.text.isEmpty {
                    MarkdownText(text: line.text)
                        .font(CoreHubTokens.Typography.messageFont)
                        .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                }
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

/// One rendered room line: other people start-aligned with their name, my
/// messages and every agent run through the shared M3 row.
struct RoomLineRow: View {
    let item: GroupLine
    let context: MessageRowContext

    var body: some View {
        if let memberName = item.memberName, item.line.kind == .user {
            RoomMemberMessageRow(line: item.line, memberName: memberName, context: context)
        } else {
            MessageRow(line: item.line, context: context)
        }
    }
}

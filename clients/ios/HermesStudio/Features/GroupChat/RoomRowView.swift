import SwiftUI

/// Overlapping agent avatars of a room (at most three, then "+N"), like the
/// web room card.
struct RoomAgentAvatars: View {
    let agents: [RoomAgent]
    var size: CGFloat = CoreHubTokens.Layout.sessionAvatar

    private var shown: [RoomAgent] { Array(agents.prefix(3)) }
    private var overflow: Int { max(0, agents.count - shown.count) }

    var body: some View {
        HStack(spacing: -size / 3) {
            if shown.isEmpty {
                CoreHubIconView(icon: .group, size: size)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            ForEach(shown) { agent in
                AgentAvatarView(asset: agent.avatarAsset, size: size)
            }
            if overflow > 0 {
                Text(verbatim: "+\(overflow)")
                    .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.groupHeader, weight: .semibold))
                    .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                    .frame(width: size, height: size)
                    .background(CoreHubTokens.Palette.bgSecondary, in: Circle())
                    .overlay(Circle().stroke(Color.white, lineWidth: 1))
            }
        }
        .accessibilityLabel(Text("\(agents.count) agents"))
    }
}

/// One room row: avatars, name (per-string direction), last-active time,
/// agent and member counts.
struct RoomRowView: View {
    let room: Room
    var selected = false
    var time = ""

    var body: some View {
        HStack(spacing: 10) {
            RoomAgentAvatars(agents: room.agents)
            VStack(alignment: .leading, spacing: 3) {
                titleLine
                metaLine
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, CoreHubTokens.Layout.sessionRowHorizontal)
        .padding(.vertical, CoreHubTokens.Layout.sessionRowVertical)
        .background(selected ? CoreHubTokens.Palette.selected : Color.clear, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous))
        .contentShape(Rectangle())
    }

    private var titleLine: some View {
        HStack(spacing: 6) {
            DirectionalText(text: room.name, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.sessionTitle, weight: selected ? .medium : .regular))
            if !time.isEmpty {
                Text(time).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
        }
    }

    private var metaLine: some View {
        HStack(spacing: 8) {
            Text("\(room.agentCount) agents")
            Text("\(room.memberCount) members")
            Spacer(minLength: 0)
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.textMuted)
        .lineLimit(1)
    }
}

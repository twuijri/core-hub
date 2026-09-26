// A turn's tools, as on the web and Android (owner, 2026-09-26; `ToolActivity`): while the agent
// works, the latest two steps — a running or failed one stays too — with the earlier ones one
// "+k earlier steps" line away, a new step sliding in and an old one fading out; once the turn
// has ended, one row — how many steps, how long, how many failed, the latest tools — that opens
// to every card. What is open is per message and never saved. Reduce Motion: no slide, no fade.
import CoreHubClient
import SwiftUI

struct ToolActivityView: View {
    let calls: [ToolCall]
    let live: Bool
    @Environment(\.l10n) private var l10n
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var earlier = false
    @State private var open = false

    var body: some View {
        let activity = ToolActivity.of(calls, live: live)
        let shown = activity.folded ? (open ? calls : []) : (earlier ? calls : activity.visible)
        VStack(alignment: .leading, spacing: Space.s2) {
            if activity.folded {
                foldedRow(activity.summary)
            } else if activity.hidden > 0 {
                earlierLine(activity.hidden)
            }
            ForEach(shown, id: \.id) { call in
                ToolCallCard(call: call)
                    .transition(stepTransition)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: Motion.normal), value: shown.map(\.id))
    }

    private var stepTransition: AnyTransition {
        reduceMotion
            ? .identity
            : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity)
    }

    private func earlierLine(_ count: Int) -> some View {
        Button {
            earlier.toggle()
        } label: {
            HStack(spacing: Space.s2) {
                LucideIcon(.chevronDown, size: 14)
                    .foregroundStyle(Tone.textFaint)
                    .rotationEffect(.degrees(earlier ? 180 : 0))
                Text(earlier ? l10n("tool.activity.hide_earlier") : l10n.plural("tool.activity.earlier", count))
                    .font(.system(size: FontSize.sizeXs))
                    .foregroundStyle(Tone.textMuted)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tool.activity.earlier")
    }

    /// «6 steps · 1m 05s · 1 failed · web_search terminal ⌄».
    private func foldedRow(_ summary: ToolActivitySummary) -> some View {
        Button {
            open.toggle()
        } label: {
            HStack(spacing: Space.s2) {
                LucideIcon(.wrench, size: 14)
                    .foregroundStyle(Tone.textMuted)
                Text(l10n.plural("tool.activity.steps", summary.count))
                    .font(.system(size: FontSize.sizeSm, weight: .semibold))
                    .foregroundStyle(Tone.text)
                    .lineLimit(1)
                    .fixedSize()
                if let ms = summary.durationMs {
                    Text(duration(ms))
                        .font(.system(size: FontSize.sizeXs))
                        .foregroundStyle(Tone.textFaint)
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                }
                if summary.failed > 0 {
                    Text(l10n.plural("tool.activity.failed", summary.failed))
                        .font(.system(size: FontSize.sizeXs, weight: .medium))
                        .foregroundStyle(Tone.dangerSoftText)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, Space.s2)
                        .padding(.vertical, 1)
                        .background(Tone.dangerSoft, in: Capsule())
                        .accessibilityIdentifier("tool.activity.failed")
                }
                // The tools' names are code: left to right whatever the language; each ends in
                // «…» rather than pushing the row wider than the bubble.
                HStack(spacing: Space.s1) {
                    ForEach(summary.names, id: \.self) { name in
                        Text(name)
                            .font(.system(size: FontSize.sizeXs, design: .monospaced))
                            .foregroundStyle(Tone.textMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .padding(.horizontal, Space.s1)
                            .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                    }
                }
                .environment(\.layoutDirection, .leftToRight)
                Spacer(minLength: 0)
                LucideIcon(.chevronDown, size: 14)
                    .foregroundStyle(Tone.textFaint)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .padding(Space.s2)
            .background(Tone.surface2, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(foldedLabel(summary))
        .accessibilityHint(l10n(open ? "tool.activity.hide" : "tool.activity.show"))
        .accessibilityIdentifier("tool.activity.folded")
    }

    private func duration(_ ms: Int) -> String {
        let parts = ToolActivity.durationParts(ms)
        return parts.minutes > 0
            ? l10n("tool.activity.minutes", ["minutes": String(parts.minutes), "seconds": String(format: "%02d", parts.seconds)])
            : l10n("tool.activity.seconds", ["seconds": String(parts.seconds)])
    }

    private func foldedLabel(_ summary: ToolActivitySummary) -> String {
        var parts = [l10n.plural("tool.activity.steps", summary.count)]
        if let ms = summary.durationMs { parts.append(duration(ms)) }
        if summary.failed > 0 { parts.append(l10n.plural("tool.activity.failed", summary.failed)) }
        return parts.joined(separator: ", ")
    }
}

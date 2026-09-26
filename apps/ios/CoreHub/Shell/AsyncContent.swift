// Every page that reads from the hub goes through one loader: skeleton rows while it loads, the
// hub's own sentence with a retry when it fails (a 501 says which operation is missing), and
// the content otherwise. No page is ever silently empty (TEAM-RULES §٤).
import CoreHubClient
import SwiftUI

struct AsyncContent<Value, Content: View>: View {
    /// Changing it loads again (the profile, a filter).
    let key: String
    let load: () async throws -> Value
    @ViewBuilder let content: (Value, _ reload: @escaping () -> Void) -> Content
    @Environment(\.l10n) private var l10n
    @State private var phase: Phase = .loading
    @State private var generation = 0

    enum Phase {
        case loading
        case loaded(Value)
        case failed(String)
    }

    /// What the cross-fade between loading, failed and loaded watches.
    private var phaseKey: Int {
        switch phase {
        case .loading: return 0
        case .loaded: return 1
        case .failed: return 2
        }
    }

    init(key: String = "", load: @escaping () async throws -> Value, @ViewBuilder content: @escaping (Value, _ reload: @escaping () -> Void) -> Content) {
        self.key = key
        self.load = load
        self.content = content
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                SkeletonList()
                    .accessibilityLabel(l10n("common.loading"))
                    .transition(.opacity)
            case .failed(let message):
                // The hub's own sentence, under a plain title, with the one thing to do.
                EmptyStateView(
                    icon: .triangleAlert,
                    title: l10n("common.error_title"),
                    message: message,
                    actionTitle: l10n("common.retry"),
                    action: { generation += 1 }
                )
                .padding(.top, Space.s8)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            case .loaded(let value):
                content(value) { generation += 1 }
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: Motion.normal), value: phaseKey)
        .task(id: "\(key)#\(generation)") {
            do {
                let value = try await load()
                phase = .loaded(value)
            } catch is CancellationError {
                // A newer load replaced this one.
            } catch {
                phase = .failed(HubFailure(error).describe(l10n))
            }
        }
    }
}

/// A key and its value on one row; the value keeps its own direction.
struct FactRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
            Text(label).foregroundStyle(Tone.textMuted)
            Spacer(minLength: Space.s2)
            Text(value)
                .foregroundStyle(Tone.text)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .font(.system(size: FontSize.sizeSm))
    }
}

/// A status word in a soft pill.
struct StatusPill: View {
    enum Kind { case good, warn, bad, neutral }
    let text: String
    var kind: Kind = .neutral

    var body: some View {
        Text(text)
            .font(.system(size: FontSize.sizeXs, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, Space.s2)
            .padding(.vertical, 2)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch kind {
        case .good: return Tone.successSoftText
        case .warn: return Tone.warningSoftText
        case .bad: return Tone.dangerSoftText
        case .neutral: return Tone.textMuted
        }
    }

    private var background: Color {
        switch kind {
        case .good: return Tone.successSoft
        case .warn: return Tone.warningSoft
        case .bad: return Tone.dangerSoft
        case .neutral: return Tone.surface2
        }
    }
}

/// Any JSON the hub reports (audit reports, settings values), as an outline a person can read.
struct JSONOutline: View {
    let label: String?
    let value: JSONValue

    var body: some View {
        switch value {
        case .dictionary(let object):
            DisclosureGroup {
                ForEach(object.keys.sorted(), id: \.self) { key in
                    JSONOutline(label: key, value: object[key] ?? .null)
                }
            } label: {
                row(summary: "{\(object.count)}")
            }
        case .array(let items):
            DisclosureGroup {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    JSONOutline(label: "\(index + 1)", value: item)
                }
            } label: {
                row(summary: "[\(items.count)]")
            }
        default:
            row(summary: JSONText.scalar(value))
        }
    }

    private func row(summary: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            if let label { Text(label).foregroundStyle(Tone.textMuted) }
            Spacer(minLength: Space.s2)
            Text(summary)
                .foregroundStyle(Tone.text)
                .lineLimit(3)
                .textSelection(.enabled)
        }
        .font(.system(size: FontSize.sizeSm))
    }
}

enum JSONText {
    static func scalar(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .int(let i): return String(i)
        case .double(let d): return d.rounded() == d ? String(Int(d)) : String(format: "%.4g", d)
        case .bool(let b): return b ? "✓" : "✗"
        case .null: return "—"
        case .array(let items): return items.map(scalar).joined(separator: ", ")
        case .dictionary(let object): return "{\(object.count)}"
        }
    }
}

extension Date {
    /// Short date and time in the app's language.
    func shortText(_ language: AppLanguage) -> String {
        let formatter = DateFormatter()
        formatter.locale = language.locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: self)
    }
}

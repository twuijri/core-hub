// Small pieces every screen shares, painted by the tokens only.
import SwiftUI

struct NoticeView: View {
    enum Kind { case info, warning, danger, success }

    let text: String
    var tone: Kind = .info

    var body: some View {
        HStack(alignment: .top, spacing: Space.s2) {
            LucideIcon(icon, size: 16)
                .padding(.top, 1)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
                .contentDirection(of: text)
        }
        .font(.system(size: FontSize.sizeSm))
        .foregroundStyle(foreground)
        .padding(Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
    }

    private var icon: Lucide {
        switch tone {
        case .info: return .info
        case .warning: return .triangleAlert
        case .danger: return .octagonX
        case .success: return .circleCheck
        }
    }

    private var foreground: Color {
        switch tone {
        case .info: return Tone.infoSoftText
        case .warning: return Tone.warningSoftText
        case .danger: return Tone.dangerSoftText
        case .success: return Tone.successSoftText
        }
    }

    private var background: Color {
        switch tone {
        case .info: return Tone.infoSoft
        case .warning: return Tone.warningSoft
        case .danger: return Tone.dangerSoft
        case .success: return Tone.successSoft
        }
    }
}

/// The product's mark, as on the web: the Core Hub mark in the accent (the asset catalog's
/// `BrandMark`, a template made by scripts/icons/build-icons.mjs from the one source).
struct BrandMark: View {
    var size: CGFloat = 28

    var body: some View {
        Image("BrandMark")
            .renderingMode(.template)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
            .foregroundStyle(Tone.accent)
            .accessibilityHidden(true)
    }
}

/// The footer's language chip: the UI language; content keeps its own direction.
struct LanguageMenu: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        Menu {
            ForEach(AppLanguage.allCases) { language in
                Button {
                    app.language = language
                } label: {
                    if language == app.language {
                        Label { Text(l10n("shell.language_\(language.rawValue)")) } icon: { Image(lucide: .check) }
                    } else {
                        Text(l10n("shell.language_\(language.rawValue)"))
                    }
                }
            }
        } label: {
            LucideLabel(l10n("shell.language_\(app.language.rawValue)"), icon: .globe, size: 16)
                .labelStyle(.titleAndIcon)
                .font(.system(size: FontSize.sizeSm))
        }
        .accessibilityLabel(l10n("shell.language"))
    }
}

/// The footer's theme chip: three symbols, each with its name for VoiceOver (NAVIGATION.md §١).
struct ThemeChips: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        HStack(spacing: Control.gap) {
            ForEach(ThemeChoice.allCases) { choice in
                Button {
                    app.theme = choice
                } label: {
                    LucideIcon(choice.icon, size: 16)
                        .frame(width: Control.heightSm, height: Control.heightSm)
                        .foregroundStyle(app.theme == choice ? Tone.text : Tone.textMuted)
                        .background {
                            if app.theme == choice {
                                RoundedRectangle(cornerRadius: Control.itemRadius, style: .continuous)
                                    .fill(Tone.surface)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(l10n(choice.labelKey))
                .accessibilityAddTraits(app.theme == choice ? .isSelected : [])
            }
        }
        .padding(Control.trackPad)
        .background(Tone.surface2, in: RoundedRectangle(cornerRadius: Control.trackRadius, style: .continuous))
    }
}

/// The connection dot: what the realtime socket is doing, in words for VoiceOver.
struct ConnectionDot: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityElement()
            .accessibilityLabel(label)
    }

    private var color: Color {
        switch app.connection {
        case .connected: return Tone.statusRunning
        case .connecting: return Tone.warningSoftText
        case .offline: return Tone.statusBlocked
        }
    }

    private var label: String {
        switch app.connection {
        case .connected: return l10n("shell.connected")
        case .connecting: return l10n("shell.connecting")
        case .offline: return l10n("shell.offline")
        }
    }
}

/// A destination this part of the phone app does not build yet: its real title, and a
/// sentence that says so — never an empty page (TEAM-RULES §٤).
struct PlaceholderScreen: View {
    let destination: DestinationID
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(spacing: Space.s3) {
            LucideIcon(.hammer, size: 32)
                .foregroundStyle(Tone.textFaint)
            Text(l10n("placeholder.title"))
                .font(.system(size: FontSize.sizeLg, weight: .semibold))
                .foregroundStyle(Tone.text)
            Text(l10n("placeholder.body"))
                .multilineTextAlignment(.center)
                .foregroundStyle(Tone.textMuted)
        }
        .padding(Space.s6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tone.bg)
        .navigationTitle(l10n(destination.titleKey))
        .accessibilityIdentifier("screen.\(destination.rawValue)")
    }
}

/// A state as a coloured dot, with its words for VoiceOver: what a phone shows where a wide
/// screen has room for the word (docs/design/family.md, "Phone adaptations").
struct StatusDot: View {
    enum Kind { case good, warn, bad, neutral }
    let kind: Kind
    let label: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .overlay(Circle().strokeBorder(Tone.surface, lineWidth: 1))
            .accessibilityElement()
            .accessibilityLabel(label)
    }

    private var color: Color {
        switch kind {
        case .good: return Tone.statusRunning
        case .warn: return Tone.warningSoftText
        case .bad: return Tone.statusBlocked
        case .neutral: return Tone.textFaint
        }
    }
}

/// The family's chip: a capsule with a hairline, the height of a small control; `quiet` drops
/// the fill for a secondary action beside real chips. Pressing dims it like every button.
struct ChipButtonStyle: ButtonStyle {
    var quiet = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: FontSize.sizeSm, weight: .medium))
            .foregroundStyle(quiet ? Tone.textMuted : Tone.text)
            .lineLimit(1)
            .padding(.horizontal, Space.s3)
            .frame(minHeight: Control.heightSm + 4)
            .background(quiet ? Color.clear : Tone.surface2, in: Capsule())
            .overlay(Capsule().strokeBorder(Tone.border, lineWidth: quiet ? 1 : 0))
            .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.45)
            .contentShape(Capsule())
            .hitSlop(6)
            .animation(.easeOut(duration: Motion.fast), value: configuration.isPressed)
    }
}

/// An empty list or page: an icon in a soft circle, one line that says what is missing, an
/// optional sentence on what to do, and at most one action — never a bare "Nothing here".
struct EmptyStateView: View {
    let icon: Lucide
    let title: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: Space.s3) {
            LucideIcon(icon, size: 22)
                .foregroundStyle(Tone.accentSoftText)
                .frame(width: 48, height: 48)
                .background(Tone.accentSoft, in: Circle())
            Text(title)
                .font(.system(size: FontSize.sizeMd, weight: .semibold))
                .foregroundStyle(Tone.text)
                .multilineTextAlignment(.center)
            if let message {
                Text(message)
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(Tone.accent)
                    .padding(.top, Space.s1)
            }
        }
        .padding(Space.s6)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// While a page loads: grey bars in the shape of the rows to come, breathing gently (still when
/// the person asked for reduced motion) — a page never flashes a lone spinner.
struct SkeletonList: View {
    var rows = 6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s4) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: Space.s3) {
                    Circle().fill(Tone.surface2).frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: Space.s2) {
                        RoundedRectangle(cornerRadius: Radius.sm, style: .continuous)
                            .fill(Tone.surface2)
                            .frame(width: index.isMultiple(of: 2) ? 180 : 140, height: 12)
                        RoundedRectangle(cornerRadius: Radius.sm, style: .continuous)
                            .fill(Tone.surface2)
                            .frame(maxWidth: index.isMultiple(of: 3) ? 220 : .infinity)
                            .frame(height: 10)
                    }
                }
            }
        }
        .padding(Space.s4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .opacity(dim ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement()
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// `EmptyStateView` as the one row of an empty list: the page's own icon and "Nothing here
/// yet", without the list's card behind it.
struct EmptyRow: View {
    let icon: Lucide
    var message: String?
    @Environment(\.l10n) private var l10n

    var body: some View {
        EmptyStateView(icon: icon, title: l10n("common.empty"), message: message)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}

/// A row's tick while choosing several: an empty ring, or the accent disc with a check.
struct SelectionMark: View {
    let chosen: Bool

    var body: some View {
        ZStack {
            if chosen {
                Circle().fill(Tone.accent)
                LucideIcon(.check, size: 13).foregroundStyle(Tone.accentText)
            } else {
                Circle().strokeBorder(Tone.borderStrong, lineWidth: 1.5)
            }
        }
        .frame(width: 22, height: 22)
        .animation(.easeOut(duration: Motion.fast), value: chosen)
    }
}

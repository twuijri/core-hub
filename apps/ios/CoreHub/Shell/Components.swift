// Small pieces every screen shares, painted by the tokens only.
import SwiftUI

struct NoticeView: View {
    enum Kind { case info, warning, danger, success }

    let text: String
    var tone: Kind = .info

    var body: some View {
        HStack(alignment: .top, spacing: Space.s2) {
            Image(systemName: symbol)
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

    private var symbol: String {
        switch tone {
        case .info: return "info.circle"
        case .warning: return "exclamationmark.triangle"
        case .danger: return "xmark.octagon"
        case .success: return "checkmark.circle"
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
                        Label(l10n("shell.language_\(language.rawValue)"), systemImage: "checkmark")
                    } else {
                        Text(l10n("shell.language_\(language.rawValue)"))
                    }
                }
            }
        } label: {
            Label(l10n("shell.language_\(app.language.rawValue)"), systemImage: "globe")
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
                    Image(systemName: choice.symbol)
                        .font(.system(size: FontSize.sizeSm))
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
            Image(systemName: "hammer")
                .font(.system(size: 32))
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

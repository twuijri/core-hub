// The SwiftUI side of the design tokens (docs/clients/DESIGN.md). Every colour is a role from
// `Palette` (generated from tokens.json) that follows the light or dark appearance by itself.
import SwiftUI
import UIKit

extension RGBA {
    var uiColor: UIColor { UIColor(red: red, green: green, blue: blue, alpha: alpha) }
}

extension Color {
    /// A colour role that resolves against the current appearance (light or dark tokens).
    static func token(_ role: KeyPath<Palette, RGBA>) -> Color {
        Color(uiColor: UIColor { traits in
            let palette = traits.userInterfaceStyle == .dark ? Palette.dark : Palette.light
            return palette[keyPath: role].uiColor
        })
    }
}

/// The colour roles the screens use, by name.
enum Tone {
    static let bg = Color.token(\.bg)
    static let bgRaised = Color.token(\.bgRaised)
    static let surface = Color.token(\.surface)
    static let surface2 = Color.token(\.surface2)
    static let surface3 = Color.token(\.surface3)
    static let text = Color.token(\.text)
    static let textMuted = Color.token(\.textMuted)
    static let textFaint = Color.token(\.textFaint)
    static let border = Color.token(\.border)
    static let borderStrong = Color.token(\.borderStrong)
    static let accent = Color.token(\.accent)
    static let accentStrong = Color.token(\.accentStrong)
    static let accentText = Color.token(\.accentText)
    static let accentSoft = Color.token(\.accentSoft)
    static let accentSoftText = Color.token(\.accentSoftText)
    static let danger = Color.token(\.danger)
    static let dangerText = Color.token(\.dangerText)
    static let dangerSoft = Color.token(\.dangerSoft)
    static let dangerSoftText = Color.token(\.dangerSoftText)
    static let warningSoft = Color.token(\.warningSoft)
    static let warningSoftText = Color.token(\.warningSoftText)
    static let successSoft = Color.token(\.successSoft)
    static let successSoftText = Color.token(\.successSoftText)
    static let infoSoft = Color.token(\.infoSoft)
    static let infoSoftText = Color.token(\.infoSoftText)
    static let statusRunning = Color.token(\.statusRunning)
    static let statusBlocked = Color.token(\.statusBlocked)
    static let link = Color.token(\.link)
    static let userBubble = Color.token(\.userBubble)
    static let userBubbleText = Color.token(\.userBubbleText)
    static let userBubbleBorder = Color.token(\.userBubbleBorder)
    static let agentBubble = Color.token(\.agentBubble)
    static let agentBubbleText = Color.token(\.agentBubbleText)
    static let agentBubbleBorder = Color.token(\.agentBubbleBorder)
    static let thinking = Color.token(\.thinking)
    static let thinkingTrack = Color.token(\.thinkingTrack)
    static let codeBg = Color.token(\.codeBg)
    static let codeText = Color.token(\.codeText)
    static let scrim = Color.token(\.scrim)
}

/// The theme a person picked (footer chip and the Theme tool): the system's, or fixed.
enum ThemeChoice: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var symbol: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon"
        }
    }

    var labelKey: String { "shell.theme_\(rawValue)" }
}

extension View {
    /// Glass on floating chrome only (DESIGN.md): translucent material that becomes solid when
    /// the person asked for reduced transparency.
    func floatingChrome(cornerRadius: CGFloat = Radius.lg) -> some View {
        modifier(FloatingChrome(cornerRadius: cornerRadius))
    }
}

private struct FloatingChrome: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                if reduceTransparency {
                    shape.fill(Tone.surface)
                } else {
                    shape.fill(.regularMaterial)
                }
            }
            .overlay(shape.strokeBorder(Tone.border, lineWidth: 1))
    }
}

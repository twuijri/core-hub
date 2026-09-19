import SwiftUI
import UIKit

/// Single source of the Core Hub design system on iOS.
/// Values come from `docs/mobile/DESIGN-SPEC.md` (extracted from the web
/// client's `variables.scss` / `theme.ts`). Never scatter raw colours, sizes
/// or radii in views; add a token here instead.
enum CoreHubTokens {
    // MARK: Palette ("Pure Ink", greyscale)

    /// Raw hex values so tests can assert the exact spec without rendering.
    struct PaletteHex: Equatable {
        let bgPrimary: UInt32
        let bgSecondary: UInt32
        let bgSidebar: UInt32
        let bgCard: UInt32
        let bgCardHover: UInt32
        let bgInput: UInt32
        /// The composer card background (web: input in light, #333333 in dark).
        let bgComposer: UInt32
        let border: UInt32
        let borderLight: UInt32
        let accent: UInt32
        let accentHover: UInt32
        let accentMuted: UInt32
        let textPrimary: UInt32
        let textSecondary: UInt32
        let textMuted: UInt32
        let textOnAccent: UInt32
        let success: UInt32
        let error: UInt32
        let warning: UInt32
        let info: UInt32
        let msgUser: UInt32
        let msgAssistant: UInt32
        let codeBackground: UInt32
        /// Splash / theme colour (also the app icon background).
        let splash: UInt32
        /// Context indicator above 80 %.
        let contextWarning: UInt32

        static let light = PaletteHex(
            bgPrimary: 0xFAFAFA, bgSecondary: 0xF0F0F0, bgSidebar: 0xF5F5F5, bgCard: 0xFFFFFF, bgCardHover: 0xFAFAFA,
            bgInput: 0xFFFFFF, bgComposer: 0xFFFFFF, border: 0xE0E0E0, borderLight: 0xEBEBEB,
            accent: 0x333333, accentHover: 0x1A1A1A, accentMuted: 0x888888,
            textPrimary: 0x1A1A1A, textSecondary: 0x666666, textMuted: 0x999999, textOnAccent: 0xFFFFFF,
            success: 0x2E7D32, error: 0xC62828, warning: 0xF57F17, info: 0x4A90D9,
            msgUser: 0xF5F5F5, msgAssistant: 0xF5F5F5, codeBackground: 0xF4F4F4, splash: 0xF7F7F4, contextWarning: 0xE8A735
        )

        static let dark = PaletteHex(
            bgPrimary: 0x1A1A1A, bgSecondary: 0x252525, bgSidebar: 0x202020, bgCard: 0x2A2A2A, bgCardHover: 0x333333,
            bgInput: 0x2A2A2A, bgComposer: 0x333333, border: 0x3A3A3A, borderLight: 0x333333,
            accent: 0xE0E0E0, accentHover: 0xF5F5F5, accentMuted: 0x888888,
            textPrimary: 0xE0E0E0, textSecondary: 0xA0A0A0, textMuted: 0x888888, textOnAccent: 0x1A1A1A,
            success: 0x66BB6A, error: 0xEF5350, warning: 0xFFB74D, info: 0x6BA3D6,
            msgUser: 0x292929, msgAssistant: 0x292929, codeBackground: 0x1E1E1E, splash: 0x1A1A1A, contextWarning: 0xE8A735
        )
    }

    /// Dynamic colours that follow the effective colour scheme (system, or
    /// the user's light/dark preference applied through `preferredColorScheme`).
    enum Palette {
        static let bgPrimary = dynamic(\.bgPrimary)
        static let bgSecondary = dynamic(\.bgSecondary)
        static let bgSidebar = dynamic(\.bgSidebar)
        static let bgCard = dynamic(\.bgCard)
        static let bgCardHover = dynamic(\.bgCardHover)
        static let bgInput = dynamic(\.bgInput)
        static let bgComposer = dynamic(\.bgComposer)
        static let border = dynamic(\.border)
        static let borderLight = dynamic(\.borderLight)
        static let accent = dynamic(\.accent)
        static let accentHover = dynamic(\.accentHover)
        static let accentMuted = dynamic(\.accentMuted)
        static let textPrimary = dynamic(\.textPrimary)
        static let textSecondary = dynamic(\.textSecondary)
        static let textMuted = dynamic(\.textMuted)
        static let textOnAccent = dynamic(\.textOnAccent)
        static let success = dynamic(\.success)
        static let error = dynamic(\.error)
        static let warning = dynamic(\.warning)
        static let info = dynamic(\.info)
        static let msgUser = dynamic(\.msgUser)
        static let msgAssistant = dynamic(\.msgAssistant)
        static let codeBackground = dynamic(\.codeBackground)
        static let splash = dynamic(\.splash)
        static let contextWarning = dynamic(\.contextWarning)

        /// State formulas from the spec, derived from `accent`.
        static var hover: Color { accent.opacity(Alpha.hover) }
        static var selected: Color { accent.opacity(Alpha.selected) }
        static var inputBorderIdle: Color { accent.opacity(Alpha.inputBorderIdle) }
        static var segmentTrack: Color { accent.opacity(Alpha.segmentTrack) }
        /// Category tag background: #7f7f7f @ 12 % in both schemes.
        static let categoryTag = Color(red: 0x7F / 255.0, green: 0x7F / 255.0, blue: 0x7F / 255.0).opacity(Alpha.categoryTag)

        private static func dynamic(_ key: KeyPath<PaletteHex, UInt32>) -> Color {
            Color(uiColor: UIColor { traits in
                let hex = traits.userInterfaceStyle == .dark ? PaletteHex.dark[keyPath: key] : PaletteHex.light[keyPath: key]
                return UIColor(coreHubHex: hex)
            })
        }
    }

    enum Alpha {
        static let hover = 0.06
        static let selected = 0.12
        static let inputBorderIdle = 0.18
        static let inputBorderHover = 0.32
        static let textSelection = 0.30
        static let segmentTrack = 0.05
        static let categoryTag = 0.12
        static let drawerScrim = 0.40
        static let unreadHalo = 0.12
        static let deleteAffordance = 0.50
        static let thinkingText = 0.85
    }

    // MARK: Typography (system sans / system mono)

    enum Typography {
        /// Device-local text scale (Settings › Display › Text size). Every
        /// token font is multiplied by it; `AppStore` keeps it in step with
        /// the stored preference and rebuilds the shell when it changes.
        static var scale: CGFloat = 1

        static let base: CGFloat = 14
        static let baseMinimum: CGFloat = 12
        static let baseMaximum: CGFloat = 20
        static let title: CGFloat = 16
        static let titleWeight: Font.Weight = .semibold
        static let navItem: CGFloat = 14
        static let sidebarTab: CGFloat = 13
        static let sessionTitle: CGFloat = 13
        static let author: CGFloat = 12
        static let meta: CGFloat = 11
        static let groupHeader: CGFloat = 10
        static let groupHeaderWeight: Font.Weight = .semibold
        static let groupHeaderTracking: CGFloat = 0.5
        static let categoryTag: CGFloat = 10
        static let code: CGFloat = 13
        static let thinking: CGFloat = 13
        static let messageBody: CGFloat = 14
        static let bodyLineHeight: CGFloat = 1.6
        static let messageLineHeight: CGFloat = 1.65
        static let codeLineHeight: CGFloat = 1.5
        /// Inputs never render below 16 pt on phones (no zoom on focus).
        static let inputMinimum: CGFloat = 16
        static let workspaceChip: CGFloat = 11

        /// Clamped so a large scale never breaks the 16 pt input minimum.
        static func scaled(_ size: CGFloat) -> CGFloat { (size * max(0.85, min(1.45, scale))).rounded() }

        static func font(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
            .system(size: scaled(size), weight: weight)
        }
        static func mono(_ size: CGFloat = code, weight: Font.Weight = .regular) -> Font {
            .system(size: scaled(size), weight: weight, design: .monospaced)
        }

        static var titleFont: Font { font(title, weight: titleWeight) }
        static var navItemFont: Font { font(navItem) }
        static var sidebarTabFont: Font { font(sidebarTab) }
        static var sessionTitleFont: Font { font(sessionTitle) }
        static var authorFont: Font { font(author) }
        static var metaFont: Font { font(meta) }
        static var groupHeaderFont: Font { font(groupHeader, weight: groupHeaderWeight) }
        static var categoryTagFont: Font { font(categoryTag) }
        static var bodyFont: Font { font(base) }
        static var messageFont: Font { font(messageBody) }
        static var thinkingFont: Font { font(thinking).italic() }
        static var codeFont: Font { mono() }
    }

    // MARK: Radii

    enum Radius {
        /// Buttons, nav items, tool rows, code blocks, session rows.
        static let button: CGFloat = 6
        /// Default control radius (tool summary header).
        static let control: CGFloat = 8
        static let bubble: CGFloat = 10
        /// Cards: sidebar, session list, chat main.
        static let card: CGFloat = 14
        static let composer: CGFloat = 18
        static let pill: CGFloat = 999
        /// Category tag, workspace chip.
        static let tag: CGFloat = 4
        static let segment: CGFloat = 5
    }

    // MARK: Shadows (CSS `0 y blur alpha`; SwiftUI radius ≈ blur / 2)

    struct ShadowSpec: Equatable {
        let opacity: Double
        let blur: CGFloat
        let y: CGFloat
        var radius: CGFloat { blur / 2 }
        var color: Color { Color.black.opacity(opacity) }
    }

    enum Shadow {
        static let card = ShadowSpec(opacity: 0.10, blur: 24, y: 8)
        static let composer = ShadowSpec(opacity: 0.08, blur: 28, y: 8)
        static let composerDark = ShadowSpec(opacity: 0.32, blur: 28, y: 8)
        static let focused = ShadowSpec(opacity: 0.11, blur: 32, y: 10)

        static func composer(for scheme: ColorScheme) -> ShadowSpec { scheme == .dark ? composerDark : composer }
    }

    // MARK: Motion

    enum Motion {
        static let fast: Double = 0.15
        static let normal: Double = 0.25
        static var drawer: Animation { .easeInOut(duration: normal) }
        static var quick: Animation { .easeInOut(duration: fast) }
    }

    // MARK: Layout

    enum Layout {
        static let sidebarWidth: CGFloat = 240
        static let sidebarCollapsedWidth: CGFloat = 64
        static let headerHeight: CGFloat = 60
        static let breakpoint: CGFloat = 768
        /// Off-canvas drawer: at most this wide, at most this fraction of the screen.
        static let drawerMaxWidth: CGFloat = 300
        static let drawerWidthFraction: CGFloat = 0.84
        static let edgeSwipeWidth: CGFloat = 18
        static let iconStroke: CGFloat = 1.8
        static let iconViewBox: CGFloat = 24
        static let railIcon: CGFloat = 20
        static let segmentHeight: CGFloat = 30
        static let sessionRowVertical: CGFloat = 8
        static let sessionRowHorizontal: CGFloat = 10
        static let sessionAvatar: CGFloat = 18
        static let profileChipAvatar: CGFloat = 16
        static let pinIcon: CGFloat = 11
        static let unreadDot: CGFloat = 6
        static let groupChevron: CGFloat = 10
        static let categoryTagMaxWidthFraction: CGFloat = 0.45
        static let assistantAvatar: CGFloat = 22
        static let userBubbleMaxFraction: CGFloat = 0.75
        static let assistantBubbleMaxFraction: CGFloat = 0.80
        static let bubblePaddingVertical: CGFloat = 10
        static let bubblePaddingHorizontal: CGFloat = 14
        static let composerMinHeight: CGFloat = 150
        static let composerButton: CGFloat = 30
        static let actionButton: CGFloat = 24
        static let contextBarWidth: CGFloat = 60
        static let contextBarWidthPhone: CGFloat = 42
        static let contextBarHeight: CGFloat = 4
        static let modelPillMaxWidth: CGFloat = 190
        static let toolSummaryMaxWidth: CGFloat = 520
        static let toolSummaryHeader: CGFloat = 30
        static let longPress: Double = 0.5
        static let recentDefault = 10
        static let recentMinimum = 1
        static let recentMaximum = 100
    }
}

extension UIColor {
    convenience init(coreHubHex hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension View {
    /// Applies one of the spec shadows.
    func coreHubShadow(_ spec: CoreHubTokens.ShadowSpec) -> some View {
        shadow(color: spec.color, radius: spec.radius, x: 0, y: spec.y)
    }

    /// Page background (bg.primary) behind every screen.
    func hermesBackground() -> some View { background(CoreHubTokens.Palette.bgPrimary.ignoresSafeArea()) }
}

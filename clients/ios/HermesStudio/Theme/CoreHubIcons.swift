import SwiftUI

/// Line icons from `DESIGN-SPEC.md` (24 viewBox, stroke 1.8, round caps
/// and joins), drawn as SwiftUI paths so they match the web exactly.
enum CoreHubIcon: String, CaseIterable {
    case newChat, search, deviceConnections, agentManager, models
    case chat, group, workflow, history, settings
    case menu, close, chevronForward, chevronDown, back, folder, more, pin, plus, check
    /// Tool summary header (web `ToolRunSummary.vue`).
    case wrench
    /// Attachment sheet: take a photo, pick one from the library, pick any file.
    case camera, image, paperclip

    var shapes: [IconShape] {
        switch self {
        case .newChat, .plus:
            return [.path("M12 5v14 M5 12h14")]
        case .search:
            return [.circle(cx: 11, cy: 11, r: 7), .path("m20 20-3.5-3.5")]
        case .deviceConnections:
            return [.circle(cx: 18, cy: 5, r: 2.5), .circle(cx: 6, cy: 12, r: 2.5), .circle(cx: 18, cy: 19, r: 2.5), .path("m8.2 10.7 7.6-4.4M8.2 13.3l7.6 4.4")]
        case .agentManager:
            return [.path("M12 8V4H8"), .rect(x: 4, y: 8, width: 16, height: 12, rx: 3), .path("M2 14h2M20 14h2M9 13v2M15 13v2")]
        case .models:
            return [.circle(cx: 12, cy: 12, r: 3), .path("M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1")]
        case .chat:
            return [.path("M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")]
        case .group:
            return [.path("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"), .circle(cx: 9, cy: 7, r: 4), .path("M22 21v-2a4 4 0 0 0-3-3.87"), .path("M16 3.13a4 4 0 0 1 0 7.75")]
        case .workflow:
            return [.circle(cx: 5, cy: 12, r: 3), .circle(cx: 19, cy: 6, r: 3), .circle(cx: 19, cy: 18, r: 3), .path("M8 12h3a4 4 0 0 0 4-4V6"), .path("M8 12h3a4 4 0 0 1 4 4v2")]
        case .history:
            return [.circle(cx: 12, cy: 12, r: 9), .path("M12 7v5l3 2")]
        case .settings:
            return [.circle(cx: 12, cy: 12, r: 3), .path(Self.gearPath)]
        case .menu:
            return [.path("M3 6h18M3 12h18M3 18h18")]
        case .close:
            return [.path("M18 6 6 18M6 6l12 12")]
        case .chevronForward:
            return [.path("m9 18 6-6-6-6")]
        case .chevronDown:
            return [.path("m6 9 6 6 6-6")]
        case .back:
            return [.path("M19 12H5M12 19l-7-7 7-7")]
        case .folder:
            return [.path("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")]
        case .more:
            return [.circle(cx: 5, cy: 12, r: 1), .circle(cx: 12, cy: 12, r: 1), .circle(cx: 19, cy: 12, r: 1)]
        case .pin:
            return [.path("M12 17v5M9 3h6l-1 7 3 3H7l3-3z")]
        case .check:
            return [.path("M20 6 9 17l-5-5")]
        case .wrench:
            return [.path("M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z")]
        case .camera:
            return [.path("M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"), .circle(cx: 12, cy: 13, r: 3)]
        case .image:
            return [.path("M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"), .circle(cx: 9, cy: 9, r: 2), .path("M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21")]
        case .paperclip:
            return [.path("M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48")]
        }
    }

    /// Icons that point along the reading direction flip in RTL layouts.
    var mirrorsInRTL: Bool {
        switch self {
        case .chevronForward, .back, .chat, .workflow, .history: return true
        default: return false
        }
    }

    static let gearPath = "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
}

/// Renders a `CoreHubIcon` at `size` points with the spec stroke.
struct CoreHubIconView: View {
    let icon: CoreHubIcon
    var size: CGFloat = CoreHubTokens.Layout.railIcon
    var strokeWidth: CGFloat = CoreHubTokens.Layout.iconStroke
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        IconShapes(shapes: icon.shapes)
            .stroke(style: StrokeStyle(lineWidth: strokeWidth * size / CoreHubTokens.Layout.iconViewBox, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .scaleEffect(x: icon.mirrorsInRTL && layoutDirection == .rightToLeft ? -1 : 1, y: 1)
            .accessibilityHidden(true)
    }
}

/// The Core Hub vector mark (`core-hub-mark.svg`, 1024 viewBox): the outer
/// "C" path plus the rounded core square, filled.
enum CoreHubMark {
    static let viewBox: CGFloat = 1024
    static let shapes: [IconShape] = [
        .path("M302 110H738C847 110 922 180 922 286V425H713V328C713 287 687 263 648 263H381C326 263 287 299 287 353V671C287 725 326 761 381 761H648C687 761 713 737 713 696V599H922V738C922 844 847 914 738 914H302C180 914 102 840 102 720V304C102 184 180 110 302 110Z"),
        .rect(x: 369, y: 373, width: 278, height: 278, rx: 66),
    ]
}

struct CoreHubMarkView: View {
    var size: CGFloat = 32
    var color: Color = CoreHubTokens.Palette.textPrimary

    var body: some View {
        IconShapes(shapes: CoreHubMark.shapes, viewBox: CoreHubMark.viewBox)
            .fill(color, style: FillStyle(eoFill: false))
            .frame(width: size, height: size)
            .accessibilityLabel("Core Hub")
    }
}

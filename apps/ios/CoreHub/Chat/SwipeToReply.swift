// Swipe a message to reply to it, as in Telegram (DECISIONS §150; the owner: «اذا المستخدم سحب
// المحادثة يسار يخليني كاني برد عليها نفس التيليقرام»). The bubble follows the finger toward the
// start of the reading direction — left in English, right in Arabic — which is away from the
// interactive back swipe (it starts at the leading screen edge and moves toward the trailing side),
// so the two never compete; the system's edge gesture still wins at the very edge. Past
// `SwipeReplyRules.threshold` a light tick, and on release the same reply the message menu offers.
// A mostly vertical drag is the list's: the axis is decided once, at the start, and kept.
// VoiceOver gets a «Reply» action; with Reduce Motion the bubble returns without animating.
import SwiftUI
import UIKit

enum SwipeReplyRules {
    /// How far the bubble must travel before letting go replies.
    static let threshold: CGFloat = 60
    /// How far it goes at most; past the threshold it moves at a third of the finger's speed.
    static let limit: CGFloat = 96

    /// The sign of a reply swipe's horizontal travel: toward the reading start.
    static func direction(_ layout: LayoutDirection) -> CGFloat {
        layout == .leftToRight ? -1 : 1
    }

    /// Whether a drag's opening move is a swipe to reply (and not a scroll).
    static func startsSwipe(dx: CGFloat, dy: CGFloat, direction: CGFloat) -> Bool {
        dx * direction > 0 && abs(dx) > abs(dy) * 1.5
    }

    /// Where the bubble is for a finger `travel` along the swipe's direction.
    static func offset(for travel: CGFloat) -> CGFloat {
        let along = max(travel, 0)
        let resisted = along <= threshold ? along : threshold + (along - threshold) / 3
        return min(resisted, limit)
    }
}

struct SwipeToReply: ViewModifier {
    let enabled: Bool
    /// The interface's own direction (a chat row forces its layout to left-to-right).
    let uiDirection: LayoutDirection
    let onReply: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.l10n) private var l10n
    @State private var offset: CGFloat = 0
    /// Decided on the drag's first move: a swipe to reply (`true`) or somebody else's (`false`).
    @State private var swiping: Bool?
    @State private var ticked = false

    private var sign: CGFloat { SwipeReplyRules.direction(uiDirection) }

    func body(content: Content) -> some View {
        if enabled {
            content
                .offset(x: offset)
                // The arrow behind the bubble, on the side it is pulled away from (the row is
                // left-to-right, so `.trailing` is the right).
                .background(alignment: sign < 0 ? .trailing : .leading) { arrow }
                .simultaneousGesture(drag)
                .accessibilityAction(named: Text(l10n("chat_controls.reply_action"))) { onReply() }
        } else {
            content
        }
    }

    @ViewBuilder
    private var arrow: some View {
        let progress = min(abs(offset) / SwipeReplyRules.threshold, 1)
        if progress > 0 {
            LucideIcon(.reply, size: 20)
                .foregroundStyle(Tone.accent)
                .scaleEffect(0.6 + 0.4 * progress)
                .opacity(progress)
                .padding(.horizontal, Space.s2)
                .accessibilityHidden(true)
                .accessibilityIdentifier("message.swipe_reply")
        }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height
                if swiping == nil { swiping = SwipeReplyRules.startsSwipe(dx: dx, dy: dy, direction: sign) }
                guard swiping == true else { return }
                let shown = SwipeReplyRules.offset(for: dx * sign)
                if !ticked, shown >= SwipeReplyRules.threshold {
                    ticked = true
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } else if ticked, shown < SwipeReplyRules.threshold {
                    ticked = false
                }
                offset = shown * sign
            }
            .onEnded { _ in
                if swiping == true, ticked { onReply() }
                swiping = nil
                ticked = false
                withAnimation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.85)) { offset = 0 }
            }
    }
}

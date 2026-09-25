// The keyboard gets out of the way the way it does in Messages: a tap on the conversation, a
// drag of the list, or the drawer moving puts it away (owner, 2026-09-25).
import SwiftUI
import UIKit

enum Keyboard {
    /// Ends editing wherever it is: the composer, the drawer's search, an approval's answer.
    @MainActor
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

extension View {
    /// A tap anywhere on this view puts the keyboard away. It runs beside the view's own
    /// gestures, so buttons, links and text selection inside keep working.
    func dismissesKeyboardOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded { Keyboard.dismiss() })
    }
}

/// The phone drawer. Moving it, either way, first puts the keyboard away: the drawer never
/// opens over it, and closing it never leaves the drawer's search typing into nothing.
@Observable
final class DrawerState {
    private(set) var isOpen = false
    @ObservationIgnored private let dismissKeyboard: @MainActor () -> Void

    init(dismissKeyboard: @escaping @MainActor () -> Void = { Keyboard.dismiss() }) {
        self.dismissKeyboard = dismissKeyboard
    }

    @MainActor
    func set(_ open: Bool, animation: Animation? = .easeInOut(duration: Motion.normal)) {
        dismissKeyboard()
        guard open != isOpen else { return }
        withAnimation(animation) { isOpen = open }
    }
}

import Combine
import SwiftUI
import UIKit

/// Keyboard handling shared by the shell.
///
/// Opening the navigation drawer has to take the keyboard with it: the chat
/// composer keeps first-responder status otherwise and the keyboard is left
/// covering the drawer's lower half (reported by the owner on both mobile
/// clients).
enum Keyboard {
    /// Resigns whatever currently holds first responder. Safe to call when
    /// nothing is focused.
    @MainActor
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// How much of a full-height view the keyboard covers, once the bottom
    /// safe area the layout already reserves is taken off. Pure so the inset
    /// can be checked without a device.
    static func overlap(keyboardHeight: CGFloat, bottomSafeArea: CGFloat) -> CGFloat {
        guard keyboardHeight.isFinite, keyboardHeight > 0 else { return 0 }
        return max(0, keyboardHeight - max(0, bottomSafeArea))
    }
}

/// Publishes how much of the screen the keyboard covers.
///
/// Views that opt out of SwiftUI's automatic avoidance
/// (`ignoresSafeArea(.keyboard)`) use this to keep exactly one explicit
/// inset instead of depending on where SwiftUI decides to apply its own.
final class KeyboardObserver: ObservableObject {
    @Published private(set) var overlap: CGFloat = 0

    private let center: NotificationCenter
    private var tokens: [NSObjectProtocol] = []

    init(center: NotificationCenter = .default) {
        self.center = center
        tokens.append(center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            self?.apply(note)
        })
        tokens.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            self?.overlap = 0
        })
    }

    deinit {
        for token in tokens { center.removeObserver(token) }
    }

    private func apply(_ note: Notification) {
        let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
        overlap = Keyboard.overlap(keyboardHeight: frame.height, bottomSafeArea: Self.bottomSafeArea())
    }

    /// Home-indicator inset of the key window: the keyboard frame includes
    /// it, and the drawer already reserves it.
    private static func bottomSafeArea() -> CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets.bottom ?? 0
    }
}

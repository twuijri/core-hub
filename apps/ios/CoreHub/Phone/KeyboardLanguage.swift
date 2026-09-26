// The language of the keyboard the person is typing with: what «Auto» dictation listens in
// (DictationLanguage). Read from the focused text input's `textInputMode`, kept up to date when
// the person switches keyboards, and remembered, so a tap on the microphone while the keyboard
// is down still follows the last one used.
import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class KeyboardLanguage {
    static let shared = KeyboardLanguage()

    /// The last keyboard language seen, as a BCP-47 tag; nil before any was.
    private(set) var current: String?

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    static let key = Product.storagePrefix + "device.keyboard_language"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        current = DictationLanguage.tag(defaults.string(forKey: Self.key))
        let center = NotificationCenter.default
        for name in [UITextInputMode.currentInputModeDidChangeNotification, UIResponder.keyboardDidShowNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            })
        }
    }

    /// Reads the focused input's keyboard now; returns the language to use (the remembered one
    /// when nothing is focused).
    @discardableResult
    func refresh() -> String? {
        if let tag = DictationLanguage.tag(UIResponder.focused?.textInputMode?.primaryLanguage) {
            current = tag
            defaults.set(tag, forKey: Self.key)
        }
        return current
    }

    /// The languages of the keyboards the person has turned on, in their order.
    static var enabled: [String] {
        var seen = Set<String>()
        return UITextInputMode.activeInputModes
            .compactMap { DictationLanguage.tag($0.primaryLanguage) }
            .filter { seen.insert($0.lowercased()).inserted }
    }
}

extension UIResponder {
    private static weak var found: UIResponder?

    /// The first responder — the text input the keyboard types into — if there is one.
    static var focused: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.noteFocused), to: nil, from: nil, for: nil)
        return found
    }

    @objc private func noteFocused() {
        UIResponder.found = self
    }
}

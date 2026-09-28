// The language of the keyboard the person is typing with: what «Auto» dictation listens in
// (DictationLanguage). Read from the focused text input's `textInputMode`, kept up to date when
// the person switches keyboards, and remembered, so a tap on the microphone while the keyboard
// is down still follows the last one used.
//
// A third-party keyboard (Gboard, SwiftKey…) may not say its current language in its reading, so
// for one its language is taken from the reading once it is seen to change, else the side of the
// empty composer's cursor, else what is typed with it, else the last one used (KeyboardEvidence,
// TypedLanguage.swift). A language the person picks on the recording bar is the last one used.
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
    @ObservationIgnored private var evidence = KeyboardEvidence()
    /// The input the keyboard types into now (a test gives none).
    @ObservationIgnored private let focused: () -> UIResponder?

    static let key = Product.storagePrefix + "device.keyboard_language"

    init(defaults: UserDefaults = .standard, focused: @escaping () -> UIResponder? = { UIResponder.focused }) {
        self.defaults = defaults
        self.focused = focused
        current = DictationLanguage.tag(defaults.string(forKey: Self.key))
        let center = NotificationCenter.default
        for name in [UITextInputMode.currentInputModeDidChangeNotification, UIResponder.keyboardDidShowNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { _ = self?.refresh() }
            })
        }
    }

    /// Reads the focused input's keyboard now; returns the language to use (the remembered one
    /// when nothing is focused, or when the keyboard does not show it and nothing was typed since).
    @discardableResult
    func refresh() -> String? {
        guard let responder = focused() else { return current }
        read(responder)
        let known = self.known
        let preferring = [evidence.typedLanguage(known: known), current].compactMap { $0 }
        if let tag = evidence.shownLanguage(cursor: Self.cursorSide(of: responder), preferring: preferring, known: known) {
            store(tag)
        }
        return current
    }

    /// The composer's text changed: typing tells the language of a keyboard that does not say it.
    func noteEdit(from old: String, to new: String) {
        if let responder = focused() { read(responder) }
        guard evidence.edit(from: old, to: new), let tag = evidence.typedLanguage(known: known) else { return }
        store(tag)
    }

    /// A language the person picked while dictating is the last one used now.
    func remember(_ language: String) {
        guard let tag = DictationLanguage.tag(language) else { return }
        store(tag)
    }

    /// The person's languages: their keyboards', their phone's, the last one used.
    private var known: [String] {
        Self.enabled + Locale.preferredLanguages + [current].compactMap { $0 }
    }

    /// Reads the focused input's keyboard, fresh (never a cached value).
    private func read(_ responder: UIResponder) {
        let mode = responder.textInputMode
        evidence.observe(
            reading: mode?.primaryLanguage,
            modeClass: mode.map { NSStringFromClass(type(of: $0)) },
            mode: mode.map { ObjectIdentifier($0) }
        )
    }

    /// Which side the cursor stands on in the focused input when it is empty: iOS puts it on the
    /// right for a right-to-left keyboard language, on the left for a left-to-right one — also for
    /// a third-party keyboard that tells iOS its language. Nil when the input has text.
    private static func cursorSide(of responder: UIResponder) -> DictationLanguage.Direction? {
        guard let input = responder as? UITextInput, let view = responder as? UIView,
              input.offset(from: input.beginningOfDocument, to: input.endOfDocument) == 0
        else { return nil }
        let caret = input.caretRect(for: input.endOfDocument)
        guard caret.midX.isFinite, !caret.isNull else { return nil }
        return DictationLanguage.cursorSide(caretMidX: Double(caret.midX - view.bounds.minX), width: Double(view.bounds.width))
    }

    private func store(_ tag: String) {
        guard tag != current else { return }
        current = tag
        defaults.set(tag, forKey: Self.key)
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

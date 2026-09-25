// What the share extension hands to the app: the text and links a person shared from another
// app, kept in the App Group both targets read until the app opens a new chat with them.
// Compiled into the app and into the extension (project.yml).
import Foundation

enum ShareInbox {
    /// The App Group both targets belong to (project.yml; registered with the owner's Apple
    /// account when the app is signed — README.md).
    static let group = "group.com.twuijri.corehub"
    static let key = Product.storagePrefix + "share.pending"

    static func defaults() -> UserDefaults? { UserDefaults(suiteName: group) }

    /// Shared pieces as one draft: each on its own line, empty ones dropped, no duplicates.
    static func compose(_ pieces: [String]) -> String {
        var seen = Set<String>()
        return pieces
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: "\n")
    }

    static func put(_ text: String, in defaults: UserDefaults?) {
        guard let defaults, !text.isEmpty else { return }
        let existing = defaults.string(forKey: key) ?? ""
        defaults.set(existing.isEmpty ? text : existing + "\n" + text, forKey: key)
    }

    /// The waiting draft, once: taking it empties the inbox.
    static func take(from defaults: UserDefaults?) -> String? {
        guard let defaults, let text = defaults.string(forKey: key), !text.isEmpty else { return nil }
        defaults.removeObject(forKey: key)
        return text
    }
}

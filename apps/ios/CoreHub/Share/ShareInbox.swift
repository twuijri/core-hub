// What the share extension hands to the app: the text, links, pictures and files a person shared
// from another app, kept in the App Group both targets read until the app opens a new chat with
// them (the files as copies in the group's own folder). Compiled into the app and into the
// extension (project.yml).
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

    // MARK: Files and pictures

    static let filesKey = Product.storagePrefix + "share.files"

    /// The folder in the App Group where shared files wait for the app.
    static func folder() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent("share-inbox", isDirectory: true)
    }

    /// A file name that stays inside the folder: no path, no leading dot, never empty.
    static func safeName(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmed = last.drop { $0 == "." }
        return trimmed.isEmpty ? "file" : String(trimmed)
    }

    /// Copies a shared file into the folder under its own name (numbered when taken) and notes it.
    @discardableResult
    static func putFile(_ source: URL, name: String? = nil, in defaults: UserDefaults?, folder: URL?) -> URL? {
        guard let defaults, let folder else { return nil }
        let manager = FileManager.default
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let wanted = safeName(name ?? source.lastPathComponent)
        var target = folder.appendingPathComponent(wanted)
        var n = 2
        while manager.fileExists(atPath: target.path) {
            let base = (wanted as NSString).deletingPathExtension
            let ext = (wanted as NSString).pathExtension
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)")
            n += 1
        }
        do {
            try manager.copyItem(at: source, to: target)
        } catch {
            return nil
        }
        var names = defaults.stringArray(forKey: filesKey) ?? []
        names.append(target.lastPathComponent)
        defaults.set(names, forKey: filesKey)
        return target
    }

    /// The waiting files, once: their places in the folder (the app deletes them once read).
    static func takeFiles(from defaults: UserDefaults?, folder: URL?) -> [URL] {
        guard let defaults, let folder, let names = defaults.stringArray(forKey: filesKey), !names.isEmpty else { return [] }
        defaults.removeObject(forKey: filesKey)
        return names.map { folder.appendingPathComponent($0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
    }
}

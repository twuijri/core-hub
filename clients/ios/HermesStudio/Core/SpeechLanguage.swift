import Foundation
import Speech
import UIKit

// MARK: - The owner's choice

/// Which language dictation listens for, stored per profile.
///
/// The app language is *not* the dictation language: an English phone running
/// an English app is a normal way to speak Arabic. The default therefore
/// follows the keyboards the owner actually types with, which is the closest
/// public signal iOS gives for "the languages this person writes in".
enum SpeechInputChoice: Equatable {
    /// Default: the first enabled keyboard language Apple Speech supports,
    /// preferring one that is not the app language. Stays on the device.
    case keyboards
    /// The behaviour before this preference existed: `ar-SA` / `en-US` from
    /// the app language, otherwise the device locale. Stays on the device.
    case appLanguage
    /// One BCP-47 identifier the device recogniser actually supports.
    case locale(String)
    /// Explicit opt-in: Apple's recogniser takes a single locale and cannot
    /// detect across languages, so this one choice records the audio and sends
    /// it to the Core Hub server with no language hint. Never a default, and
    /// never entered without the owner picking it.
    case serverDetected
}

/// What one choice means for the two transcription paths.
struct SpeechLanguagePlan: Equatable {
    /// Locale for `SFSpeechRecognizer`; `nil` only for `serverDetected`.
    let deviceLocaleIdentifier: String?
    /// The optional `language` field of `POST /api/studio/stt/transcribe`;
    /// `nil` asks the server to decide.
    let serverLanguageHint: String?
    /// Locale to dictate in when the server path is chosen but unavailable.
    /// Never empty, so a fallback never has to be guessed at the call site.
    let fallbackLocaleIdentifier: String

    /// Only the explicit server choice has no on-device recogniser.
    var requiresServer: Bool { deviceLocaleIdentifier == nil }
}

// MARK: - Resolution

enum SpeechLanguageResolver {
    /// Empty storage means `keyboards`, so the default improves for every
    /// profile without a migration.
    static let keyboardsPreference = ""
    static let appLanguagePreference = "app"
    static let serverPreference = "server"

    /// `ar-SA` and `en-US` are the two locales the app has always used for its
    /// own languages; everything else follows the phone.
    static func appLocaleIdentifier(appLanguage: String, systemLocaleIdentifier: String) -> String {
        if appLanguage == "ar" { return "ar-SA" }
        if appLanguage == "en" { return "en-US" }
        let system = normalize(systemLocaleIdentifier)
        return system.isEmpty ? "en-US" : system
    }

    /// Reads the stored value. A locale the recogniser no longer supports (an
    /// iOS update, a restored backup from another device, a hand-edited value)
    /// falls back to the keyboard default rather than pinning dictation to
    /// something that cannot run.
    static func choice(stored: String, supported: Set<String>) -> SpeechInputChoice {
        let value = normalize(stored)
        if value.isEmpty { return .keyboards }
        if matches(value, appLanguagePreference) { return .appLanguage }
        // `auto` was the working name for the server option before it was
        // renamed; a device that stored it keeps the same behaviour.
        if matches(value, serverPreference) || matches(value, "auto") { return .serverDetected }
        guard let match = canonical(value, in: supported) else { return .keyboards }
        return .locale(match)
    }

    /// The value written to `Preferences`.
    static func stored(for choice: SpeechInputChoice) -> String {
        switch choice {
        case .keyboards: return keyboardsPreference
        case .appLanguage: return appLanguagePreference
        case .serverDetected: return serverPreference
        case let .locale(identifier): return normalize(identifier)
        }
    }

    /// `keyboardLanguages` is `UITextInputMode.activeInputModes` mapped to
    /// `primaryLanguage`, in the owner's own keyboard order.
    static func plan(for choice: SpeechInputChoice,
                     appLanguage: String,
                     systemLocaleIdentifier: String,
                     keyboardLanguages: [String],
                     supported: Set<String>) -> SpeechLanguagePlan {
        let appLocale = appLocaleIdentifier(appLanguage: appLanguage, systemLocaleIdentifier: systemLocaleIdentifier)
        switch choice {
        case .keyboards:
            let keyboard = keyboardLocale(keyboardLanguages: keyboardLanguages,
                                          supported: supported,
                                          appLanguageCode: languageCode(of: appLocale))
            return onDevice(keyboard ?? appLocale)
        case .appLanguage:
            return onDevice(appLocale)
        case let .locale(identifier):
            return onDevice(normalize(identifier))
        case .serverDetected:
            let keyboard = keyboardLocale(keyboardLanguages: keyboardLanguages,
                                          supported: supported,
                                          appLanguageCode: languageCode(of: appLocale))
            return SpeechLanguagePlan(deviceLocaleIdentifier: nil,
                                      serverLanguageHint: nil,
                                      fallbackLocaleIdentifier: keyboard ?? appLocale)
        }
    }

    private static func onDevice(_ identifier: String) -> SpeechLanguagePlan {
        SpeechLanguagePlan(deviceLocaleIdentifier: identifier,
                           serverLanguageHint: languageCode(of: identifier),
                           fallbackLocaleIdentifier: identifier)
    }

    /// The keyboard-derived dictation locale, or `nil` when no enabled
    /// keyboard maps to a language Apple Speech supports.
    ///
    /// With more than one usable keyboard the first one that is *not* the app
    /// language wins: an English app with an Arabic keyboard added is exactly
    /// the reported case, and an English-only speaker never adds a second
    /// keyboard to begin with.
    static func keyboardLocale(keyboardLanguages: [String],
                               supported: Set<String>,
                               appLanguageCode: String?) -> String? {
        var candidates: [String] = []
        for language in keyboardLanguages {
            guard let resolved = supportedLocale(matching: language, in: supported) else { continue }
            if !candidates.contains(resolved) { candidates.append(resolved) }
        }
        guard let first = candidates.first else { return nil }
        guard candidates.count > 1, let appCode = appLanguageCode else { return first }
        return candidates.first { languageCode(of: $0) != appCode } ?? first
    }

    /// Maps one keyboard's `primaryLanguage` onto a locale the recogniser
    /// supports: the exact identifier when it exists, otherwise the best
    /// locale for the same language (`ar` keyboard → `ar-SA`).
    /// `emoji`, `dictation` and other non-language modes match nothing.
    static func supportedLocale(matching language: String, in supported: Set<String>) -> String? {
        let wanted = normalize(language)
        guard !wanted.isEmpty, let code = languageCode(of: wanted), code.count >= 2,
              code.allSatisfy({ $0.isLetter }), code != "emoji", code != "dictation" else { return nil }
        if let exact = canonical(wanted, in: supported) { return exact }
        let sameLanguage = supported
            .filter { languageCode(of: $0) == code }
            .map { SpeechLocaleOption(identifier: $0, endonym: SpeechLocaleCatalog.endonym(for: $0)) }
            .sorted(by: SpeechLocaleCatalog.isOrderedBefore)
        return sameLanguage.first?.identifier
    }

    /// The two-letter hint the server path sends (`ar-SA` → `ar`).
    static func languageCode(of identifier: String) -> String? {
        let head = normalize(identifier).split(separator: "-").first.map(String.init) ?? ""
        return head.isEmpty ? nil : head.lowercased()
    }

    /// `ar_SA` and `ar-SA` name the same locale; Foundation produces the first
    /// spelling and Apple Speech the second, so everything is compared in the
    /// hyphenated form.
    static func normalize(_ identifier: String) -> String {
        identifier.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "_", with: "-")
    }

    /// The supported set's own spelling of `identifier`, or `nil` when the
    /// recogniser does not support it.
    static func canonical(_ identifier: String, in supported: Set<String>) -> String? {
        let wanted = normalize(identifier)
        guard !wanted.isEmpty else { return nil }
        if supported.contains(wanted) { return wanted }
        return supported.first { $0.caseInsensitiveCompare(wanted) == .orderedSame }
    }

    private static func matches(_ value: String, _ marker: String) -> Bool {
        value.caseInsensitiveCompare(marker) == .orderedSame
    }
}

// MARK: - What this iPhone can recognise

/// One row of the dictation-language picker.
struct SpeechLocaleOption: Identifiable, Equatable {
    /// BCP-47 identifier exactly as the recogniser reports it (`ar-SA`).
    let identifier: String
    /// The locale's own name for itself (`العربية (المملكة العربية السعودية)`).
    let endonym: String

    var id: String { identifier }
    var languageCode: String { SpeechLanguageResolver.languageCode(of: identifier) ?? identifier }
}

enum SpeechLocaleCatalog {
    /// Builds the picker rows from whatever `SFSpeechRecognizer` reports. The
    /// list is never hard-coded, so a locale the recogniser cannot serve is
    /// never offered.
    static func options(from locales: Set<Locale>) -> [SpeechLocaleOption] {
        let rows = Set(locales.map { SpeechLanguageResolver.normalize($0.identifier) })
            .filter { !$0.isEmpty }
            .map { SpeechLocaleOption(identifier: $0, endonym: endonym(for: $0)) }
        return rows.sorted(by: isOrderedBefore)
    }

    static func identifiers(from locales: Set<Locale>) -> Set<String> {
        Set(options(from: locales).map(\.identifier))
    }

    /// Arabic first (Saudi Arabic at the top), then English (US first), then
    /// everything else by its own name. The owner dictates Arabic on an English
    /// phone, so the two languages he uses must not be buried in a long list.
    static func isOrderedBefore(_ lhs: SpeechLocaleOption, _ rhs: SpeechLocaleOption) -> Bool {
        let left = rank(lhs), right = rank(rhs)
        if left != right { return left < right }
        if left < 2 {
            let leftPreferred = isPreferredRegion(lhs.identifier), rightPreferred = isPreferredRegion(rhs.identifier)
            if leftPreferred != rightPreferred { return leftPreferred }
            return lhs.identifier.caseInsensitiveCompare(rhs.identifier) == .orderedAscending
        }
        let names = lhs.endonym.compare(rhs.endonym, options: .caseInsensitive)
        if names != .orderedSame { return names == .orderedAscending }
        return lhs.identifier.caseInsensitiveCompare(rhs.identifier) == .orderedAscending
    }

    private static func rank(_ option: SpeechLocaleOption) -> Int {
        switch option.languageCode.lowercased() {
        case "ar": return 0
        case "en": return 1
        default: return 2
        }
    }

    private static func isPreferredRegion(_ identifier: String) -> Bool {
        let value = SpeechLanguageResolver.normalize(identifier)
        return value.caseInsensitiveCompare("ar-SA") == .orderedSame
            || value.caseInsensitiveCompare("en-US") == .orderedSame
    }

    /// The locale's name in its own language. `localizedString(forIdentifier:)`
    /// lower-cases some languages, so the first character is raised again using
    /// that same locale's casing rules.
    static func endonym(for identifier: String) -> String {
        let value = SpeechLanguageResolver.normalize(identifier)
        guard !value.isEmpty else { return identifier }
        let locale = Locale(identifier: value)
        guard let name = locale.localizedString(forIdentifier: value)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return value }
        guard let first = name.first else { return value }
        return String(first).uppercased(with: locale) + name.dropFirst()
    }
}

/// The locales this iPhone's recogniser actually supports, read once.
enum DeviceSpeechLocales {
    private static let locales = SFSpeechRecognizer.supportedLocales()
    static let options: [SpeechLocaleOption] = SpeechLocaleCatalog.options(from: locales)
    static let identifiers: Set<String> = Set(options.map(\.identifier))
}

/// The languages of the keyboards the owner has enabled, in his own order.
///
/// `UITextInputMode.activeInputModes` is public UIKit (iOS 4.2+, unchanged on
/// iOS 17) and needs no permission. The list changes whenever a keyboard is
/// added or removed, so it is read at dictation time instead of being cached.
/// `emoji` and `dictation` appear here as input modes and are dropped by
/// `SpeechLanguageResolver.supportedLocale(matching:in:)`.
@MainActor
enum KeyboardLanguages {
    static var current: [String] {
        UITextInputMode.activeInputModes.compactMap(\.primaryLanguage)
    }
}

// MARK: - Recently used languages

/// The last languages dictated with, per profile, so switching back costs one
/// long press and one tap instead of scrolling the whole list again.
enum SpeechLanguageHistory {
    static let limit = 3

    /// Most recent first, no duplicates, capped.
    static func updated(_ existing: [String], picking identifier: String) -> [String] {
        let value = SpeechLanguageResolver.normalize(identifier)
        guard !value.isEmpty else { return existing }
        var next = [value]
        for entry in existing where entry.caseInsensitiveCompare(value) != .orderedSame {
            next.append(entry)
        }
        return Array(next.prefix(limit))
    }

    /// Drops anything this iPhone's recogniser no longer supports and
    /// normalises to the recogniser's own spelling.
    static func visible(_ stored: [String], supported: Set<String>) -> [String] {
        var seen = Set<String>()
        return stored.compactMap { entry in
            guard let canonical = SpeechLanguageResolver.canonical(entry, in: supported) else { return nil }
            return seen.insert(canonical).inserted ? canonical : nil
        }
    }
}

// MARK: - The occasional "long-press the mic" hint

/// When the composer shows the one-line reminder that a long press on the
/// microphone changes the dictation language.
///
/// The gesture is invisible, so it has to be said out loud — but a line that
/// appears on every single recording becomes furniture and stops being read.
/// The rule is therefore: every one of the **first three** recordings, then
/// only occasionally (a gap of five, then seven), and **never again** once
/// the long press has actually been used, because at that point the owner
/// knows the gesture. The count is per profile, like the language itself.
enum DictationHintPolicy {
    /// Recordings that always carry the hint.
    static let firstRecordings = 3
    /// After those, the hint returns on every nth recording — "roughly every
    /// fifth to tenth use": recordings 1–3, then 8, 15, 22…
    static let occasionalPeriod = 7

    /// `recordingCount` is how many recordings this profile has already
    /// started, so the very first one is `0`.
    static func shouldShow(recordingCount: Int, longPressUsed: Bool) -> Bool {
        if longPressUsed { return false }
        let count = max(0, recordingCount)
        if count < firstRecordings { return true }
        return count % occasionalPeriod == 0
    }
}

// MARK: - Labels

enum SpeechLanguageLabel {
    /// One-line summary for the settings row.
    static func summary(for choice: SpeechInputChoice, resolvedLocaleIdentifier: String?) -> String {
        switch choice {
        case .keyboards:
            let name = SpeechLocaleCatalog.endonym(for: resolvedLocaleIdentifier ?? "")
            return String(format: String(localized: "Keyboard languages (%@)"), name)
        case .appLanguage:
            let name = SpeechLocaleCatalog.endonym(for: resolvedLocaleIdentifier ?? "")
            return String(format: String(localized: "App language (%@)"), name)
        case .serverDetected:
            return String(localized: "Detected by the Core Hub server")
        case let .locale(identifier):
            return SpeechLocaleCatalog.endonym(for: identifier)
        }
    }

    /// Short label for the recording strip: the language actually listening,
    /// or a clear marker that the audio is going to the server.
    static func active(for choice: SpeechInputChoice, plan: SpeechLanguagePlan) -> String {
        if case .serverDetected = choice { return String(localized: "Core Hub server") }
        return SpeechLocaleCatalog.endonym(for: plan.deviceLocaleIdentifier ?? plan.fallbackLocaleIdentifier)
    }
}

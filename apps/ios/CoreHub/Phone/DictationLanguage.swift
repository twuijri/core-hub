// Which language the phone's recognizer listens in (owner, 2026-09-27: «المفروض هو يتعرف
// تلقائي»). The iPhone's recognizer takes one locale, so «Auto» — the default — picks it the way a
// person would expect: the keyboard they are typing with, else the language the conversation is
// written in, else the phone's own languages, else the app's. Any language the phone can
// recognize can also be chosen (the long press on the microphone); none is special.
//
// The rules are here, apart from UIKit and Speech, so they are tested.
import Foundation

enum DictationLanguage {
    /// The stored choice that means "pick it for me".
    static let auto = "auto"

    /// Offered after the keyboard's languages in the microphone's menu: widely spoken ones.
    static let popular = ["en", "ar", "es", "fr", "de", "zh", "hi", "pt", "ja", "ru", "it", "tr", "ko", "id", "ur", "fa"]

    /// A writing system the conversation can be recognized by, cheaply, from its letters.
    enum Script: Equatable {
        case arabic, latin, cyrillic, devanagari, han, kana, hangul, hebrew, greek, thai
    }

    /// A keyboard's `primaryLanguage` (or any locale identifier) as a BCP-47 tag; nil for a
    /// keyboard that is not a language (emoji, dictation, handwriting).
    static func tag(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        var parts = trimmed.replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
        guard let first = parts.first else { return nil }
        let base = first.lowercased()
        guard (2...3).contains(base.count), base.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
        if ["mul", "und", "zxx"].contains(base) { return nil }
        parts[0] = base
        // Chinese keyboards name the script; the recognizer names the region.
        if base == "zh", parts.count > 1 {
            switch parts[1].lowercased() {
            case "hans": return "zh-CN"
            case "hant": return "zh-TW"
            default: break
            }
        }
        if parts.count > 1 {
            let second = parts[1]
            parts[1] = second.count == 2 ? second.uppercased() : second.prefix(1).uppercased() + second.dropFirst().lowercased()
        }
        return parts.joined(separator: "-")
    }

    /// The language part of a tag: `ar` of `ar-SA`.
    static func base(_ tag: String) -> String {
        String(tag.replacingOccurrences(of: "_", with: "-").split(separator: "-").first ?? "").lowercased()
    }

    /// The script most letters of `texts` are written in; nil with fewer than three letters.
    static func script(of texts: [String]) -> Script? {
        var counts: [Script: Int] = [:]
        for text in texts {
            for scalar in text.unicodeScalars {
                guard let found = script(of: scalar) else { continue }
                counts[found, default: 0] += 1
            }
        }
        // Japanese mixes kana with Han: any kana makes it Japanese.
        if let kana = counts[.kana], kana > 0 {
            counts[.kana] = kana + (counts[.han] ?? 0)
            counts[.han] = nil
        }
        guard let best = counts.max(by: { $0.value < $1.value }), best.value >= 3 else { return nil }
        return best.key
    }

    private static func script(of scalar: Unicode.Scalar) -> Script? {
        switch scalar.value {
        case 0x0041...0x005A, 0x0061...0x007A, 0x00C0...0x024F, 0x1E00...0x1EFF: return .latin
        case 0x0600...0x06FF, 0x0750...0x077F, 0x08A0...0x08FF, 0xFB50...0xFDFF, 0xFE70...0xFEFF: return .arabic
        case 0x0400...0x052F: return .cyrillic
        case 0x0900...0x097F: return .devanagari
        case 0x3040...0x30FF: return .kana
        case 0x4E00...0x9FFF, 0x3400...0x4DBF: return .han
        case 0xAC00...0xD7AF, 0x1100...0x11FF: return .hangul
        case 0x0590...0x05FF: return .hebrew
        case 0x0370...0x03FF: return .greek
        case 0x0E00...0x0E7F: return .thai
        default: return nil
        }
    }

    /// The script a language is written in (the common case; Latin for the rest).
    static func script(ofLanguage tag: String) -> Script {
        switch base(tag) {
        case "ar", "fa", "ur", "ps", "ckb", "sd", "ug": return .arabic
        case "ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn", "tg": return .cyrillic
        case "hi", "mr", "ne", "sa": return .devanagari
        case "zh", "yue": return .han
        case "ja": return .kana
        case "ko": return .hangul
        case "he", "iw", "yi": return .hebrew
        case "el": return .greek
        case "th": return .thai
        default: return .latin
        }
    }

    /// The language written in `script` among `known` (the keyboards, then the phone's own
    /// languages), else the script's most spoken one.
    static func language(for script: Script, known: [String]) -> String {
        if let mine = known.compactMap(tag).first(where: { self.script(ofLanguage: $0) == script || (script == .han && base($0) == "ja") }) {
            // A Japanese reader's Han-only text is still Japanese.
            return mine
        }
        switch script {
        case .arabic: return "ar"
        case .latin: return "en"
        case .cyrillic: return "ru"
        case .devanagari: return "hi"
        case .han: return "zh"
        case .kana: return "ja"
        case .hangul: return "ko"
        case .hebrew: return "he"
        case .greek: return "el"
        case .thai: return "th"
        }
    }

    /// The languages to try, best first: the person's choice; with Auto, the keyboard in use,
    /// then the language the conversation is written in, then the phone's languages, then the
    /// app's. Duplicates are dropped.
    static func candidates(
        choice: String,
        keyboard: String?,
        recent: [String],
        keyboards: [String],
        preferred: [String],
        app: String
    ) -> [String] {
        var list: [String] = []
        if choice != auto, let chosen = tag(choice) { list.append(chosen) }
        if let keyboard = tag(keyboard) { list.append(keyboard) }
        if let script = script(of: recent) {
            list.append(language(for: script, known: keyboards + preferred))
        }
        list += preferred.compactMap(tag)
        if let app = tag(app) { list.append(app) }
        var seen = Set<String>()
        return list.filter { seen.insert($0.lowercased()).inserted }
    }

    /// The region a bare language is recognized in when the recognizer offers several.
    private static let usualRegion: [String: String] = [
        "ar": "SA", "en": "US", "es": "ES", "fr": "FR", "de": "DE", "pt": "BR", "zh": "CN",
        "it": "IT", "nl": "NL", "ru": "RU", "ja": "JP", "ko": "KR", "hi": "IN", "tr": "TR",
    ]

    /// The first candidate the recognizer supports, as one of `supported`'s own identifiers:
    /// the exact locale when it is there, else the same language in its usual region, else
    /// that language in any region.
    static func match(_ candidates: [String], supported: [String]) -> String? {
        let known = supported.map { (id: $0, tag: tag($0) ?? $0) }
        for candidate in candidates {
            guard let wanted = tag(candidate) else { continue }
            if let exact = known.first(where: { $0.tag.caseInsensitiveCompare(wanted) == .orderedSame }) { return exact.id }
            let language = base(wanted)
            let same = known.filter { base($0.tag) == language }.sorted { $0.tag < $1.tag }
            guard !same.isEmpty else { continue }
            if let region = usualRegion[language],
               let usual = same.first(where: { $0.tag.caseInsensitiveCompare("\(language)-\(region)") == .orderedSame }) {
                return usual.id
            }
            return same[0].id
        }
        return nil
    }

    /// What the microphone's menu offers, in order: the keyboards' languages, then the popular
    /// ones, each once and only when the phone can recognize it (`supported` nil: all).
    static func menu(keyboards: [String], supported: [String]?) -> [String] {
        var seen = Set<String>()
        var list: [String] = []
        for language in keyboards.compactMap(tag) + popular {
            let key = base(language)
            guard seen.insert(key).inserted else { continue }
            if let supported, match([language], supported: supported) == nil { continue }
            list.append(language)
        }
        return list
    }

    /// The tiny mark on the microphone while a language is chosen: `AR`, `EN`, `ZH`.
    static func badge(_ choice: String) -> String? {
        choice == auto ? nil : base(choice).uppercased()
    }

    /// A language's name in the reader's language: «العربية», "Arabic".
    static func name(_ tag: String, in language: String) -> String {
        let reader = Locale(identifier: language)
        let name = reader.localizedString(forIdentifier: tag) ?? reader.localizedString(forLanguageCode: base(tag)) ?? tag
        return name.prefix(1).uppercased() + name.dropFirst()
    }
}

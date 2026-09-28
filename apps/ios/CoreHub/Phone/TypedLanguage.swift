// The language of a keyboard that does not say which one it is typing in (owner, 2026-09-29: with
// Gboard, switching Arabic/English inside the keyboard left dictation in Arabic).
//
// iOS tells an app the language of Apple's keyboards, and follows every switch between them. A
// third-party keyboard (Gboard, SwiftKey…) is one keyboard to iOS: its input mode's
// `primaryLanguage` may be the one it declared once (often `mul`, or its first language), even
// though the keyboard can tell iOS its current language (`UIInputViewController.primaryLanguage`),
// which is why the empty composer's cursor moves to the right for Arabic and to the left for
// English. So for such a keyboard the language is taken, in this order, from:
// 1. its reading, once the same keyboard has been seen to change it (it reports its switches);
// 2. the side the cursor stands on in the empty composer: right-to-left or left-to-right, as one of
//    the person's languages written that way;
// 3. what is typed with it: the writing system of the last words, and between languages written
//    alike (English, French…) the one `NLLanguageRecognizer` finds among the person's languages;
// 4. the last language used (remembered by KeyboardLanguage).
// Apple's keyboards are still read directly, as before.
//
// The rules are here, apart from UIKit, so they are tested.
import Foundation
import NaturalLanguage

/// What the focused keyboard says about itself, and what has been typed with it since.
struct KeyboardEvidence: Equatable {
    /// An edit longer than this is not typing: a paste, a draft put back, dictated words.
    static let keystrokeLimit = 24
    /// How much of the latest typing is kept.
    static let typedLimit = 80

    /// The focused keyboard's `primaryLanguage`, as iOS gives it.
    private(set) var reading: String?
    /// The class of the focused keyboard's input mode (a third-party one is an extension's).
    private(set) var modeClass: String?
    /// The focused input mode object: the same one reporting another language is a keyboard that
    /// tells its switches.
    private(set) var mode: ObjectIdentifier?
    /// Input modes seen changing their language: their reading is trusted.
    private(set) var live: Set<ObjectIdentifier> = []
    /// Keystrokes since the keyboard was last switched whose letters are in another writing
    /// system than the keyboard says it types: a keyboard that switched languages on its own.
    private(set) var contradictions = 0
    /// The latest characters typed with the keyboard (keystrokes only), newest last.
    private(set) var typed = ""

    /// Notes the focused keyboard; true when it is another one, or says another language, than before.
    @discardableResult
    mutating func observe(reading: String?, modeClass: String?, mode: ObjectIdentifier? = nil) -> Bool {
        defer { self.mode = mode }
        guard reading != self.reading || modeClass != self.modeClass else { return false }
        if let mode, mode == self.mode, modeClass == self.modeClass,
           let before = DictationLanguage.tag(self.reading), let after = DictationLanguage.tag(reading),
           DictationLanguage.base(before) != DictationLanguage.base(after) {
            live.insert(mode)
        }
        self.reading = reading
        self.modeClass = modeClass
        contradictions = 0
        typed = ""
        return true
    }

    /// Notes an edit of the composer's text; true when letters were typed.
    @discardableResult
    mutating func edit(from old: String, to new: String) -> Bool {
        guard let keystroke = DictationLanguage.keystroke(from: old, to: new) else { return false }
        if keystroke.atEnd, keystroke.deleted > 0 {
            typed = String(typed.dropLast(min(keystroke.deleted, typed.count)))
        }
        guard !keystroke.inserted.isEmpty else { return false }
        typed = String((typed + keystroke.inserted).suffix(Self.typedLimit))
        guard let script = DictationLanguage.script(of: [keystroke.inserted], minimum: 1) else { return false }
        if let said = DictationLanguage.tag(reading),
           DictationLanguage.contradicts(typed: script, keyboard: DictationLanguage.script(ofLanguage: said)) {
            contradictions += 1
        }
        return true
    }

    /// Whether the keyboard's own reading cannot be trusted to follow its language.
    var thirdParty: Bool {
        DictationLanguage.isThirdPartyKeyboard(modeClass: modeClass, primaryLanguage: reading, contradictions: contradictions)
    }

    /// Whether the keyboard's reading says its language now: Apple's keyboards, and a
    /// third-party one seen changing it.
    var readingIsLive: Bool {
        !thirdParty || mode.map { live.contains($0) } ?? false
    }

    /// What the keyboard shows its language to be now, before anything typed is considered: its
    /// reading when that is live; else, in an empty composer, the cursor's side as one of the
    /// person's languages written that way (`preferring` first: what was typed or used last, then
    /// `known`). Nil when neither tells (emoji, text in the field): what was typed or used last
    /// stays.
    func shownLanguage(cursor: DictationLanguage.Direction?, preferring: [String], known: [String]) -> String? {
        if readingIsLive, let tag = DictationLanguage.tag(reading) { return tag }
        guard thirdParty, let cursor else { return nil }
        return DictationLanguage.language(written: cursor, preferring: preferring, known: known)
    }

    /// The language what was typed is in, for a keyboard whose reading is not live; nil for one
    /// whose reading is (it says the language itself) or when nothing tells.
    func typedLanguage(
        known: [String],
        guess: (_ text: String, _ among: [String]) -> String? = DictationLanguage.naturalGuess
    ) -> String? {
        guard !readingIsLive else { return DictationLanguage.tag(reading) }
        return DictationLanguage.typedLanguage(typed, known: known, guess: guess)
    }
}

extension DictationLanguage {
    /// Which way a line is written: where an empty field's cursor stands.
    enum Direction: Equatable {
        case leftToRight, rightToLeft
    }

    /// Whether a writing system runs right to left.
    static func isRightToLeft(_ script: Script) -> Bool {
        script == .arabic || script == .hebrew
    }

    /// The side the cursor stands on in an empty field `width` points wide; nil near the middle.
    static func cursorSide(caretMidX: Double, width: Double) -> Direction? {
        guard width > 0 else { return nil }
        let position = caretMidX / width
        if position < 0.35 { return .leftToRight }
        if position > 0.65 { return .rightToLeft }
        return nil
    }

    /// One of the person's languages written in `direction`: the first of `preferring` that is
    /// (what was typed or used last), else the first of `known` (keyboards, the phone's
    /// languages), else Arabic or English.
    static func language(written direction: Direction, preferring: [String], known: [String]) -> String {
        let rightToLeft = direction == .rightToLeft
        if let found = (preferring + known).compactMap(tag).first(where: { isRightToLeft(script(ofLanguage: $0)) == rightToLeft }) {
            return found
        }
        return rightToLeft ? "ar" : "en"
    }

    /// One edit of a text as a keystroke: what was deleted (a count) and inserted, and whether it
    /// was at the end. Nil for an edit too long to be typing, or no edit.
    struct Keystroke: Equatable {
        var deleted: Int
        var inserted: String
        var atEnd: Bool
    }

    static func keystroke(from old: String, to new: String) -> Keystroke? {
        let before = Array(old)
        let after = Array(new)
        var prefix = 0
        while prefix < before.count, prefix < after.count, before[prefix] == after[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < before.count - prefix, suffix < after.count - prefix,
              before[before.count - 1 - suffix] == after[after.count - 1 - suffix] {
            suffix += 1
        }
        let deleted = before.count - prefix - suffix
        let inserted = String(after[prefix..<(after.count - suffix)])
        guard deleted > 0 || !inserted.isEmpty,
              deleted <= KeyboardEvidence.keystrokeLimit, inserted.count <= KeyboardEvidence.keystrokeLimit
        else { return nil }
        return Keystroke(deleted: deleted, inserted: inserted, atEnd: suffix == 0)
    }

    /// Whether letters in `typed` could not have come from a keyboard that types `keyboard`.
    /// Keyboards that compose through Latin letters (Chinese Pinyin, Japanese Romaji, Korean,
    /// Hindi transliteration) show them while composing, and Japanese mixes kana with Han.
    static func contradicts(typed: Script, keyboard: Script) -> Bool {
        if typed == keyboard { return false }
        if typed == .latin, [.han, .kana, .hangul, .devanagari].contains(keyboard) { return false }
        if [typed, keyboard].allSatisfy({ $0 == .han || $0 == .kana }) { return false }
        return true
    }

    /// Whether the focused keyboard is one whose language iOS does not follow: an extension's
    /// input mode, a keyboard that declares no single language (`mul`, `und`, none), or one whose
    /// typing has twice been in another writing system than it declares (two keystrokes, so a
    /// single paste does not count).
    static func isThirdPartyKeyboard(modeClass: String?, primaryLanguage: String?, contradictions: Int) -> Bool {
        if let modeClass, modeClass.localizedCaseInsensitiveContains("extension") { return true }
        let raw = primaryLanguage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if raw.isEmpty || ["mul", "und"].contains(base(raw)) { return true }
        return contradictions >= 2
    }

    /// The script most letters of `texts` are written in; nil with fewer than `minimum` letters.
    static func script(of texts: [String], minimum: Int) -> Script? {
        var counts: [Script: Int] = [:]
        for text in texts {
            for scalar in text.unicodeScalars {
                guard let found = letterScript(scalar) else { continue }
                counts[found, default: 0] += 1
            }
        }
        if let kana = counts[.kana], kana > 0 {
            counts[.kana] = kana + (counts[.han] ?? 0)
            counts[.han] = nil
        }
        guard let best = counts.max(by: { $0.value < $1.value }), best.value >= minimum else { return nil }
        return best.key
    }

    /// The writing system of the latest words in `typed`, and those words (up to six, all in it):
    /// the last word with at least two letters decides.
    static func lastWords(_ typed: String) -> (script: Script, words: String)? {
        let words = typed.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).map(String.init)
        var script: Script?
        var kept: [String] = []
        for word in words.reversed() {
            guard let found = self.script(of: [word], minimum: script == nil ? 2 : 1) else { continue }
            if let script, found != script { break }
            script = found
            kept.insert(word, at: 0)
            if kept.count == 6 { break }
        }
        guard let script else { return nil }
        return (script, kept.joined(separator: " "))
    }

    /// The language of the latest words typed with a keyboard that does not say: their writing
    /// system; between the person's languages written in it (`known`: keyboards, then the phone's
    /// languages), the one `guess` finds; without one of theirs, the script's most spoken language.
    static func typedLanguage(
        _ typed: String,
        known: [String],
        guess: (_ text: String, _ among: [String]) -> String? = DictationLanguage.naturalGuess
    ) -> String? {
        guard let last = lastWords(typed) else { return nil }
        let script = last.script
        var seen = Set<String>()
        let mine = known.compactMap(tag)
            .filter { self.script(ofLanguage: $0) == script || (script == .han && base($0) == "ja") }
            .filter { seen.insert(base($0)).inserted }
        switch mine.count {
        case 0:
            return language(for: script, known: [])
        case 1:
            return mine[0]
        default:
            if let guessed = guess(last.words, mine.map(base)),
               let found = mine.first(where: { base($0) == base(guessed) }) {
                return found
            }
            return mine[0]
        }
    }

    /// The language `NLLanguageRecognizer` finds `text` written in, among `among` (base tags).
    static func naturalGuess(_ text: String, among: [String]) -> String? {
        let recognizer = NLLanguageRecognizer()
        recognizer.languageConstraints = among.flatMap { tag -> [NLLanguage] in
            base(tag) == "zh" ? [.simplifiedChinese, .traditionalChinese] : [NLLanguage(rawValue: base(tag))]
        }
        recognizer.processString(text)
        return recognizer.dominantLanguage.map { base($0.rawValue) }
    }

    /// The languages the recording bar's language mark switches between: the keyboards', the
    /// phone's, the last one used, and the one listening now — each once, only those the phone can
    /// recognize (`supported` empty: all), in a steady order so a tap steps through them all; at
    /// least two, topped up with popular ones; at most eight.
    static func switchOptions(
        listening: String?,
        keyboards: [String],
        preferred: [String],
        remembered: String?,
        supported: [String]
    ) -> [String] {
        var seen = Set<String>()
        var list: [String] = []
        func offer(_ raw: String?) {
            guard list.count < 8, let language = tag(raw) else { return }
            guard !seen.contains(base(language)) else { return }
            if !supported.isEmpty, match([language], supported: supported) == nil { return }
            seen.insert(base(language))
            list.append(language)
        }
        for language in keyboards + preferred { offer(language) }
        offer(remembered)
        if let listening, !seen.contains(base(listening)) {
            if list.count == 8 { list.removeLast() }
            offer(listening)
        }
        for language in popular where list.count < 2 { offer(language) }
        return list
    }

    /// The language after `listening` in `options` (a tap on the mark); the first when it is not
    /// among them; nil with nothing else to switch to.
    static func next(after listening: String?, in options: [String]) -> String? {
        guard let listening, let index = options.firstIndex(where: { base($0) == base(listening) }) else {
            return options.first
        }
        return options.count > 1 ? options[(index + 1) % options.count] : nil
    }
}

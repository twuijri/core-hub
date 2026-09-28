@testable import CoreHub
import XCTest

/// The language of a third-party keyboard, read from what is typed with it, and the recording
/// bar's language switch (docs/changes/2026-09-29-twuijri-ios-dictation-keyboard.md).
@MainActor
final class TypedLanguageTests: XCTestCase {
    private let supported = ["ar-SA", "ar-AE", "en-US", "en-GB", "fr-FR", "ru-RU", "zh-CN", "ja-JP", "es-ES", "es-MX"]
    private let apple = "UIKeyboardInputMode"
    private let extensionMode = "UIKeyboardExtensionInputMode"

    /// Types `text` one character at a time after `start`, as a keyboard does.
    private func type(_ text: String, into evidence: inout KeyboardEvidence, after start: String = "") -> String {
        var current = start
        for character in text {
            let next = current + String(character)
            evidence.edit(from: current, to: next)
            current = next
        }
        return current
    }

    func testAThirdPartyKeyboardIsAnExtensionOneWithoutALanguageOrOneThatTypesAnotherScript() {
        XCTAssertTrue(DictationLanguage.isThirdPartyKeyboard(modeClass: extensionMode, primaryLanguage: "en-US", contradictions: 0))
        XCTAssertTrue(DictationLanguage.isThirdPartyKeyboard(modeClass: apple, primaryLanguage: "mul", contradictions: 0))
        XCTAssertTrue(DictationLanguage.isThirdPartyKeyboard(modeClass: nil, primaryLanguage: nil, contradictions: 0))
        XCTAssertTrue(DictationLanguage.isThirdPartyKeyboard(modeClass: nil, primaryLanguage: "ar", contradictions: 2))
        XCTAssertFalse(DictationLanguage.isThirdPartyKeyboard(modeClass: apple, primaryLanguage: "ar", contradictions: 0))
        XCTAssertFalse(DictationLanguage.isThirdPartyKeyboard(modeClass: apple, primaryLanguage: "ar", contradictions: 1), "one paste is not enough")
        XCTAssertFalse(DictationLanguage.isThirdPartyKeyboard(modeClass: apple, primaryLanguage: "emoji", contradictions: 0))
    }

    func testOnlyAnotherScriptThanTheKeyboardCouldTypeContradictsIt() {
        XCTAssertTrue(DictationLanguage.contradicts(typed: .latin, keyboard: .arabic))
        XCTAssertTrue(DictationLanguage.contradicts(typed: .arabic, keyboard: .latin))
        XCTAssertFalse(DictationLanguage.contradicts(typed: .latin, keyboard: .latin))
        XCTAssertFalse(DictationLanguage.contradicts(typed: .latin, keyboard: .han), "Pinyin composes through Latin letters")
        XCTAssertFalse(DictationLanguage.contradicts(typed: .han, keyboard: .kana), "Japanese mixes Han with kana")
    }

    func testAnEditIsAKeystrokeOnlyWhenItIsShort() {
        XCTAssertEqual(DictationLanguage.keystroke(from: "hel", to: "hell"), .init(deleted: 0, inserted: "l", atEnd: true))
        XCTAssertEqual(DictationLanguage.keystroke(from: "hell", to: "hel"), .init(deleted: 1, inserted: "", atEnd: true))
        XCTAssertEqual(DictationLanguage.keystroke(from: "teh ", to: "the "), .init(deleted: 2, inserted: "he", atEnd: false))
        XCTAssertEqual(DictationLanguage.keystroke(from: "ac", to: "abc"), .init(deleted: 0, inserted: "b", atEnd: false))
        XCTAssertNil(DictationLanguage.keystroke(from: "", to: String(repeating: "pasted ", count: 5)), "a paste is not typing")
        XCTAssertNil(DictationLanguage.keystroke(from: String(repeating: "sent ", count: 10), to: ""), "sending clears; not typing")
        XCTAssertNil(DictationLanguage.keystroke(from: "same", to: "same"))
    }

    func testTheLastWordsTypedGiveTheirWritingSystem() {
        XCTAssertEqual(DictationLanguage.lastWords("hello كيف حالك")?.script, .arabic)
        XCTAssertEqual(DictationLanguage.lastWords("كيف حالك run the tests")?.script, .latin)
        XCTAssertEqual(DictationLanguage.lastWords("كيف حالك run the tests")?.words, "run the tests")
        XCTAssertEqual(DictationLanguage.lastWords("مرحبا a")?.script, .arabic, "a one-letter word does not decide")
        XCTAssertNil(DictationLanguage.lastWords("42 ✓ !"))
        XCTAssertNil(DictationLanguage.lastWords(""))
    }

    func testTheTypedLanguageIsOneOfThePersonsOwn() {
        let known = ["ar-SA", "en-US", "fr-FR"]
        XCTAssertEqual(DictationLanguage.typedLanguage("كيف حالك", known: known) { _, _ in nil }, "ar-SA")
        XCTAssertEqual(DictationLanguage.typedLanguage("hello there", known: known) { _, _ in nil }, "en-US", "the first Latin one")
        XCTAssertEqual(DictationLanguage.typedLanguage("merci beaucoup", known: known) { _, among in
            XCTAssertEqual(among, ["en", "fr"], "the guess chooses only among the person's languages")
            return "fr"
        }, "fr-FR")
        XCTAssertEqual(DictationLanguage.typedLanguage("hello", known: ["ar-SA"]) { _, _ in nil }, "en", "none of theirs: the usual one")
        XCTAssertEqual(DictationLanguage.typedLanguage("привет", known: []) { _, _ in nil }, "ru")
        XCTAssertNil(DictationLanguage.typedLanguage("", known: known) { _, _ in nil })
    }

    func testNaturalLanguageTellsFrenchFromEnglish() {
        XCTAssertEqual(
            DictationLanguage.typedLanguage("je voudrais un café avec du lait s'il vous plaît", known: ["en-US", "fr-FR"]),
            "fr-FR"
        )
        XCTAssertEqual(
            DictationLanguage.typedLanguage("please run the server tests again", known: ["fr-FR", "en-US"]),
            "en-US"
        )
    }

    /// The owner's case: Gboard, Arabic and English inside the one keyboard.
    func testGboardFollowsWhatIsTypedWithIt() {
        var evidence = KeyboardEvidence()
        XCTAssertTrue(evidence.observe(reading: "en-US", modeClass: extensionMode))
        let known = ["ar-SA", "en-US"]
        XCTAssertNil(evidence.typedLanguage(known: known), "nothing typed yet: the remembered language stays")
        var text = type("مرحبا", into: &evidence)
        XCTAssertEqual(evidence.typedLanguage(known: known) { _, _ in nil }, "ar-SA")
        text = type(" hello", into: &evidence, after: text)
        XCTAssertEqual(evidence.typedLanguage(known: known) { _, _ in nil }, "en-US")
        _ = type(" كيف", into: &evidence, after: text)
        XCTAssertEqual(evidence.typedLanguage(known: known) { _, _ in nil }, "ar-SA")
        XCTAssertFalse(evidence.observe(reading: "en-US", modeClass: extensionMode), "the same keyboard again is not news")
    }

    /// A keyboard whose class does not give it away, declaring one language and typing another.
    func testAKeyboardThatTypesAnotherScriptThanItDeclaresIsReadFromTheTyping() {
        var evidence = KeyboardEvidence()
        evidence.observe(reading: "ar", modeClass: "SomeInputMode")
        XCTAssertEqual(evidence.typedLanguage(known: ["ar-SA", "en-US"]), "ar")
        _ = type("hi there", into: &evidence)
        XCTAssertTrue(evidence.thirdParty)
        XCTAssertEqual(evidence.typedLanguage(known: ["ar-SA", "en-US"]) { _, _ in nil }, "en-US")
    }

    /// Apple's keyboards are read as before: a paste in another script does not change them.
    func testApplesKeyboardsStillSayTheirLanguage() {
        var evidence = KeyboardEvidence()
        evidence.observe(reading: "ar", modeClass: apple)
        evidence.edit(from: "", to: "hello there")
        XCTAssertFalse(evidence.thirdParty)
        XCTAssertEqual(evidence.typedLanguage(known: ["ar-SA", "en-US"]), "ar")
        XCTAssertEqual(
            evidence.shownLanguage(cursor: .leftToRight, preferring: ["en-US"], known: ["ar-SA", "en-US"]), "ar",
            "Apple's keyboard's reading comes first"
        )
        evidence.observe(reading: "zh-Hans", modeClass: apple)
        XCTAssertEqual(evidence.typed, "", "a switch of keyboard starts over")
        _ = type("nihao", into: &evidence)
        XCTAssertFalse(evidence.thirdParty, "Pinyin composing in Latin letters is still Chinese")
        XCTAssertEqual(evidence.shownLanguage(cursor: nil, preferring: [], known: []), "zh-CN")
        evidence.observe(reading: "emoji", modeClass: apple)
        XCTAssertNil(evidence.shownLanguage(cursor: .leftToRight, preferring: [], known: []), "emoji is no language: the remembered one stays")
    }

    /// First: a third-party keyboard whose reading follows its switches is read directly.
    func testAThirdPartyKeyboardSeenChangingItsReadingIsReadDirectly() {
        let gboard = NSObject()
        var evidence = KeyboardEvidence()
        evidence.observe(reading: "ar", modeClass: extensionMode, mode: ObjectIdentifier(gboard))
        XCTAssertFalse(evidence.readingIsLive, "one reading could be the one it declared once")
        XCTAssertNil(evidence.shownLanguage(cursor: nil, preferring: [], known: []))
        XCTAssertTrue(evidence.observe(reading: "en-US", modeClass: extensionMode, mode: ObjectIdentifier(gboard)))
        XCTAssertTrue(evidence.readingIsLive)
        XCTAssertEqual(evidence.shownLanguage(cursor: .rightToLeft, preferring: ["ar-SA"], known: ["ar-SA"]), "en-US")
        _ = type("مرحبا", into: &evidence)
        XCTAssertEqual(evidence.typedLanguage(known: ["ar-SA", "en-US"]), "en-US", "a live reading outranks the typing")
        evidence.observe(reading: "ar", modeClass: extensionMode, mode: ObjectIdentifier(gboard))
        XCTAssertEqual(evidence.shownLanguage(cursor: nil, preferring: [], known: []), "ar")

        let other = NSObject()
        var another = KeyboardEvidence()
        another.observe(reading: "ar", modeClass: extensionMode, mode: ObjectIdentifier(gboard))
        another.observe(reading: "en-US", modeClass: extensionMode, mode: ObjectIdentifier(other))
        XCTAssertFalse(another.readingIsLive, "another keyboard's reading is not a switch")
    }

    /// Second: the side of the empty composer's cursor, as one of the person's languages.
    func testTheEmptyComposersCursorSideGivesTheDirection() {
        XCTAssertEqual(DictationLanguage.cursorSide(caretMidX: 12, width: 300), .leftToRight)
        XCTAssertEqual(DictationLanguage.cursorSide(caretMidX: 290, width: 300), .rightToLeft)
        XCTAssertNil(DictationLanguage.cursorSide(caretMidX: 150, width: 300))
        XCTAssertNil(DictationLanguage.cursorSide(caretMidX: 0, width: 0))

        var evidence = KeyboardEvidence()
        evidence.observe(reading: "mul", modeClass: extensionMode)
        let known = ["ar-SA", "en-US", "fr-FR"]
        XCTAssertEqual(evidence.shownLanguage(cursor: .leftToRight, preferring: ["ar-SA"], known: known), "en-US")
        XCTAssertEqual(evidence.shownLanguage(cursor: .leftToRight, preferring: ["fr-FR"], known: known), "fr-FR", "the last one used, when it is written that way")
        XCTAssertEqual(evidence.shownLanguage(cursor: .rightToLeft, preferring: ["en-US"], known: known), "ar-SA")
        XCTAssertNil(evidence.shownLanguage(cursor: nil, preferring: ["en-US"], known: known), "text in the field: the typing tells")
        XCTAssertEqual(DictationLanguage.language(written: .rightToLeft, preferring: [], known: ["en-US", "he-IL"]), "he-IL")
        XCTAssertEqual(DictationLanguage.language(written: .rightToLeft, preferring: [], known: ["en-US"]), "ar")
        XCTAssertEqual(DictationLanguage.language(written: .leftToRight, preferring: [], known: ["ar-SA"]), "en")
    }

    func testTheMarkSwitchesBetweenThePersonsLanguagesInASteadyOrder() {
        let options = DictationLanguage.switchOptions(
            listening: "ar-SA", keyboards: ["ar", "emoji"], preferred: ["en-US", "ar-SA"], remembered: nil, supported: supported
        )
        XCTAssertEqual(options, ["ar", "en-US"])
        XCTAssertEqual(DictationLanguage.next(after: "ar-SA", in: options), "en-US")
        XCTAssertEqual(DictationLanguage.next(after: "en-US", in: options), "ar")

        let three = DictationLanguage.switchOptions(
            listening: "en-US", keyboards: ["ar", "en-US"], preferred: ["fr-FR"], remembered: nil, supported: supported
        )
        XCTAssertEqual(three, ["ar", "en-US", "fr-FR"])
        XCTAssertEqual(DictationLanguage.next(after: "en-US", in: three), "fr-FR")
        XCTAssertEqual(DictationLanguage.next(after: "fr-FR", in: three), "ar", "every language is reached")

        let alone = DictationLanguage.switchOptions(
            listening: "ar-SA", keyboards: ["sw"], preferred: ["ar-SA"], remembered: nil, supported: supported
        )
        XCTAssertEqual(alone, ["ar-SA", "en"], "one of theirs is topped up; one the phone cannot hear is left out")

        let elsewhere = DictationLanguage.switchOptions(
            listening: "es-MX", keyboards: ["ar"], preferred: ["en-US"], remembered: "fr-FR", supported: supported
        )
        XCTAssertEqual(elsewhere, ["ar", "en-US", "fr-FR", "es-MX"], "the language listening now is always there")
        XCTAssertNil(DictationLanguage.next(after: "ar", in: ["ar"]))
    }

    /// The last signal wins: a language picked on the recording bar, then typing.
    func testAPickedLanguageIsRememberedUntilMoreIsTyped() throws {
        let suite = "TypedLanguageTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let keyboard = KeyboardLanguage(defaults: defaults, focused: { nil })
        keyboard.remember("en_US")
        XCTAssertEqual(keyboard.current, "en-US")
        XCTAssertEqual(defaults.string(forKey: KeyboardLanguage.key), "en-US")
        XCTAssertEqual(KeyboardLanguage(defaults: defaults).current, "en-US", "kept for the next launch")
        var text = ""
        for character in "مرحبا" {
            keyboard.noteEdit(from: text, to: text + String(character))
            text += String(character)
        }
        let now = try XCTUnwrap(keyboard.current)
        XCTAssertEqual(DictationLanguage.base(now), "ar")
        keyboard.remember("en")
        XCTAssertEqual(keyboard.current, "en")
    }
}

@testable import CoreHub
import XCTest

/// Which language dictation listens in (docs/changes/2026-09-27-twuijri-mobile-voice-language.md).
@MainActor
final class DictationLanguageTests: XCTestCase {
    /// What `SFSpeechRecognizer.supportedLocales()` gives on an iPhone, in part.
    private let supported = ["ar-SA", "ar-AE", "en-US", "en-GB", "fr-FR", "fr-CA", "ru-RU", "hi-IN", "zh-CN", "zh-TW", "ja-JP", "es-ES", "es-MX"]

    func testAKeyboardsLanguageIsATagAndEmojiOrDictationIsNot() {
        XCTAssertEqual(DictationLanguage.tag("ar"), "ar")
        XCTAssertEqual(DictationLanguage.tag("en-US"), "en-US")
        XCTAssertEqual(DictationLanguage.tag("en_gb"), "en-GB")
        XCTAssertEqual(DictationLanguage.tag("zh-Hans"), "zh-CN")
        XCTAssertEqual(DictationLanguage.tag("zh-Hant"), "zh-TW")
        XCTAssertNil(DictationLanguage.tag("emoji"))
        XCTAssertNil(DictationLanguage.tag("dictation"))
        XCTAssertNil(DictationLanguage.tag("mul"))
        XCTAssertNil(DictationLanguage.tag(""))
        XCTAssertNil(DictationLanguage.tag(nil))
    }

    func testTheScriptOfTheConversationIsFoundFromItsLetters() {
        XCTAssertEqual(DictationLanguage.script(of: ["مرحبا، كيف حالك؟"]), .arabic)
        XCTAssertEqual(DictationLanguage.script(of: ["Run the tests please"]), .latin)
        XCTAssertEqual(DictationLanguage.script(of: ["Привет, как дела?"]), .cyrillic)
        XCTAssertEqual(DictationLanguage.script(of: ["नमस्ते दुनिया"]), .devanagari)
        XCTAssertEqual(DictationLanguage.script(of: ["你好世界"]), .han)
        XCTAssertEqual(DictationLanguage.script(of: ["こんにちは世界"]), .kana, "kana with Han is Japanese")
        XCTAssertEqual(DictationLanguage.script(of: ["안녕하세요"]), .hangul)
        // Mostly Arabic with a technical word in Latin letters is Arabic.
        XCTAssertEqual(DictationLanguage.script(of: ["شغل اختبارات server الآن"]), .arabic)
        XCTAssertNil(DictationLanguage.script(of: ["42 ✓", ""]), "too few letters to tell")
    }

    func testAScriptMapsToThePhonesOwnLanguageInIt() {
        XCTAssertEqual(DictationLanguage.language(for: .arabic, known: ["en-US"]), "ar")
        XCTAssertEqual(DictationLanguage.language(for: .arabic, known: ["en-US", "fa-IR"]), "fa-IR")
        XCTAssertEqual(DictationLanguage.language(for: .latin, known: ["ar-SA", "fr-FR"]), "fr-FR")
        XCTAssertEqual(DictationLanguage.language(for: .latin, known: ["ar-SA"]), "en")
        XCTAssertEqual(DictationLanguage.language(for: .cyrillic, known: ["uk-UA"]), "uk-UA")
        XCTAssertEqual(DictationLanguage.language(for: .cyrillic, known: []), "ru")
        XCTAssertEqual(DictationLanguage.language(for: .devanagari, known: ["mr-IN"]), "mr-IN")
        XCTAssertEqual(DictationLanguage.language(for: .han, known: ["ja-JP"]), "ja-JP")
        XCTAssertEqual(DictationLanguage.language(for: .han, known: []), "zh")
    }

    /// The owner's case: an English app, the Arabic keyboard up — Arabic, not English.
    func testAutoListensInTheKeyboardsLanguageNotTheAppsLanguage() {
        let languages = DictationLanguage.candidates(
            choice: DictationLanguage.auto, keyboard: "ar", recent: [], keyboards: ["en-US", "ar"],
            preferred: ["en-US"], app: "en"
        )
        XCTAssertEqual(languages.first, "ar")
        XCTAssertEqual(DictationLanguage.match(languages, supported: supported), "ar-SA")
    }

    func testWithoutAKeyboardTheConversationThenThePhoneThenTheAppDecide() {
        let fromChat = DictationLanguage.candidates(
            choice: DictationLanguage.auto, keyboard: nil, recent: ["أهلًا", "شغّل الاختبارات"],
            keyboards: [], preferred: ["en-US"], app: "en"
        )
        XCTAssertEqual(fromChat, ["ar", "en-US", "en"])
        let fromPhone = DictationLanguage.candidates(
            choice: DictationLanguage.auto, keyboard: nil, recent: [], keyboards: [], preferred: ["fr-CA", "en-US"], app: "ar"
        )
        XCTAssertEqual(fromPhone, ["fr-CA", "en-US", "ar"])
        let fromApp = DictationLanguage.candidates(
            choice: DictationLanguage.auto, keyboard: "emoji", recent: [], keyboards: [], preferred: [], app: "ar"
        )
        XCTAssertEqual(fromApp, ["ar"])
    }

    func testAChosenLanguageComesBeforeEverythingElse() {
        let languages = DictationLanguage.candidates(
            choice: "es-MX", keyboard: "ar", recent: ["hello there"], keyboards: [], preferred: ["en-US"], app: "en"
        )
        XCTAssertEqual(languages.first, "es-MX")
        XCTAssertEqual(DictationLanguage.match(languages, supported: supported), "es-MX")
    }

    func testTheRecognizersOwnLocaleIsMatched() {
        // The exact locale, else the language's usual region, else any region, else the next one.
        XCTAssertEqual(DictationLanguage.match(["en-GB"], supported: supported), "en-GB")
        XCTAssertEqual(DictationLanguage.match(["en"], supported: supported), "en-US")
        XCTAssertEqual(DictationLanguage.match(["fr-BE"], supported: supported), "fr-FR")
        XCTAssertEqual(DictationLanguage.match(["hi"], supported: supported), "hi-IN")
        XCTAssertEqual(DictationLanguage.match(["sw", "ru"], supported: supported), "ru-RU")
        XCTAssertEqual(DictationLanguage.match(["ar_SA"], supported: ["ar_SA", "en_US"]), "ar_SA")
        XCTAssertNil(DictationLanguage.match(["sw"], supported: supported))
    }

    func testTheMenuOffersTheKeyboardsThenPopularLanguagesEachOnce() {
        let menu = DictationLanguage.menu(keyboards: ["ar", "fr-FR", "emoji"], supported: nil)
        XCTAssertEqual(Array(menu.prefix(3)), ["ar", "fr-FR", "en"])
        XCTAssertEqual(menu.filter { DictationLanguage.base($0) == "ar" }.count, 1)
        XCTAssertTrue(menu.contains("es") && menu.contains("zh") && menu.contains("hi"), "not only Arabic and English")
        let phone = DictationLanguage.menu(keyboards: ["sw"], supported: supported)
        XCTAssertFalse(phone.contains("sw"), "a language the phone cannot recognize is not offered")
    }

    func testTheMicrophonesMarkNamesAChosenLanguageOnly() {
        XCTAssertNil(DictationLanguage.badge(DictationLanguage.auto))
        XCTAssertEqual(DictationLanguage.badge("ar"), "AR")
        XCTAssertEqual(DictationLanguage.badge("zh-TW"), "ZH")
    }

    func testStretchesOfDictationAreJoinedAndARestartIsNoticed() {
        XCTAssertEqual(Dictation.join("run the tests", "and tell me"), "run the tests and tell me")
        XCTAssertEqual(Dictation.join("", " hello "), "hello")
        XCTAssertTrue(Dictation.restarted(previous: "run the server tests", next: "and"))
        XCTAssertFalse(Dictation.restarted(previous: "run the server tests", next: "run the"))
        XCTAssertFalse(Dictation.restarted(previous: "hi", next: "h"))
        XCTAssertEqual(Dictation.level(decibels: -160), 0)
        XCTAssertEqual(Dictation.level(decibels: 0), 1)
        XCTAssertEqual(Dictation.level(decibels: .nan), 0)
    }
}

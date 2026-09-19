import XCTest
@testable import HermesStudio

/// Dictation language: preference resolution, the keyboard-derived default,
/// supported-locale filtering and ordering, the request wiring for both
/// transcription paths, and every fallback.
///
/// The reported bug: an English phone with an English app transcribed Arabic
/// speech as English, because the recogniser's locale followed the UI.
final class SpeechLanguageTests: XCTestCase {

    /// A realistic slice of `SFSpeechRecognizer.supportedLocales()`.
    private let supported: Set<String> = [
        "ar-SA", "en-US", "en-GB", "en-AU", "fr-FR", "de-DE", "tr-TR", "id-ID", "he-IL",
    ]

    // MARK: - Stored value → choice

    func testEmptyStorageMeansFollowTheKeyboards() {
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "", supported: supported), .keyboards)
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "   ", supported: supported), .keyboards)
    }

    func testMarkersResolveToTheirModes() {
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "app", supported: supported), .appLanguage)
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "server", supported: supported), .serverDetected)
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "SERVER", supported: supported), .serverDetected)
        // `auto` was the working name for the server option before the rename.
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "auto", supported: supported), .serverDetected)
    }

    func testAStoredLocaleIsKeptOnlyWhileTheRecogniserSupportsIt() {
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "ar-SA", supported: supported), .locale("ar-SA"))
        // Foundation writes identifiers with an underscore; Apple Speech uses a hyphen.
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "ar_SA", supported: supported), .locale("ar-SA"))
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "AR-sa", supported: supported), .locale("ar-SA"))
        // A locale this device cannot recognise never pins dictation.
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "ja-JP", supported: supported), .keyboards)
        XCTAssertEqual(SpeechLanguageResolver.choice(stored: "nonsense", supported: supported), .keyboards)
    }

    func testStoredRoundTripsThroughChoice() {
        for choice in [SpeechInputChoice.keyboards, .appLanguage, .serverDetected, .locale("en-GB")] {
            let stored = SpeechLanguageResolver.stored(for: choice)
            XCTAssertEqual(SpeechLanguageResolver.choice(stored: stored, supported: supported), choice, "\(choice)")
        }
    }

    // MARK: - The keyboard-derived default (the actual fix)

    func testAnArabicKeyboardOnAnEnglishPhoneDictatesArabic() {
        // The reported case: UI English, keyboards English + Arabic.
        let locale = SpeechLanguageResolver.keyboardLocale(keyboardLanguages: ["en-US", "ar", "emoji"],
                                                           supported: supported,
                                                           appLanguageCode: "en")
        XCTAssertEqual(locale, "ar-SA")
    }

    func testASingleKeyboardIsUsedEvenWhenItMatchesTheAppLanguage() {
        let locale = SpeechLanguageResolver.keyboardLocale(keyboardLanguages: ["en-US", "emoji", "dictation"],
                                                           supported: supported,
                                                           appLanguageCode: "en")
        XCTAssertEqual(locale, "en-US")
    }

    func testTheFirstKeyboardThatIsNotTheAppLanguageWins() {
        let locale = SpeechLanguageResolver.keyboardLocale(keyboardLanguages: ["en-US", "fr-FR", "ar"],
                                                           supported: supported,
                                                           appLanguageCode: "en")
        XCTAssertEqual(locale, "fr-FR")
    }

    func testEveryKeyboardInTheAppLanguageFallsBackToTheFirstOne() {
        let locale = SpeechLanguageResolver.keyboardLocale(keyboardLanguages: ["en-GB", "en-US"],
                                                           supported: supported,
                                                           appLanguageCode: "en")
        XCTAssertEqual(locale, "en-GB")
    }

    func testNonLanguageInputModesAreIgnored() {
        XCTAssertNil(SpeechLanguageResolver.keyboardLocale(keyboardLanguages: ["emoji", "dictation", ""],
                                                           supported: supported,
                                                           appLanguageCode: "en"))
    }

    func testAKeyboardWithNoSupportedRecogniserIsSkipped() {
        let locale = SpeechLanguageResolver.keyboardLocale(keyboardLanguages: ["ja-JP", "ar"],
                                                           supported: supported,
                                                           appLanguageCode: "en")
        XCTAssertEqual(locale, "ar-SA")
    }

    func testAKeyboardLanguageWithoutARegionPicksThePreferredRegion() {
        XCTAssertEqual(SpeechLanguageResolver.supportedLocale(matching: "ar", in: supported), "ar-SA")
        XCTAssertEqual(SpeechLanguageResolver.supportedLocale(matching: "en", in: supported), "en-US")
        // An exact match always wins over the preferred region of that language.
        XCTAssertEqual(SpeechLanguageResolver.supportedLocale(matching: "en-GB", in: supported), "en-GB")
        // A region the recogniser lacks still resolves to that language.
        XCTAssertEqual(SpeechLanguageResolver.supportedLocale(matching: "ar-EG", in: supported), "ar-SA")
        XCTAssertNil(SpeechLanguageResolver.supportedLocale(matching: "emoji", in: supported))
        XCTAssertNil(SpeechLanguageResolver.supportedLocale(matching: "ja-JP", in: supported))
    }

    // MARK: - Choice → plan (both transcription paths)

    private func plan(_ choice: SpeechInputChoice,
                      appLanguage: String = "en",
                      system: String = "en_US",
                      keyboards: [String] = ["en-US", "ar"]) -> SpeechLanguagePlan {
        SpeechLanguageResolver.plan(for: choice, appLanguage: appLanguage, systemLocaleIdentifier: system,
                                    keyboardLanguages: keyboards, supported: supported)
    }

    func testTheDefaultPlanSendsTheKeyboardLanguageDownBothPaths() {
        let resolved = plan(.keyboards)
        XCTAssertEqual(resolved.deviceLocaleIdentifier, "ar-SA")
        XCTAssertEqual(resolved.serverLanguageHint, "ar")
        XCTAssertEqual(resolved.fallbackLocaleIdentifier, "ar-SA")
        XCTAssertFalse(resolved.requiresServer)
    }

    func testTheDefaultFallsBackToTheAppLanguageWhenNoKeyboardIsUsable() {
        let resolved = plan(.keyboards, appLanguage: "ar", keyboards: ["emoji"])
        XCTAssertEqual(resolved.deviceLocaleIdentifier, "ar-SA")
        XCTAssertEqual(resolved.serverLanguageHint, "ar")
    }

    func testTheAppLanguageModeKeepsTheOldBehaviour() {
        XCTAssertEqual(plan(.appLanguage, appLanguage: "ar").deviceLocaleIdentifier, "ar-SA")
        XCTAssertEqual(plan(.appLanguage, appLanguage: "en").deviceLocaleIdentifier, "en-US")
        // "system": the phone's own locale, with Foundation's underscore spelling.
        XCTAssertEqual(plan(.appLanguage, appLanguage: "system", system: "tr_TR").deviceLocaleIdentifier, "tr-TR")
        XCTAssertEqual(plan(.appLanguage, appLanguage: "system", system: "tr_TR").serverLanguageHint, "tr")
    }

    func testAPinnedLocaleReachesBothPaths() {
        let resolved = plan(.locale("he-IL"))
        XCTAssertEqual(resolved.deviceLocaleIdentifier, "he-IL")
        XCTAssertEqual(resolved.serverLanguageHint, "he")
        XCTAssertFalse(resolved.requiresServer)
    }

    func testServerDetectionSendsNoHintAndKeepsADeviceFallback() {
        let resolved = plan(.serverDetected)
        XCTAssertNil(resolved.deviceLocaleIdentifier)
        XCTAssertNil(resolved.serverLanguageHint)
        XCTAssertTrue(resolved.requiresServer)
        // The fallback is the keyboard default, so a failed server attempt can
        // still dictate the language the owner actually types in.
        XCTAssertEqual(resolved.fallbackLocaleIdentifier, "ar-SA")
    }

    func testOnlyServerDetectionEverRequiresTheServer() {
        XCTAssertFalse(plan(.keyboards).requiresServer)
        XCTAssertFalse(plan(.appLanguage).requiresServer)
        XCTAssertFalse(plan(.locale("fr-FR")).requiresServer)
        XCTAssertTrue(plan(.serverDetected).requiresServer)
    }

    // MARK: - The multipart fields that actually go out

    func testTheHintIsOmittedFromTheUploadWhenTheServerShouldDetect() {
        let fields = APIClient.sttFormFields(provider: "openai", language: plan(.serverDetected).serverLanguageHint)
        XCTAssertEqual(fields, ["provider": "openai"])
    }

    func testTheHintTravelsWithTheUploadForAPinnedLanguage() {
        let fields = APIClient.sttFormFields(provider: "openai", language: plan(.locale("ar-SA")).serverLanguageHint)
        XCTAssertEqual(fields, ["provider": "openai", "language": "ar"])
    }

    // MARK: - Supported-locale filtering and ordering

    func testOnlyLocalesTheRecogniserReportsAreOffered() {
        let options = SpeechLocaleCatalog.options(from: [Locale(identifier: "ar-SA"), Locale(identifier: "fr-FR")])
        XCTAssertEqual(options.map(\.identifier), ["ar-SA", "fr-FR"])
        XCTAssertFalse(options.contains { $0.identifier == "ja-JP" })
    }

    func testIdentifiersAreNormalisedAndDeduplicated() {
        let options = SpeechLocaleCatalog.options(from: [Locale(identifier: "ar_SA"), Locale(identifier: "ar-SA")])
        XCTAssertEqual(options.map(\.identifier), ["ar-SA"])
    }

    func testArabicComesFirstThenEnglishThenTheRest() {
        let locales = Set(["de-DE", "en-GB", "en-US", "ar-SA", "fr-FR", "tr-TR"].map(Locale.init(identifier:)))
        let order = SpeechLocaleCatalog.options(from: locales).map(\.identifier)
        XCTAssertEqual(order.prefix(3).map { $0 }, ["ar-SA", "en-US", "en-GB"])
        XCTAssertEqual(Set(order.suffix(3)), ["de-DE", "fr-FR", "tr-TR"])
        XCTAssertEqual(order.count, 6)
    }

    func testEachLocaleIsNamedInItsOwnLanguage() {
        // The endonym, not the UI language's name for it: an Arabic speaker on
        // an English phone must recognise his own language in the list.
        XCTAssertTrue(SpeechLocaleCatalog.endonym(for: "ar-SA").contains("الع"))
        XCTAssertTrue(SpeechLocaleCatalog.endonym(for: "en-US").lowercased().contains("english"))
        // An identifier with no name known to ICU still renders as something.
        XCTAssertFalse(SpeechLocaleCatalog.endonym(for: "zz-ZZ").isEmpty)
        XCTAssertEqual(SpeechLocaleCatalog.endonym(for: ""), "")
    }

    // MARK: - Recently used languages

    func testTheLastPickedLanguageIsRememberedFirst() {
        var history = SpeechLanguageHistory.updated([], picking: "ar-SA")
        XCTAssertEqual(history, ["ar-SA"])
        history = SpeechLanguageHistory.updated(history, picking: "fr-FR")
        XCTAssertEqual(history, ["fr-FR", "ar-SA"])
        // Picking a remembered language moves it back to the front, never duplicates it.
        history = SpeechLanguageHistory.updated(history, picking: "ar_SA")
        XCTAssertEqual(history, ["ar-SA", "fr-FR"])
    }

    func testTheHistoryIsCapped() {
        var history: [String] = []
        for identifier in ["ar-SA", "en-US", "fr-FR", "de-DE"] {
            history = SpeechLanguageHistory.updated(history, picking: identifier)
        }
        XCTAssertEqual(history, ["de-DE", "fr-FR", "en-US"])
        XCTAssertEqual(history.count, SpeechLanguageHistory.limit)
    }

    func testTheHistoryHidesLanguagesTheRecogniserNoLongerSupports() {
        let visible = SpeechLanguageHistory.visible(["ja-JP", "ar_SA", "ar-SA", ""], supported: supported)
        XCTAssertEqual(visible, ["ar-SA"])
    }

    // MARK: - Labels

    func testTheFollowModesNameTheLanguageTheyResolveTo() {
        let keyboard = SpeechLanguageLabel.summary(for: .keyboards, resolvedLocaleIdentifier: "ar-SA")
        XCTAssertTrue(keyboard.contains(SpeechLocaleCatalog.endonym(for: "ar-SA")))
        let app = SpeechLanguageLabel.summary(for: .appLanguage, resolvedLocaleIdentifier: "en-US")
        XCTAssertTrue(app.contains(SpeechLocaleCatalog.endonym(for: "en-US")))
        XCTAssertEqual(SpeechLanguageLabel.summary(for: .locale("fr-FR"), resolvedLocaleIdentifier: "fr-FR"),
                       SpeechLocaleCatalog.endonym(for: "fr-FR"))
    }

    func testTheRecordingStripNamesTheLanguageOrSaysTheServerIsListening() {
        XCTAssertEqual(SpeechLanguageLabel.active(for: .keyboards, plan: plan(.keyboards)),
                       SpeechLocaleCatalog.endonym(for: "ar-SA"))
        // The server option is labelled, never a silent detour off the device.
        let server = SpeechLanguageLabel.active(for: .serverDetected, plan: plan(.serverDetected))
        XCTAssertNotEqual(server, SpeechLocaleCatalog.endonym(for: "ar-SA"))
        XCTAssertFalse(server.isEmpty)
    }

    // MARK: - The occasional "long-press the mic" hint

    func testTheHintIsShownOnEveryOneOfTheFirstRecordings() {
        for count in 0..<DictationHintPolicy.firstRecordings {
            XCTAssertTrue(DictationHintPolicy.shouldShow(recordingCount: count, longPressUsed: false),
                          "recording \(count)")
        }
    }

    func testAfterTheFirstRecordingsTheHintOnlyReturnsOccasionally() {
        // Recordings 4 to 7 (counts 3…6) stay quiet, then it comes back.
        for count in DictationHintPolicy.firstRecordings..<DictationHintPolicy.occasionalPeriod {
            XCTAssertFalse(DictationHintPolicy.shouldShow(recordingCount: count, longPressUsed: false),
                           "recording \(count)")
        }
        XCTAssertTrue(DictationHintPolicy.shouldShow(recordingCount: 7, longPressUsed: false))
        XCTAssertTrue(DictationHintPolicy.shouldShow(recordingCount: 14, longPressUsed: false))
        XCTAssertTrue(DictationHintPolicy.shouldShow(recordingCount: 21, longPressUsed: false))
    }

    func testTheGapsBetweenHintsStayInTheFifthToTenthRange() {
        let shown = (0..<40).filter { DictationHintPolicy.shouldShow(recordingCount: $0, longPressUsed: false) }
        XCTAssertEqual(Array(shown.prefix(6)), [0, 1, 2, 7, 14, 21])
        // From the last of the opening run onwards: 2 → 7 is five, then seven.
        let tail = shown.dropFirst(DictationHintPolicy.firstRecordings - 1)
        let gaps = zip(tail, tail.dropFirst()).map { $1 - $0 }
        XCTAssertFalse(gaps.isEmpty)
        for gap in gaps { XCTAssertTrue((5...10).contains(gap), "gap \(gap)") }
    }

    func testTheHintStopsForeverOnceTheLongPressHasBeenUsed() {
        for count in [0, 1, 2, 7, 14, 700] {
            XCTAssertFalse(DictationHintPolicy.shouldShow(recordingCount: count, longPressUsed: true),
                           "recording \(count)")
        }
    }

    func testANegativeOrMissingCountIsTreatedAsTheFirstRecording() {
        XCTAssertTrue(DictationHintPolicy.shouldShow(recordingCount: -1, longPressUsed: false))
        XCTAssertFalse(DictationHintPolicy.shouldShow(recordingCount: -1, longPressUsed: true))
    }

    // MARK: - Helpers

    func testLanguageCodeTakesTheFirstSubtag() {
        XCTAssertEqual(SpeechLanguageResolver.languageCode(of: "ar-SA"), "ar")
        XCTAssertEqual(SpeechLanguageResolver.languageCode(of: "AR_sa"), "ar")
        XCTAssertEqual(SpeechLanguageResolver.languageCode(of: "yue-Hans-CN"), "yue")
        XCTAssertNil(SpeechLanguageResolver.languageCode(of: ""))
    }
}

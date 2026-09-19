import SwiftUI
import XCTest
@testable import HermesStudio

/// The pure half of `docs/CONTENT-DIRECTION.md` on iOS: first-strong
/// direction per string, with the interface direction as the only fallback.
/// The views are not tested here — `ContentDirection.resolve` is what every
/// composer, bubble and title feeds.
final class ContentDirectionTests: XCTestCase {

    // MARK: - The three cases from the report

    func testArabicOnlyTextIsRightToLeftInsideAnEnglishInterface() {
        XCTAssertEqual(ContentDirection.resolve("مرحبا بك في كور هَب", interface: .leftToRight), .rightToLeft)
        XCTAssertEqual(ContentDirection.resolve("السلام عليكم", interface: .leftToRight), .rightToLeft)
    }

    func testLatinOnlyTextIsLeftToRightInsideAnArabicInterface() {
        XCTAssertEqual(ContentDirection.resolve("Deploy the test stack", interface: .rightToLeft), .leftToRight)
        XCTAssertEqual(ContentDirection.resolve("core-hub", interface: .rightToLeft), .leftToRight)
    }

    func testMixedTextFollowsItsFirstStrongCharacterNotTheDominantLanguage() {
        // Arabic first, Latin term inside: right-to-left, both interfaces.
        let arabicFirst = "شغّل الأمر npm run build ثم ارفع النتيجة"
        XCTAssertEqual(ContentDirection.resolve(arabicFirst, interface: .leftToRight), .rightToLeft)
        XCTAssertEqual(ContentDirection.resolve(arabicFirst, interface: .rightToLeft), .rightToLeft)

        // Latin first and mostly Arabic afterwards: still left-to-right. The
        // contract is explicit that this is not a "dominant language" guess.
        let latinFirst = "Xcode لا يعمل على هذا الجهاز ولا يمكن بناء التطبيق محليًا"
        XCTAssertEqual(ContentDirection.resolve(latinFirst, interface: .leftToRight), .leftToRight)
        XCTAssertEqual(ContentDirection.resolve(latinFirst, interface: .rightToLeft), .leftToRight)
    }

    // MARK: - What is *not* a direction signal

    func testTextWithNoStrongCharacterKeepsTheInterfaceDirection() {
        for neutral in ["", "   ", "2026-09-19", "45.0k / 256.0k", "…", "1 + 2 = 3", "🎤🎤"] {
            XCTAssertEqual(ContentDirection.resolve(neutral, interface: .rightToLeft), .rightToLeft, neutral)
            XCTAssertEqual(ContentDirection.resolve(neutral, interface: .leftToRight), .leftToRight, neutral)
            XCTAssertNil(ContentDirection.firstStrong(neutral), neutral)
        }
    }

    func testDigitsAndPunctuationAreNotEvidenceOfDirection() {
        // Latin and Arabic-Indic digits are both neutral: the letter decides.
        XCTAssertEqual(ContentDirection.resolve("123 مرحبا", interface: .leftToRight), .rightToLeft)
        XCTAssertEqual(ContentDirection.resolve("١٢٣ hello", interface: .rightToLeft), .leftToRight)
        XCTAssertEqual(ContentDirection.resolve("«Hello»", interface: .rightToLeft), .leftToRight)
        XCTAssertEqual(ContentDirection.resolve("؟ مرحبا", interface: .leftToRight), .rightToLeft)
    }

    func testCombiningMarksAndFormatCharactersAreNotStrong() {
        // A leading byte-order mark used to make any string right-to-left,
        // because U+FEFF sits inside the Arabic presentation-forms range.
        XCTAssertEqual(ContentDirection.resolve("\u{FEFF}Hello", interface: .leftToRight), .leftToRight)
        // A bare Arabic diacritic (U+0651 shadda) is a combining mark, and
        // `CharacterSet.letters` counts marks as letters — the reason the
        // general category is checked directly.
        XCTAssertNil(ContentDirection.firstStrong("\u{0651}"))
        XCTAssertEqual(ContentDirection.resolve("\u{0651}Hello", interface: .leftToRight), .leftToRight)
        // The same mark attached to an Arabic letter stays right-to-left.
        XCTAssertEqual(ContentDirection.resolve("مُشَدَّد", interface: .leftToRight), .rightToLeft)
    }

    func testHebrewAndOtherRightToLeftScriptsResolveRightToLeft() {
        XCTAssertEqual(ContentDirection.resolve("שלום", interface: .leftToRight), .rightToLeft)
        XCTAssertEqual(ContentDirection.resolve("ܫܠܡܐ", interface: .leftToRight), .rightToLeft)
    }

    // MARK: - The markdown renderer shares the one rule

    func testMarkdownHelperStillAnswersForTheSameStrings() {
        XCTAssertEqual(MarkdownText.layoutDirection(for: "مرحبا"), .rightToLeft)
        XCTAssertEqual(MarkdownText.layoutDirection(for: "1. **First task**"), .leftToRight)
        // No interface to inherit from: a neutral string stays left-to-right.
        XCTAssertEqual(MarkdownText.layoutDirection(for: "2026-09-19"), .leftToRight)
    }
}

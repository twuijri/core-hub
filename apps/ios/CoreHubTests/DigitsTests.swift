@testable import CoreHub
import Foundation
import XCTest

/// Latin digits (123) in the Arabic UI too (owner, 2026-09-26, DECISIONS §113): dates, durations,
/// sizes and counts keep their Arabic words but never show Arabic-Indic digits.
final class DigitsTests: XCTestCase {
    private let eastern = CharacterSet(charactersIn: "\u{0660}"..."\u{0669}").union(CharacterSet(charactersIn: "\u{06F0}"..."\u{06F9}"))
    private let arabicLetters = CharacterSet(charactersIn: "\u{0621}"..."\u{064A}")

    private func hasEastern(_ text: String) -> Bool { text.unicodeScalars.contains { eastern.contains($0) } }
    private func hasArabic(_ text: String) -> Bool { text.unicodeScalars.contains { arabicLetters.contains($0) } }

    private func number(_ value: Int, _ locale: Locale) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        return formatter.string(from: NSNumber(value: value)) ?? ""
    }

    func testAnArabicRegionWithoutTheKeywordWouldPrintArabicIndicDigits() {
        XCTAssertTrue(hasEastern(number(43, Locale(identifier: "ar_EG"))))
        XCTAssertEqual(number(43, Locale(identifier: "ar_EG").latinDigits), "43")
        XCTAssertEqual(number(43, AppLanguage.ar.locale), "43")
        XCTAssertEqual(AppLanguage.ar.locale.language.languageCode?.identifier, "ar")
    }

    func testArabicDatesDurationsAndSizesKeepArabicWordsWithLatinDigits() {
        let when = Date(timeIntervalSince1970: 1_790_000_000)
        let date = when.shortText(.ar)
        XCTAssertFalse(hasEastern(date), date)
        XCTAssertTrue(hasArabic(date), date)
        let duration = ToolsFormat.duration(2_590, language: .ar)
        XCTAssertFalse(hasEastern(duration), duration)
        XCTAssertTrue(duration.contains("43"), duration)
        let size = Int64(3_400_000).formatted(ByteCountFormatStyle(style: .file, locale: Locale(identifier: "ar_EG").latinDigits))
        XCTAssertFalse(hasEastern(size), size)
        XCTAssertFalse(hasEastern(AttachmentRules.size(3_400_000)))
        XCTAssertFalse(hasEastern(ToolsFormat.bytes(3_400_000)))
    }
}

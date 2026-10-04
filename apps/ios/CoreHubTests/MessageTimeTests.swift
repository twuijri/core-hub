// When a message was said, under it after a light tap (tester feedback, 2026-10-05): the clock time
// today, «Yesterday» and the time yesterday, the short date and the time before that, digits Latin
// in every language. The web's messageTime and Android's MessageTimeTest check the same rule.
@testable import CoreHub
import XCTest

final class MessageTimeTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Riyadh")!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    private var now: Date { date(2026, 10, 5, 18, 30) }
    private let english = Locale(identifier: "en_GB")

    private func text(_ when: Date, _ locale: Locale, _ yesterday: String = "Yesterday") -> String {
        MessageTime.text(when, now: now, locale: locale, calendar: calendar) { "\(yesterday) \($0)" }
    }

    func testTodayIsOnlyTheClockTime() {
        XCTAssertEqual(text(date(2026, 10, 5, 0, 5), english), "00:05")
    }

    func testYesterdaySaysSoBeforeTheTime() {
        XCTAssertEqual(text(date(2026, 10, 4, 23, 50), english), "Yesterday 23:50")
    }

    func testOlderShowsTheShortDateAndTheYearOnlyWhenItDiffers() {
        let thisYear = text(date(2026, 10, 3, 14, 5), english)
        XCTAssertTrue(thisYear.contains("3 Oct"), thisYear)
        XCTAssertTrue(thisYear.contains("14:05"), thisYear)
        XCTAssertFalse(thisYear.contains("2026"), thisYear)
        let lastYear = text(date(2025, 12, 31, 8, 0), english)
        XCTAssertTrue(lastYear.contains("2025"), lastYear)
    }

    func testArabicKeepsItsWordsWithLatinDigits() {
        let arabic = AppLanguage.ar.locale
        for when in [date(2026, 10, 5, 9, 7), date(2026, 10, 4, 9, 7), date(2025, 1, 2, 9, 7)] {
            let shown = text(when, arabic, "أمس")
            XCTAssertNil(shown.range(of: "[٠-٩۰-۹]", options: .regularExpression), shown)
            XCTAssertTrue(shown.contains("9:07"), shown)
        }
        XCTAssertTrue(text(date(2026, 10, 4, 9, 7), arabic, "أمس").hasPrefix("أمس"))
    }

    func testYesterdayIsWordedInBothLanguages() {
        XCTAssertEqual(L10n(.en)("chat.time_yesterday", ["time": "09:07"]), "Yesterday 09:07")
        XCTAssertEqual(L10n(.ar)("chat.time_yesterday", ["time": "09:07"]), "أمس 09:07")
    }
}

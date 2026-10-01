// Swipe a message to reply (DECISIONS §150): toward the reading start — left in English, right in
// Arabic, away from the interactive back swipe — only on a mostly horizontal start, with the
// bubble resisting past the threshold. Android's SwipeToReplyUiTest.kt checks the same rules and
// drives the gesture; SwiftUI's gesture itself is left to the device proof.
@testable import CoreHub
import SwiftUI
import XCTest

final class SwipeToReplyTests: XCTestCase {
    func testDirectionMirrorsWithTheLayout() {
        XCTAssertEqual(SwipeReplyRules.direction(.leftToRight), -1)
        XCTAssertEqual(SwipeReplyRules.direction(.rightToLeft), 1)
    }

    func testOnlyAMostlyHorizontalStartTowardTheReadingStartIsASwipe() {
        XCTAssertTrue(SwipeReplyRules.startsSwipe(dx: -30, dy: 5, direction: -1))
        XCTAssertTrue(SwipeReplyRules.startsSwipe(dx: 30, dy: -5, direction: 1))
        // A scroll that leans sideways stays a scroll.
        XCTAssertFalse(SwipeReplyRules.startsSwipe(dx: -30, dy: 25, direction: -1))
        // Toward the back gesture's side: never.
        XCTAssertFalse(SwipeReplyRules.startsSwipe(dx: 30, dy: 0, direction: -1))
        XCTAssertFalse(SwipeReplyRules.startsSwipe(dx: -30, dy: 0, direction: 1))
    }

    func testTheBubbleFollowsTheFingerThenResistsAndStops() {
        XCTAssertEqual(SwipeReplyRules.offset(for: -10), 0)
        XCTAssertEqual(SwipeReplyRules.offset(for: 40), 40)
        XCTAssertEqual(SwipeReplyRules.offset(for: SwipeReplyRules.threshold), SwipeReplyRules.threshold)
        XCTAssertEqual(SwipeReplyRules.offset(for: 90), 70)
        XCTAssertEqual(SwipeReplyRules.offset(for: 400), SwipeReplyRules.limit)
    }

    func testTheReplyActionIsNamedInBothLanguages() {
        XCTAssertEqual(L10n(.en)("chat_controls.reply_action"), "Reply")
        XCTAssertEqual(L10n(.ar)("chat_controls.reply_action"), "ردّ")
    }
}

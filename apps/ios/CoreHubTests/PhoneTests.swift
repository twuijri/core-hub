@testable import CoreHub
import CoreHubClient
import XCTest

final class PhoneTests: XCTestCase {
    private func suite(_ name: String) -> UserDefaults {
        let defaults = UserDefaults(suiteName: "corehub.tests.\(name)")!
        defaults.removePersistentDomain(forName: "corehub.tests.\(name)")
        return defaults
    }

    func testANoticeLeadsToItsConversationInItsProfile() {
        let notice = Notice(
            id: "n1", userId: "u1", profile: "work", kind: .runCompleted, title: "Hermes finished",
            body: "…", resource: ResourceRef(kind: .session, id: "s1"), createdAt: Fixture.date
        )
        let info = NoticeRouting.userInfo(for: notice)
        XCTAssertEqual(info[NoticeRouting.sessionKey], "s1")
        XCTAssertEqual(info[NoticeRouting.profileKey], "work")
        XCTAssertEqual(
            NoticeRouting.route(kind: info[NoticeRouting.kindKey], sessionID: info[NoticeRouting.sessionKey], profile: info[NoticeRouting.profileKey], selector: "default"),
            .chat(sessionID: "s1", profile: "work")
        )
        XCTAssertEqual(NoticeRouting.route(kind: "task", sessionID: nil, profile: nil, selector: "x"), .destination(.tasks))
        XCTAssertEqual(NoticeRouting.route(kind: "schedule_run", sessionID: nil, profile: nil, selector: "x"), .destination(.schedules))
        XCTAssertNil(NoticeRouting.route(kind: "update", sessionID: nil, profile: nil, selector: "x"))
    }

    func testEachNoticeIsShownOnceWhicheverPathSawItFirst() {
        var posted: [String] = []
        XCTAssertTrue(NoticeRouting.isNew("n1", posted: posted))
        posted = NoticeRouting.remember("n1", in: posted)
        XCTAssertFalse(NoticeRouting.isNew("n1", posted: posted))
        for i in 0..<400 { posted = NoticeRouting.remember("x\(i)", in: posted) }
        XCTAssertEqual(posted.count, 300)
        XCTAssertEqual(posted.last, "x399")
        XCTAssertTrue(NoticeRouting.isNew("n1", posted: posted), "only the last 300 are kept")
    }

    func testSharedTextWaitsOnceForTheApp() {
        let defaults = suite("share")
        XCTAssertNil(ShareInbox.take(from: defaults))
        ShareInbox.put(ShareInbox.compose(["  https://example.com/a  ", "", "look at this", "https://example.com/a"]), in: defaults)
        ShareInbox.put("and this", in: defaults)
        XCTAssertEqual(ShareInbox.take(from: defaults), "https://example.com/a\nlook at this\nand this")
        XCTAssertNil(ShareInbox.take(from: defaults), "taking empties the inbox")
        XCTAssertNil(ShareInbox.take(from: nil))
    }

    @MainActor
    func testThisDevicesChoicesPersistAndPickTheDictationLanguage() {
        let defaults = suite("device")
        let settings = DeviceSettings(defaults: defaults)
        XCTAssertTrue(settings.voiceInput)
        XCTAssertFalse(settings.spokenReplies)
        XCTAssertTrue(settings.backgroundChecks)
        XCTAssertEqual(settings.dictationLocale(app: .ar).identifier, "ar-SA")
        settings.dictationLanguage = .en
        settings.spokenReplies = true
        let again = DeviceSettings(defaults: defaults)
        XCTAssertEqual(again.dictationLanguage, .en)
        XCTAssertTrue(again.spokenReplies)
        XCTAssertEqual(again.dictationLocale(app: .ar).identifier, "en-US")
    }

    func testARepliesSpokenWordsLeaveMarkdownAndCodeOut() {
        let reply = """
        ## Done
        I ran **the tests**:
        ```sh
        pnpm test
        ```
        All `green`.
        """
        let spoken = Voice.speakable(reply)
        XCTAssertFalse(spoken.contains("pnpm"))
        XCTAssertFalse(spoken.contains("**"))
        XCTAssertFalse(spoken.contains("`"))
        XCTAssertTrue(spoken.contains("the tests"))
        XCTAssertTrue(spoken.contains("green"))
    }
}

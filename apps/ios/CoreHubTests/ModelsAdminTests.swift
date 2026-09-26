@testable import CoreHub
import CoreHubClient
import XCTest

/// Models and the admin pages on the phone (group 5): the rules behind them.
final class ModelsAdminTests: XCTestCase {
    private let a = ModelRef(providerId: "p1", model: "gpt-a")
    private let b = ModelRef(providerId: "p1", model: "gpt-b")
    private let c = ModelRef(providerId: "p2", model: "claude-c")

    func testFallbacksMoveByDragAreAddedOnceAndNeverRepeatTheDefault() {
        XCTAssertEqual(ModelLogic.move([a, b, c], from: IndexSet(integer: 0), to: 3).map(\.model), ["gpt-b", "claude-c", "gpt-a"])
        XCTAssertEqual(ModelLogic.move([a, b, c], from: IndexSet(integer: 2), to: 0).map(\.model), ["claude-c", "gpt-a", "gpt-b"])
        XCTAssertEqual(ModelLogic.add([a, b], b, default: nil).count, 2)
        XCTAssertEqual(ModelLogic.add([a], c, default: c).count, 1)
        XCTAssertEqual(ModelLogic.add([a], c, default: b).map(\.model), ["gpt-a", "claude-c"])
    }

    private func preset(key: ProviderPreset.Key, signIn: Bool = false, baseURL: Bool = false) -> ProviderPreset {
        ProviderPreset(id: "openai", label: "OpenAI", kind: .llm, apiMode: .chatCompletions, baseUrlRequired: baseURL, key: key, local: false, repeatable: false, signIn: signIn)
    }

    func testAddingAProviderSendsItsKeyOnlyWhereItTakesOne() {
        let keyed = preset(key: ._required)
        XCTAssertFalse(ModelLogic.ready(keyed, key: " ", baseURL: ""))
        XCTAssertTrue(ModelLogic.ready(keyed, key: "sk-1", baseURL: ""))
        let body = ModelLogic.create(keyed, key: " sk-1 ", baseURL: "", scope: .profile)
        XCTAssertEqual(body.apiKey, "sk-1")
        XCTAssertEqual(body.preset, "openai")
        XCTAssertEqual(body.scope, .profile)
        XCTAssertNil(body.baseUrl)
        let signIn = preset(key: ._required, signIn: true)
        XCTAssertTrue(ModelLogic.ready(signIn, key: "", baseURL: ""), "a sign-in needs no key")
        XCTAssertNil(ModelLogic.create(signIn, key: "typed", baseURL: "", scope: .all).apiKey)
        XCTAssertFalse(ModelLogic.ready(preset(key: ._optional, baseURL: true), key: "", baseURL: ""))
    }

    func testVoicesInThePersonsLanguagesComeFirstAndEveryLanguageStays() {
        let all = [
            CoreHubClient.Voice(id: "Zeina", name: "Zeina", language: "ar-SA"), CoreHubClient.Voice(id: "Amy", name: "Amy", language: "en-GB"),
            CoreHubClient.Voice(id: "Hans", name: "Hans", language: "de-DE"), CoreHubClient.Voice(id: "Aria", name: "Aria", language: "en-US"), CoreHubClient.Voice(id: "X", name: "X"),
        ]
        XCTAssertEqual(ModelLogic.voices(all, preferred: ["ar", "en"], query: "").map(\.id), ["Zeina", "Amy", "Aria", "Hans", "X"])
        XCTAssertEqual(ModelLogic.voices(all, preferred: ["en"], query: "").map(\.id), ["Amy", "Aria", "Zeina", "Hans", "X"])
        XCTAssertEqual(ModelLogic.voices(all, preferred: ["ar"], query: "de").map(\.id), ["Hans"])
        XCTAssertEqual(ModelLogic.sample("ja", fallback: "x"), "x")
    }

    func testANewPersonIsAMemberOfChosenProfilesOrAnAdminOfAll() {
        XCTAssertNil(AdminLogic.create(username: "Sara!", displayName: "", password: "12345678", admin: false, profiles: ["work"]))
        XCTAssertNil(AdminLogic.create(username: "sara", displayName: "", password: "short", admin: false, profiles: ["work"]))
        XCTAssertNil(AdminLogic.create(username: "sara", displayName: "", password: "12345678", admin: false, profiles: []))
        let member = AdminLogic.create(username: " sara ", displayName: " سارة ", password: "12345678", admin: false, profiles: ["work", "home"])
        XCTAssertEqual(member?.username, "sara")
        XCTAssertEqual(member?.displayName, "سارة")
        XCTAssertEqual(member?.role, .member)
        XCTAssertEqual(member?.defaultProfile, "work")
        let admin = AdminLogic.create(username: "omar", displayName: "", password: "12345678", admin: true, profiles: [])
        XCTAssertEqual(admin?.role, .admin)
        XCTAssertNil(admin?.profiles)
    }

    func testAMissingNoticeKindIsOnAndOneSwitchChangesOneCell() {
        let prefs = NotifyPreferences(
            events: ["task_moved": NotifyPreferencesEventsValue(inApp: true, push: false)],
            quietHours: NotifyPreferencesQuietHours(enabled: false, from: "22:00", to: "07:00", timezone: "Asia/Riyadh")
        )
        XCTAssertTrue(AdminLogic.value(prefs, .runCompleted).push)
        XCTAssertFalse(AdminLogic.value(prefs, .taskMoved).push)
        let next = AdminLogic.set(prefs, .runCompleted, push: false)
        XCTAssertEqual(next.events["run_completed"]?.push, false)
        XCTAssertEqual(next.events["run_completed"]?.inApp, true)
        XCTAssertTrue(AdminLogic.timeOK("07:30"))
        XCTAssertFalse(AdminLogic.timeOK("25:00"))
        XCTAssertEqual(AdminLogic.tokens(12_300), "12.3K")
    }
}

@testable import CoreHub
import CoreHubClient
import XCTest

/// The demo hub the App Store screenshots sign in to (Demo/DemoHub.swift): each answer goes
/// through the generated client and decodes, in both languages, and anything it does not have
/// is refused like a hub would refuse it.
final class DemoHubTests: XCTestCase {
    private func configuration(_ language: AppLanguage) -> CoreHubClientAPIConfiguration {
        CoreHubClientAPIConfiguration(
            basePath: DemoHub.hubURL.absoluteString + CoreHubClientAPIConfiguration().basePath,
            customHeaders: ["Accept-Language": language.rawValue],
            requestBuilderFactory: DemoHub.factory,
            apiResponseQueue: DispatchQueue(label: "demo-hub-tests")
        )
    }

    func testEveryPageOfTheScreenshotsDecodesInBothLanguages() async throws {
        for language in AppLanguage.allCases {
            let config = configuration(language)
            let me = try await AuthAPI.authGetMe(apiConfiguration: config)
            XCTAssertEqual(me.username, "sara")
            let profiles = try await AuthAPI.authListProfiles(apiConfiguration: config)
            XCTAssertEqual(profiles.items.map(\.slug), ["work", "personal"])
            let agents = try await AgentsAPI.agentsList(xHubProfile: "work", apiConfiguration: config)
            XCTAssertEqual(agents.items.map(\.slug), ["hermes", "opencode", "direct"])
            let sessions = try await SessionsAPI.sessionsList(
                xHubProfile: "work", profiles: .all, limit: 100, apiConfiguration: config
            )
            XCTAssertTrue(sessions.items.contains { $0.id == DemoFixtures.chatID && $0.pinned })
            let detail = try await SessionsAPI.sessionsGet(
                xHubProfile: "work", sessionId: DemoFixtures.chatID, apiConfiguration: config
            )
            XCTAssertEqual(detail.id, DemoFixtures.chatID)
            let messages = try await SessionsAPI.sessionsListMessages(
                xHubProfile: "work", sessionId: DemoFixtures.chatID, limit: 100, apiConfiguration: config
            )
            XCTAssertEqual(messages.items.map(\.seq), [1, 2, 3, 4])
            let tasks = try await TasksAPI.tasksListTasks(
                xHubProfile: "work", profiles: .all, limit: 200, apiConfiguration: config
            )
            XCTAssertEqual(Set(tasks.items.map(\.status)), [.running, .review, .blocked, .todo, .done])
        }
    }

    func testTheRequestLanguagePicksTheWords() async throws {
        let ar = try await AuthAPI.authListProfiles(apiConfiguration: configuration(.ar))
        let en = try await AuthAPI.authListProfiles(apiConfiguration: configuration(.en))
        XCTAssertEqual(ar.items.first?.name, "العمل")
        XCTAssertEqual(en.items.first?.name, "Work")
    }

    func testWhatTheDemoHubDoesNotHaveIsRefused() async {
        do {
            _ = try await SchedulesAPI.schedulesList(profiles: .all, limit: 10, apiConfiguration: configuration(.en))
            XCTFail("the demo hub has no schedules")
        } catch {
            XCTAssertEqual(HubFailure(error).status, 404)
        }
    }

    func testTheDemoIsOffUnlessLaunchedForIt() {
        XCTAssertFalse(DemoHub.isOn)
        XCTAssertNil(DemoHub.openPath)
    }
}

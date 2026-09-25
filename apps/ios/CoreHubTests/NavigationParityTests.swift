// The navigation parity test (docs/clients/README.md): the app against docs/clients/navigation.json,
// copied into the test bundle at build time. It fails on the first difference.
@testable import CoreHub
import XCTest

final class NavigationParityTests: XCTestCase {
    private struct Destination: Decodable {
        let id: String
        let title: String
        let roles: [String]
        let surfaces: [String]?
        let capability: String?
    }

    private struct PreAuth: Decodable {
        let title: String
        let routes: [String: String]
    }

    private struct Manifest: Decodable {
        let terms: [String: [String: String]]
        let destinations: [Destination]
        let rail: [String]
        let segments: [String]
        let footer: [String]
        let settingsTabs: [String]
        let settingsManagement: [String]
        let settingsTools: [String]
        let agentLevel: [String]
        let secondaryEntries: [String: [String]]
        let agentShell: [String: String]
    }

    private func manifest() throws -> Manifest {
        try JSONDecoder().decode(Manifest.self, from: Fixture.repositoryFile("navigation", "json"))
    }

    /// `surfaceRoutes.ios`; the map also carries a `$comment` string, so it is read loosely.
    private func iosRoutes() throws -> [String: String]? {
        let object = try JSONSerialization.jsonObject(with: Fixture.repositoryFile("navigation", "json")) as! [String: Any]
        return (object["surfaceRoutes"] as? [String: Any])?["ios"] as? [String: String]
    }

    /// `preAuth` mixes a `$comment` string with the screens, so it is read loosely.
    private func preAuth() throws -> [String: PreAuth] {
        let object = try JSONSerialization.jsonObject(with: Fixture.repositoryFile("navigation", "json")) as! [String: Any]
        let raw = object["preAuth"] as! [String: Any]
        var screens: [String: PreAuth] = [:]
        for (id, value) in raw where !id.hasPrefix("$") {
            let data = try JSONSerialization.data(withJSONObject: value)
            screens[id] = try JSONDecoder().decode(PreAuth.self, from: data)
        }
        return screens
    }

    private func onIOS(_ m: Manifest) -> [Destination] {
        m.destinations.filter { $0.surfaces?.contains("ios") ?? true }
    }

    // 1 and 2: every destination has a screen, and every screen has a destination.
    func testEveryDestinationHasAScreenAndNothingElseDoes() throws {
        let m = try manifest()
        XCTAssertEqual(Set(DestinationID.allCases.map(\.rawValue)), Set(onIOS(m).map(\.id)))
        let routes = try XCTUnwrap(try iosRoutes(), "surfaceRoutes.ios is missing")
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: AppRoutes.routes.map { ($0.key.rawValue, $0.value) }), routes)
        for destination in DestinationID.allCases {
            let path = routes[destination.rawValue]!.replacingOccurrences(of: ":agentId", with: "01J8QK3ZR2W7M5N4P6T8V9X0AG")
                .replacingOccurrences(of: ":sessionId?", with: "01J8QK3ZR2W7M5N4P6T8V9X0YA")
            XCTAssertEqual(AppRoutes.match(path)?.destination, destination, path)
        }
    }

    func testThePreAuthScreensAreTheManifestsAndNotDestinations() throws {
        let screens = try preAuth()
        XCTAssertEqual(Set(screens.keys), Set(NavigationMap.preAuth))
        for (id, screen) in screens {
            XCTAssertEqual(screen.routes["ios"], AppRoutes.preAuth[id], id)
            XCTAssertNil(DestinationID(rawValue: id), "\(id) must not be a destination")
            XCTAssertEqual(screen.title, id)
        }
    }

    // 3: one primary entry per destination, in the manifest's order.
    func testEveryEntryListIsTheManifestsInOrder() throws {
        let m = try manifest()
        let ios = Set(onIOS(m).map(\.id))
        XCTAssertEqual(NavigationMap.rail.map(\.rawValue), m.rail.filter(ios.contains))
        XCTAssertEqual(NavigationMap.segments.map(\.rawValue), m.segments.filter(ios.contains))
        XCTAssertEqual(NavigationMap.footer.map(\.rawValue), m.footer.filter(ios.contains))
        XCTAssertEqual(NavigationMap.settingsTabs.map(\.rawValue), m.settingsTabs.filter(ios.contains))
        XCTAssertEqual(NavigationMap.settingsManagement.map(\.rawValue), m.settingsManagement.filter(ios.contains))
        XCTAssertEqual(NavigationMap.settingsTools.map(\.rawValue), m.settingsTools.filter(ios.contains))
        XCTAssertEqual(NavigationMap.agentLevel.map(\.rawValue), m.agentLevel.filter(ios.contains))
        let lists = NavigationMap.rail + NavigationMap.segments + NavigationMap.footer + NavigationMap.settingsTabs
            + NavigationMap.settingsManagement + NavigationMap.settingsTools + NavigationMap.agentLevel
        XCTAssertEqual(lists.count, Set(lists).count, "a destination has two primary entries")
        XCTAssertEqual(NavigationMap.agentBackTerm, m.agentShell["back"])
    }

    // 4: the entry's label and the screen's title are one key, the manifest's word.
    func testEntryLabelEqualsScreenTitle() throws {
        let m = try manifest()
        let host = Bundle(for: AppModel.self)
        for destination in onIOS(m) {
            let id = try XCTUnwrap(DestinationID(rawValue: destination.id))
            XCTAssertEqual(id.titleTerm, destination.title, destination.id)
            for language in AppLanguage.allCases {
                let l10n = L10n(language, bundle: host)
                XCTAssertEqual(l10n(id.titleKey), m.terms[destination.title]?[language.rawValue], "\(language) \(destination.id)")
            }
        }
    }

    // 5: secondary entries only where the manifest allows them.
    func testSecondaryEntries() throws {
        let m = try manifest()
        let app = Dictionary(uniqueKeysWithValues: NavigationMap.secondaryEntries.map { ($0.key.rawValue, $0.value.map(\.rawValue)) })
        XCTAssertEqual(app, m.secondaryEntries)
    }

    // 6: roles and surfaces.
    func testRolesAndSurfaces() throws {
        let m = try manifest()
        for destination in onIOS(m) {
            let id = try XCTUnwrap(DestinationID(rawValue: destination.id))
            XCTAssertEqual(id.adminOnly, destination.roles.contains("admin"), destination.id)
        }
        let member = NavigationMap.visible(NavigationMap.rail + NavigationMap.settingsTabs + NavigationMap.settingsTools, admin: false)
        XCTAssertFalse(member.contains { $0.adminOnly })
        XCTAssertTrue(DestinationID.allCases.contains(.thisDevice), "this_device exists on phones")
    }

    // 7: the agent level is capability-driven, from the adapter — never the client.
    func testTheAgentLevelFollowsCapabilities() throws {
        let m = try manifest()
        for destination in onIOS(m) where m.agentLevel.contains(destination.id) {
            XCTAssertEqual(DestinationID(rawValue: destination.id)?.capability, destination.capability, destination.id)
        }
        // A fake agent declaring a subset (Claude Code's: skills and MCP) and installed.
        XCTAssertEqual(NavigationMap.agentMenu(capabilities: ["skills", "mcp", "streaming"], installed: true).map(\.rawValue),
                       ["agent_skills", "agent_mcp", "agent_settings"])
        XCTAssertEqual(NavigationMap.agentMenu(capabilities: ["memory", "channels", "jobs"], installed: false).map(\.rawValue),
                       ["agent_memory", "agent_jobs", "agent_channels"])
    }

    // 8: the profile is a filter — a link names a page, and the selector does not move it.
    func testLinksOpenTheirPageInTheirProfile() {
        let chat = URL(string: "corehub://open/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA?profile=work")!
        XCTAssertEqual(AppModel.route(for: chat, selector: "default"), .chat(sessionID: "01J8QK3ZR2W7M5N4P6T8V9X0YA", profile: "work"))
        let bare = URL(string: "corehub://open/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA")!
        XCTAssertEqual(AppModel.route(for: bare, selector: "home"), .chat(sessionID: "01J8QK3ZR2W7M5N4P6T8V9X0YA", profile: "home"))
        XCTAssertEqual(AppModel.route(for: URL(string: "corehub://open/tasks")!, selector: "x"), .destination(.tasks))
        XCTAssertEqual(AppModel.route(for: URL(string: "corehub://open/settings/models")!, selector: "x"), .settings)
        XCTAssertEqual(AppModel.route(for: URL(string: "corehub://open/agents/01J8QK3ZR2W7M5N4P6T8V9X0AG/mcp")!, selector: "x"), .destination(.agentManager))
        XCTAssertNil(AppModel.route(for: URL(string: "corehub://open/nowhere")!, selector: "x"))
        XCTAssertNil(AppModel.route(for: URL(string: "https://open/tasks")!, selector: "x"))
    }
}

@testable import CoreHub
import SwiftUI
import UIKit
import XCTest

/// The design family (docs/design/family.md): every icon is a Lucide asset the app carries, and
/// every destination has the one picture the web and Android draw for it.
final class FamilyTests: XCTestCase {
    func testEveryLucideIconIsInTheAssetCatalog() {
        for icon in Lucide.allCases {
            XCTAssertNotNil(UIImage(named: "Lucide/\(icon.rawValue)"), "missing asset Lucide/\(icon.rawValue)")
        }
    }

    func testEveryDestinationHasItsIcon() {
        // The web's `destinationIcons` table, for the destinations the phone has.
        let web: [DestinationID: String] = [
            .newChat: "square-pen", .search: "search", .agentManager: "bot", .tasks: "list-checks",
            .schedules: "calendar-clock", .chat: "messages-square", .rooms: "users", .settings: "settings",
            .account: "circle-user", .users: "users", .webhooks: "webhook", .display: "type",
            .notifications: "bell", .privacy: "shield-check", .about: "info", .models: "box",
            .deviceConnections: "qr-code", .knowledge: "book-open", .logs: "scroll-text",
            .usage: "chart-column", .skillsUsage: "activity", .performance: "gauge", .theme: "palette",
            .workspaces: "layout-grid", .updates: "circle-arrow-down", .plugins: "puzzle", .files: "folder",
            .agentSkills: "sparkles", .agentMcp: "server", .agentMemory: "brain",
            .agentJobs: "rotate-ccw-clock", .agentChannels: "radio", .agentPlugins: "puzzle", .agentConfigFiles: "file-cog",
            .agentSettings: "sliders-horizontal", .globalAgent: "globe",
        ]
        for destination in DestinationID.allCases {
            let icon = Icons.lucide(for: destination)
            XCTAssertNotNil(UIImage(named: "Lucide/\(icon.rawValue)"), "\(destination)")
            // This device is the one place the picture follows the device: a phone here.
            if destination == .thisDevice {
                XCTAssertEqual(icon, .smartphone)
            } else {
                XCTAssertEqual(icon.rawValue, web[destination], "\(destination) differs from the web")
            }
        }
    }

    func testThemeChoicesUseTheWebsPictures() {
        XCTAssertEqual(ThemeChoice.light.icon, .sun)
        XCTAssertEqual(ThemeChoice.dark.icon, .moon)
        XCTAssertEqual(ThemeChoice.system.icon, .sunMoon)
    }
}

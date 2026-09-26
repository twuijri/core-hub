import XCTest

/// The App Store screenshots (docs/store/apple/README.md). Each picture is one launch of the app
/// signed in to the demo hub (`-UITestDemo YES`, CoreHub/Demo/DemoHub.swift): a realistic chat,
/// the chats list, the agents, the tasks, a new chat and Settings, in Arabic and English. Nothing
/// talks to a real hub. `.github/workflows/ios-screenshots.yml` runs it on each required simulator
/// and passes, through `TEST_RUNNER_*` variables:
///
///   COREHUB_SHOTS_DIR     where the PNGs go: <dir>/<theme>/<locale>/<device>-NN-<name>.png
///   COREHUB_SHOTS_DEVICE  the file name's prefix (`iphone`, `ipad`)
///   COREHUB_SHOTS_THEMES  `light`, or `light,dark`
///
/// Every picture is also kept in the test's result bundle.
@MainActor
final class StoreScreenshots: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment
    /// The demo hub's one conversation (DemoFixtures.chatID).
    private let chatID = "01K5DM00000000000000000034"
    private let languages = [("en", "en-US"), ("ar", "ar-SA")]

    func testStoreScreenshots() throws {
        continueAfterFailure = false
        let themes = (environment["COREHUB_SHOTS_THEMES"] ?? "light").split(separator: ",").map(String.init)
        for theme in themes {
            for (language, locale) in languages {
                let shots = Shots(
                    directory: environment["COREHUB_SHOTS_DIR"].map { "\($0)/\(theme)/\(locale)" },
                    device: environment["COREHUB_SHOTS_DEVICE"] ?? "device",
                    test: self
                )
                try shoot(language: language, theme: theme, into: shots)
            }
        }
    }

    private func shoot(language: String, theme: String, into shots: Shots) throws {
        // 1. A conversation: Markdown, the tool card and the thinking line.
        var app = launch(language: language, theme: theme, open: "/chat/\(chatID)")
        try wait(for: "message.agent", in: app, timeout: 30)
        shots.take("01-chat", of: app)

        // 2. The drawer over it: the rail, the chats list with its profile badges.
        app.buttons["shell.menu"].tap()
        try wait(for: "session.\(chatID)", in: app)
        shots.take("02-chats", of: app)

        // 3. The agents of the profile.
        app = launch(language: language, theme: theme, open: "/agents")
        try wait(label: "OpenCode", in: app)
        shots.take("03-agents", of: app)

        // 4. Tasks across every profile.
        app = launch(language: language, theme: theme, open: "/tasks")
        try wait(for: "screen.tasks", in: app)
        try wait(label: "OpenCode", in: app)
        shots.take("04-tasks", of: app)

        // 5. A new chat: the agent chips and the composer.
        app = launch(language: language, theme: theme, open: "/new")
        try wait(for: "screen.new_chat", in: app)
        try wait(label: "Hermes", in: app)
        shots.take("05-new-chat", of: app)

        // 6. Settings.
        app = launch(language: language, theme: theme, open: "/settings")
        try wait(for: "settings.account", in: app)
        shots.take("06-settings", of: app)

        // Not for the store: the sign-in screen the reviewer meets first (review notes).
        app = launch(language: language, theme: theme, open: nil, demo: false)
        try wait(for: "login.submit", in: app)
        shots.take("00-sign-in", of: app, extra: true)

        // Not for the store either: the design audit's other pages (docs/design/family.md), on
        // the phone only. Whatever the demo hub answers — a page, its empty state or its error
        // state — is what the audit looks at, so nothing here waits for particular content.
        if shots.device == "iphone" {
            for (name, path) in [
                ("audit-search", "/search"),
                ("audit-rooms", "/rooms"),
                ("audit-schedules", "/schedules"),
                ("audit-models", "/settings/models"),
                ("audit-this-device", "/settings/this-device"),
                ("audit-display", "/settings/display"),
            ] {
                app = launch(language: language, theme: theme, open: path)
                _ = app.wait(for: .runningForeground, timeout: 15)
                Thread.sleep(forTimeInterval: 2)
                shots.take(name, of: app, extra: true)
            }
        }
        app.terminate()
    }

    private func launch(language: String, theme: String, open: String?, demo: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        var arguments = [
            "-AppleLanguages", "(\(language))",
            "-AppleLocale", language == "ar" ? "ar_SA" : "en_US",
            "-corehub.language", language,
            "-corehub.theme", theme,
        ]
        if demo { arguments += ["-UITestDemo", "YES"] }
        if let open { arguments += ["-UITestDemoOpen", open] }
        app.launchArguments = arguments
        app.launch()
        return app
    }

    private func wait(for identifier: String, in app: XCUIApplication, timeout: TimeInterval = 15) throws {
        let element = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        try expect(element, named: identifier, in: app, timeout: timeout)
    }

    private func wait(label: String, in app: XCUIApplication, timeout: TimeInterval = 15) throws {
        let element = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        try expect(element, named: label, in: app, timeout: timeout)
    }

    /// A page that never shows what it should fails the run, with the screen as it was.
    private func expect(_ element: XCUIElement, named name: String, in app: XCUIApplication, timeout: TimeInterval) throws {
        guard !element.waitForExistence(timeout: timeout) else { return }
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "missing-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = environment["COREHUB_SHOTS_DIR"] {
            try? FileManager.default.createDirectory(atPath: "\(directory)/failed", withIntermediateDirectories: true)
            try? XCUIScreen.main.screenshot().pngRepresentation
                .write(to: URL(fileURLWithPath: "\(directory)/failed/missing-\(name.replacingOccurrences(of: "/", with: "_")).png"))
        }
        throw Missing(what: name, tree: app.debugDescription)
    }
}

private struct Missing: Error, CustomStringConvertible {
    let what: String
    let tree: String
    var description: String { "Not on screen: \(what)\n\(tree)" }
}

@MainActor
private struct Shots {
    let directory: String?
    let device: String
    let test: XCTestCase

    /// Lets animations and the first layout settle, then keeps the screen as a PNG.
    func take(_ name: String, of app: XCUIApplication, extra: Bool = false) {
        Thread.sleep(forTimeInterval: 1.5)
        let screenshot = XCUIScreen.main.screenshot()
        let file = "\(device)-\(name).png"
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = file
        attachment.lifetime = .keepAlways
        test.add(attachment)
        guard let directory else { return }
        let folder = extra ? "\(directory)/extra" : directory
        do {
            try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(file)"))
        } catch {
            XCTFail("Could not write \(folder)/\(file): \(error)")
        }
    }
}

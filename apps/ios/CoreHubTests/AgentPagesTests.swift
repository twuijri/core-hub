@testable import CoreHub
import CoreHubClient
import XCTest

/// An agent's pages on the phone (B14): settings typed in place, and which channels link here.
final class AgentPagesTests: XCTestCase {
    private func field(_ kind: SettingsField.Kind, value: JSONValue? = nil, min: Double? = nil, max: Double? = nil, options: [Choice] = []) -> SettingsField {
        SettingsField(key: "k", label: LocalizedText(ar: "ح", en: "F"), kind: kind, value: value, options: options, min: min, max: max)
    }

    private func platform(_ login: ChannelPlatform.Login, credentials: [ChannelCredentialField] = [], allowlist: String? = nil) -> ChannelPlatform {
        ChannelPlatform(
            platform: login == .token ? "telegram" : login == .qr ? "whatsapp" : "discord", label: "P", support: .full, login: login,
            credentials: credentials, allowedUsersKey: allowlist, validates: true, pairs: true, allowlist: false, settings: false,
            exclusive: true, packages: ._none, inbound: false
        )
    }

    func testTypedSettingsBecomeTheFieldsKindWithinItsBounds() {
        XCTAssertEqual(SettingValues.parse(field(.integer, min: 1, max: 500), "40"), .int(40))
        XCTAssertNil(SettingValues.parse(field(.integer, min: 1, max: 500), "600"))
        XCTAssertNil(SettingValues.parse(field(.integer), "4.5"))
        XCTAssertEqual(SettingValues.parse(field(.number), "0,7"), .double(0.7))
        XCTAssertEqual(SettingValues.parse(field(.text), "  hello "), .string("  hello "))
        XCTAssertEqual(SettingValues.parse(field(.integer), "  "), .null)
        let choice = field(.choice, options: [Choice(value: "fast", label: "Fast")])
        XCTAssertEqual(SettingValues.parse(choice, "fast"), .string("fast"))
        XCTAssertNil(SettingValues.parse(choice, "slow"))
        XCTAssertTrue(SettingValues.on(field(.toggle, value: .bool(true))))
        XCTAssertFalse(SettingValues.editable(field(.json)))
        XCTAssertTrue(SettingValues.editable(field(.secret)))
    }

    func testTokenAndCredentialPlatformsLinkHereAndACodeIsScannedFromTheWeb() {
        XCTAssertFalse(ChannelLinks.onPhone(platform(.qr)))
        XCTAssertTrue(ChannelLinks.onPhone(platform(.token)))
        let telegram = platform(.token, allowlist: "TELEGRAM_ALLOWED_USERS")
        XCTAssertEqual(ChannelLinks.fields(telegram).map(\.key), ["token"])
        XCTAssertEqual(ChannelLinks.missing(telegram, [:]), ["token"])
        let request = ChannelLinks.request(telegram, ["token": " 123:abc "], allowed: "111, 222")
        XCTAssertEqual(request.token, "123:abc")
        XCTAssertEqual(request.allowedUsers, ["111", "222"])
        XCTAssertNil(request.credentials)
        let discord = platform(.credentials, credentials: [
            ChannelCredentialField(key: "DISCORD_BOT_TOKEN", kind: .secret, _required: true),
            ChannelCredentialField(key: "DISCORD_HOME_CHANNEL", kind: .text, _required: false),
        ])
        XCTAssertEqual(ChannelLinks.missing(discord, ["DISCORD_HOME_CHANNEL": "x"]), ["DISCORD_BOT_TOKEN"])
        let linked = ChannelLinks.request(discord, ["DISCORD_BOT_TOKEN": "t", "DISCORD_HOME_CHANNEL": " "], allowed: "9")
        XCTAssertEqual(linked.credentials, ["DISCORD_BOT_TOKEN": "t"])
        XCTAssertNil(linked.allowedUsers, "a platform with no allowlist variable sends none")
    }

    func testConfigFilesAreAnAgentPageForAdminsWithTheirCapability() {
        XCTAssertTrue(NavigationMap.agentLevel.contains(.agentConfigFiles))
        XCTAssertTrue(DestinationID.agentConfigFiles.adminOnly)
        XCTAssertEqual(NavigationMap.agentMenu(capabilities: ["config_files"], installed: true), [.agentConfigFiles, .agentSettings])
        XCTAssertEqual(NavigationMap.agentMenu(capabilities: ["skills"], installed: false), [.agentSkills])
    }
}

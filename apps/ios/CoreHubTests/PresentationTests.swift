@testable import CoreHub
import SwiftUI
import XCTest

final class MarkdownTests: XCTestCase {
    func testBlocks() {
        let source = """
        # Plan
        First line
        second line

        - one
        - two
          continued
        1. a
        2. b

        > quoted

        ```swift
        let x = 1
        ```
        ---
        """
        XCTAssertEqual(MarkdownParser.blocks(source), [
            .heading(level: 1, text: "Plan"),
            .paragraph("First line\nsecond line"),
            .bullet(items: ["one", "two continued"]),
            .numbered(start: 1, items: ["a", "b"]),
            .quote("quoted"),
            .code(language: "swift", code: "let x = 1"),
            .rule,
        ])
    }

    func testAnOpenFenceStillRendersWhileStreaming() {
        XCTAssertEqual(MarkdownParser.blocks("text\n```\npartial"), [
            .paragraph("text"),
            .code(language: nil, code: "partial"),
        ])
    }

    func testNotAHeadingWithoutASpaceAndNumbersFromTheirStart() {
        XCTAssertEqual(MarkdownParser.blocks("#hashtag"), [.paragraph("#hashtag")])
        XCTAssertEqual(MarkdownParser.blocks("3) c\n4) d"), [.numbered(start: 3, items: ["c", "d"])])
    }

    func testArabicStaysText() {
        XCTAssertEqual(MarkdownParser.blocks("مرحبًا **بك**"), [.paragraph("مرحبًا **بك**")])
        XCTAssertEqual(String(MarkdownParser.inline("مرحبًا **بك**").characters), "مرحبًا بك")
    }
}

final class ContentDirectionTests: XCTestCase {
    func testTheFirstStrongCharacterDecides() {
        XCTAssertEqual(ContentDirection.of("مرحبا Hermes"), .rightToLeft)
        XCTAssertEqual(ContentDirection.of("Hermes مرحبا"), .leftToRight)
        XCTAssertEqual(ContentDirection.of("12: شغّل"), .rightToLeft)
        XCTAssertEqual(ContentDirection.of("שלום"), .rightToLeft)
        XCTAssertNil(ContentDirection.of("123 — 45"))
        XCTAssertNil(ContentDirection.of(""))
    }
}

final class L10nTests: XCTestCase {
    private let host = Bundle(for: AppModel.self)

    func testArabicAndEnglishHaveTheSameKeysAndPlaceholders() {
        let ar = L10n(.ar, bundle: host)
        let en = L10n(.en, bundle: host)
        XCTAssertFalse(en.keys.isEmpty, "en.json is not in the app bundle")
        XCTAssertEqual(ar.keys, en.keys)
        let placeholder = try! NSRegularExpression(pattern: "\\{[a-zA-Z0-9_]+\\}")
        func names(_ text: String) -> [String] {
            placeholder.matches(in: text, range: NSRange(text.startIndex..., in: text))
                .map { String(text[Range($0.range, in: text)!]) }.sorted()
        }
        for key in en.keys {
            XCTAssertEqual(names(ar(key)), names(en(key)), key)
        }
    }

    func testEveryNavigationTermIsTheManifestsWord() throws {
        let manifest = try JSONSerialization.jsonObject(with: Fixture.repositoryFile("navigation", "json")) as! [String: Any]
        let terms = manifest["terms"] as! [String: [String: String]]
        let ar = L10n(.ar, bundle: host)
        let en = L10n(.en, bundle: host)
        for (key, words) in terms {
            XCTAssertEqual(en("nav.\(key)"), words["en"], "en nav.\(key)")
            XCTAssertEqual(ar("nav.\(key)"), words["ar"], "ar nav.\(key)")
        }
    }

    func testPlaceholdersAreFilledAndMissingKeysShow() {
        let en = L10n(.en, bundle: host)
        XCTAssertEqual(en("chat.placeholder", ["agent": "Hermes"]), "Message Hermes")
        XCTAssertEqual(en("no.such.key"), "no.such.key")
        XCTAssertEqual(L10n(.ar, bundle: host).productName, Product.nameAr)
    }

    func testThePersonIsNeverCalledAWorkspace() {
        for language in AppLanguage.allCases {
            let l10n = L10n(language, bundle: host)
            for key in l10n.keys {
                let text = l10n(key)
                XCTAssertNil(text.range(of: "workspace", options: .caseInsensitive), key)
                XCTAssertFalse(text.contains("مساحة العمل"), key)
            }
        }
    }
}

final class TokensTests: XCTestCase {
    func testThePalettesAreTheTokens() throws {
        let tokens = try JSONSerialization.jsonObject(with: Fixture.repositoryFile("tokens", "json")) as! [String: Any]
        let themes = tokens["themes"] as! [String: [String: Any]]
        for (name, palette) in [("light", Palette.light), ("dark", Palette.dark)] {
            let theme = themes[name]!
            let keys = theme.keys.filter { !$0.hasPrefix("$") }.sorted()
            XCTAssertEqual(keys, Palette.tokenKeys.sorted(), "\(name): tokens.json and Tokens.swift list different roles")
            for key in keys {
                let hex = theme[key] as! String
                let rgba = Self.rgba(hex)
                let child = Mirror(reflecting: palette).children.first { $0.label == Self.swiftName(key) }
                let value = try XCTUnwrap(child?.value as? RGBA, "\(name).\(key) missing from Palette")
                XCTAssertEqual(value.red, rgba.0, accuracy: 0.001, "\(name).\(key)")
                XCTAssertEqual(value.green, rgba.1, accuracy: 0.001, "\(name).\(key)")
                XCTAssertEqual(value.blue, rgba.2, accuracy: 0.001, "\(name).\(key)")
                XCTAssertEqual(value.alpha, rgba.3, accuracy: 0.001, "\(name).\(key)")
            }
        }
    }

    static func swiftName(_ key: String) -> String {
        var out = ""
        var upper = false
        for c in key {
            if c == "-" || c == "_" { upper = true; continue }
            out.append(upper ? Character(c.uppercased()) : c)
            upper = false
        }
        return out
    }

    static func rgba(_ hex: String) -> (Double, Double, Double, Double) {
        let digits = Array(hex.dropFirst())
        func byte(_ i: Int) -> Double { Double(Int(String(digits[i..<i + 2]), radix: 16)!) / 255 }
        return (byte(0), byte(2), byte(4), digits.count == 8 ? byte(6) : 1)
    }
}

final class NavigationMapTests: XCTestCase {
    func testMembersDoNotSeeAdminEntries() {
        XCTAssertEqual(NavigationMap.visible(NavigationMap.rail, admin: false), [.newChat, .search, .tasks, .schedules])
        XCTAssertEqual(NavigationMap.visible(NavigationMap.rail, admin: true), NavigationMap.rail)
    }

    func testTheAgentMenuFollowsTheAdapter() {
        XCTAssertEqual(NavigationMap.agentMenu(capabilities: ["skills", "mcp"], installed: true), [.agentSkills, .agentMcp, .agentSettings])
        XCTAssertEqual(NavigationMap.agentMenu(capabilities: ["memory"], installed: false), [.agentMemory])
    }
}

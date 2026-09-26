@testable import CoreHub
import CoreHubClient
import UIKit
import XCTest

/// A reply shows who answered: the registry's name and the agent's own face, never «agent».
final class AgentIdentityTests: XCTestCase {
    private func agent(_ id: String, slug: String, name: String, picture: Bool = false) -> Agent {
        Agent(id: id, profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date, slug: slug,
              name: name, kind: .hermes, avatar: Avatar(kind: picture ? .image : .generated, seed: "a"), status: .available, enabled: true,
              install: AgentInstall(source: .managed, updateAvailable: false, newerThanTested: false, autoUpdate: false, autoUpdateSupported: false),
              runtime: AgentRuntime(state: .running), capabilities: [], sections: [], limited: false, subagents: ._none)
    }

    func testAChatRepliesPlaceholderNameBecomesTheAgentsOwn() {
        let hermes = agent("a1", slug: "hermes", name: "Hermes")
        let who = AgentIdentity.of(authorID: "a1", shownName: "agent", agents: [hermes], fallback: "Agent")
        XCTAssertEqual(who.name, "Hermes")
        XCTAssertEqual(who.slug, "hermes")
        XCTAssertFalse(who.hasPicture)
    }

    func testARoomSeatKeepsItsOwnNameAndWearsItsAgentsFace() {
        let hermes = agent("a1", slug: "hermes", name: "Hermes")
        let who = AgentIdentity.of(authorID: "a1", shownName: "Planner", agents: [hermes], fallback: "Agent")
        XCTAssertEqual(who.name, "Planner")
        XCTAssertEqual(who.slug, "hermes")
    }

    func testAPictureOfItsOwnIsShownAndAnUnknownAgentFallsBack() {
        XCTAssertTrue(AgentIdentity.of(agent("a2", slug: "private-bot", name: "Mine", picture: true)).hasPicture)
        let unknown = AgentIdentity.of(authorID: "zz", shownName: "agent", agents: [], fallback: "Agent")
        XCTAssertEqual(unknown.name, "Agent")
        XCTAssertNil(unknown.slug)
    }

    func testTheMarksAreTheWebsByCatalogSlug() {
        XCTAssertEqual(AgentMarks.slugs, ["hermes", "claude-code", "codex", "gemini-cli", "opencode", "qwen-code", "kimi-code", "pi", "direct"])
        for slug in AgentMarks.slugs {
            XCTAssertNotNil(UIImage(named: "AgentMarks/\(slug)"), "\(slug) is not in the asset catalog")
        }
        XCTAssertNil(AgentMarks.image("private-bot"))
    }
}

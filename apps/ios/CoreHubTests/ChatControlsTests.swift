// The chat controls' rules (apps batch 1): what the model and approvals chips offer, a new chat's
// folder, and the chat's own actions. Android's ChatControlsTest.kt checks the same rules.
@testable import CoreHub
import CoreHubClient
import XCTest

final class ChatControlsTests: XCTestCase {
    private func model(_ key: String, alias: String? = nil, kind: ModelKind = .chat, visible: Bool = true, disabled: Bool = false, imageOnly: Bool? = nil,
                       gateway: Bool? = nil, tools: Bool? = nil, window: Int? = nil) -> Model {
        let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
        return Model(
            key: key, providerId: parts[0], provider: parts[0].capitalized, model: parts[1], alias: alias, kind: kind,
            visible: visible, custom: false, preview: false, disabled: disabled, contextWindow: window, capabilities: [], imageOnly: imageOnly,
            agentGateway: gateway, agentTools: tools
        )
    }

    private func agent(kind: AgentKind = .acp, defaultModel: ModelRef? = nil, own: String? = nil, source: String? = nil) -> Agent {
        Agent(id: "01J8QK3ZR2W7M5N4P6T8V9X0AG", profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date, slug: "gemini-cli",
              name: "Gemini CLI", kind: kind, avatar: Avatar(kind: .generated, seed: "g"), status: .available, enabled: true,
              install: AgentInstall(source: .managed, version: "0.60.0", latestVersion: nil, updateAvailable: false, pinnedVersion: nil,
                                    newerThanTested: false, autoUpdate: false, autoUpdateSupported: true),
              runtime: AgentRuntime(state: .notApplicable), capabilities: [], sections: [], defaultModel: defaultModel, limited: false,
              subagents: ._none, agentDefaultModel: own, modelSource: source)
    }

    /// The model gateway (ADR 0029, DECISIONS §140–141): a coding agent on the hub's models is
    /// offered what the gateway serves, and «Default» names the profile's default; an older hub,
    /// which says neither, keeps the picker as it was.
    func testACodingAgentOnTheHubsModelsIsOfferedWhatTheGatewayServes() {
        let catalogue = [
            model("groq/llama", alias: "Llama", gateway: true),
            model("openai-codex/gpt-5", gateway: false),
            model("older/model"),
        ]
        let onHub = agent(defaultModel: ModelRef(providerId: "p1", model: "llama"), own: "gemini-2.5-pro", source: "hub")
        XCTAssertTrue(ChatControls.gatewayOnly(onHub))
        let options = ChatControls.models(catalogue, gatewayOnly: ChatControls.gatewayOnly(onHub))
        XCTAssertEqual(options.map(\.value), ["groq/llama"])
        XCTAssertEqual(ChatControls.defaultModelName(onHub, options), "Llama")
        XCTAssertEqual(ChatControls.modelSourceKey(onHub), "agents.model_source.hub")
        // On its own account: the whole catalogue, and its own settings' model.
        let own = agent(defaultModel: ModelRef(providerId: "p1", model: "llama"), own: "gemini-2.5-pro", source: "agent")
        XCTAssertFalse(ChatControls.gatewayOnly(own))
        XCTAssertEqual(ChatControls.models(catalogue, gatewayOnly: false).count, 3)
        XCTAssertEqual(ChatControls.defaultModelName(own, options), "gemini-2.5-pro")
        XCTAssertEqual(ChatControls.modelSourceKey(own), "agents.model_source.agent")
        // An older hub says nothing: the whole catalogue, the plain «Default model», no line.
        let older = agent()
        XCTAssertFalse(ChatControls.gatewayOnly(older))
        XCTAssertNil(ChatControls.defaultModelName(older, options))
        XCTAssertNil(ChatControls.modelSourceKey(older))
        // Hermes runs on the profile's default, named by the catalogue.
        let hermes = agent(kind: .hermes, defaultModel: ModelRef(providerId: "p1", model: "llama"))
        XCTAssertEqual(ChatControls.defaultModelName(hermes, options), "Llama")
        XCTAssertNil(ChatControls.defaultModelName(nil, options))
    }

    /// Picker quality (§141): a model its provider says cannot call tools is left out, and one under
    /// the agent's context floor is marked; on its own account, nothing is.
    func testTheGatewayPickerLeavesOutModelsWithoutToolsAndMarksSmallOnes() {
        let catalogue = [
            model("openrouter/coder", gateway: true, window: 262_144),
            model("openrouter/no-tools", gateway: true, tools: false, window: 131_072),
            model("openrouter/small", gateway: true, window: 32_768),
            model("ollama/unknown", gateway: true),
        ]
        let options = ChatControls.models(catalogue, gatewayOnly: true, minContext: 64_000)
        XCTAssertEqual(options.map(\.value), ["openrouter/coder", "openrouter/small", "ollama/unknown"])
        XCTAssertEqual(options.map(\.smallUnder), [nil, 64_000, nil])
        let own = ChatControls.models(catalogue, gatewayOnly: false, minContext: 64_000)
        XCTAssertEqual(own.count, 4)
        XCTAssertTrue(own.allSatisfy { $0.smallUnder == nil })
    }

    func testTheModelChipOffersTheVisibleChatModelsByTheirKey() {
        let catalogue = [
            model("openai/gpt-5", alias: "GPT-5"),
            model("openai/whisper-1", kind: .stt),
            model("openai/dall-e", imageOnly: true),
            model("anthropic/claude-hidden", visible: false),
            model("anthropic/claude-off", disabled: true),
            model("anthropic/claude-sonnet"),
        ]
        let options = ChatControls.models(catalogue)
        XCTAssertEqual(options.map(\.value), ["openai/gpt-5", "anthropic/claude-sonnet"])
        XCTAssertEqual(options.map(\.label), ["GPT-5", "claude-sonnet"])
        XCTAssertEqual(ChatControls.groups(options).map(\.group), ["Openai", "Anthropic"])
        XCTAssertEqual(ChatControls.filter(options, " SONNET ").map(\.value), ["anthropic/claude-sonnet"])
        XCTAssertEqual(ChatControls.filter(options, "openai").map(\.value), ["openai/gpt-5"], "the provider is searched too")
        XCTAssertEqual(ChatControls.modelLabel("openai/gpt-5", options), "GPT-5")
        XCTAssertEqual(ChatControls.modelLabel("groq/llama-4", options), "llama-4", "a model outside the list keeps its own name")
        XCTAssertNil(ChatControls.modelLabel(nil, options), "no model is the agent's default")
    }

    private func field(_ key: String, value: JSONValue?, fallback: JSONValue? = nil, options: [String]) -> SettingsField {
        SettingsField(
            key: key, label: LocalizedText(ar: "", en: ""), kind: .choice, value: value,
            options: options.map { Choice(value: $0, label: $0) }, _default: fallback
        )
    }

    func testTheApprovalsChipReadsTheAgentsOwnFieldAndItsDefault() {
        let hermes = SettingsSection(
            key: "approvals", title: LocalizedText(ar: "", en: ""), restartRequired: false,
            fields: [field("approvals_mode", value: nil, fallback: .string("smart"), options: ["manual", "smart", "off"])]
        )
        let found = ChatControls.approval([hermes])
        XCTAssertEqual(found?.section, "approvals")
        XCTAssertEqual(found?.key, "approvals_mode")
        XCTAssertEqual(found?.value, "smart", "nothing written is the agent's default, not the first option")
        let acp = SettingsSection(
            key: "agent", title: LocalizedText(ar: "", en: ""), restartRequired: false,
            fields: [field("max_turns", value: .int(60), options: []), field("approval_mode", value: .string("auto_all"), options: ["ask", "auto_safe", "auto_all"])]
        )
        XCTAssertEqual(ChatControls.approval([acp])?.value, "auto_all")
        XCTAssertNil(ChatControls.approval([]), "an agent that declares none has no chip")
        XCTAssertTrue(ChatControls.risky("off"))
        XCTAssertFalse(ChatControls.risky("manual"))
    }

    func testANewChatsFolderIsANameUnderTheRootOrTheAutomaticOne() {
        let root = "/var/lib/corehub/workspaces/work"
        XCTAssertEqual(ChatControls.folderName("\(root)/corehub", root: root), "corehub")
        XCTAssertNil(ChatControls.folderName("\(root)/01J8QK3ZR2W7M5N4P6T8V9X0YA", root: root), "a generated folder reads as automatic")
        XCTAssertNil(ChatControls.folderName(nil, root: root))
        XCTAssertEqual(ChatControls.folderName("reports", root: root), "reports", "a new name is shown as typed")
        XCTAssertEqual(ChatControls.newFolder("  reports "), "reports")
        XCTAssertNil(ChatControls.newFolder("a/b"))
        XCTAssertNil(ChatControls.newFolder(".."))
        XCTAssertNil(ChatControls.newFolder("   "))
    }

    func testTheChatsMenuOffersWhatThisChatCanDo() {
        XCTAssertEqual(
            ChatControls.actions(pinned: false, archived: false, globalAgent: false, canCompress: true),
            [.rename, .pin, .archive, .fork, .compress, .export, .delete]
        )
        XCTAssertEqual(
            ChatControls.actions(pinned: true, archived: true, globalAgent: false, canCompress: false),
            [.rename, .unpin, .unarchive, .fork, .export, .delete]
        )
        XCTAssertEqual(
            ChatControls.actions(pinned: false, archived: false, globalAgent: true, canCompress: true),
            [.compress, .export], "the global agent's conversation is never renamed, archived or deleted here"
        )
        XCTAssertEqual(ChatControls.patch(.pin), SessionPatch(pinned: true))
        XCTAssertEqual(ChatControls.patch(.unarchive), SessionPatch(archived: false))
        XCTAssertNil(ChatControls.patch(.rename))
        XCTAssertEqual(ChatControls.renameTitle("  Trip plan  "), "Trip plan")
        XCTAssertNil(ChatControls.renameTitle("   "), "an empty name is not sent")
        XCTAssertEqual(ChatControls.renameTitle(String(repeating: "a", count: 250))?.count, 200)
    }

    func testDefaultModelAndAutomaticNamingSendAnExplicitNullAndNothingElseDoes() throws {
        // Contract decision §114: an optional nullable field goes out as `null` only when listed in `sendNull`.
        func body(_ patch: SessionPatch) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: CodableHelper().jsonEncoder.encode(patch)) as? [String: Any])
        }
        let reset = try body(ChatControls.modelPatch(nil))
        XCTAssertEqual(Array(reset.keys), ["model"])
        XCTAssertTrue(reset["model"] is NSNull)
        let named = try body(XCTUnwrap(ChatControls.patch(.autoTitle)))
        XCTAssertEqual(Array(named.keys), ["title"])
        XCTAssertTrue(named["title"] is NSNull)
        XCTAssertEqual(try body(ChatControls.modelPatch("openai/gpt-5")) as? [String: String], ["model": "openai/gpt-5"])
        XCTAssertEqual(try body(SessionPatch(pinned: true)) as? [String: Bool], ["pinned": true], "nothing unlisted goes out as null")
        XCTAssertEqual(try body(SessionPatch(title: "Kept", sendNull: [.title])) as? [String: String], ["title": "Kept"], "a value wins")
        XCTAssertEqual(
            ChatControls.actions(pinned: false, archived: false, globalAgent: false, canCompress: false, titled: true),
            [.rename, .autoTitle, .pin, .archive, .fork, .export, .delete]
        )
        XCTAssertFalse(ChatControls.actions(pinned: false, archived: false, globalAgent: true, canCompress: false, titled: true).contains(.autoTitle))
    }

    func testCompressingAndSteeringSayWhatHappened() {
        let done = ChatControls.compression(SessionCompression(status: .compressed, beforeTokens: 90000, afterTokens: 12000))
        XCTAssertEqual(done, .compressed(before: 90000, after: 12000))
        XCTAssertEqual(ChatControls.compressionText(done).key, "chat_controls.compressed")
        XCTAssertEqual(ChatControls.compressionText(done).params, ["before": "90000", "after": "12000"])
        XCTAssertEqual(ChatControls.compressionText(.compressed(before: nil, after: nil)).key, "chat_controls.compressed_plain")
        XCTAssertEqual(ChatControls.compressionText(ChatControls.compression(SessionCompression(status: .skipped))).key, "chat_controls.compress_skipped")
        XCTAssertTrue(ChatControls.canSteer(running: true, text: "focus on tests", capabilities: [.steer]))
        XCTAssertFalse(ChatControls.canSteer(running: false, text: "focus on tests", capabilities: [.steer]))
        XCTAssertFalse(ChatControls.canSteer(running: true, text: "  ", capabilities: [.steer]))
        XCTAssertFalse(ChatControls.canSteer(running: true, text: "focus", capabilities: [.compress]))
    }

    func testAChangeTheHubAnsweredShowsOnTheOpenChat() {
        var state = ChatState(sessionID: "s1")
        state.absorb(Session(
            id: "s1", profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date, agentId: "ag1",
            title: "Trip plan", source: .chat, model: "openai/gpt-5", workingDir: "/w/trip", pinned: true, archived: true,
            messageCount: 3, status: .idle, notify: true
        ))
        XCTAssertEqual(state.title, "Trip plan")
        XCTAssertEqual(state.model, "openai/gpt-5")
        XCTAssertTrue(state.pinned)
        XCTAssertTrue(state.archived)
        XCTAssertEqual(state.workingDir, "/w/trip")
        state.absorb(Session(
            id: "other", profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date, agentId: "ag1",
            title: "Elsewhere", source: .chat, pinned: false, archived: false, messageCount: 0, status: .idle, notify: true
        ))
        XCTAssertEqual(state.title, "Trip plan", "another chat's change does not touch this one")
    }

    func testEveryChatControlsStringExistsInBothLanguages() {
        let en = L10n(.en, bundle: Bundle(for: AppModel.self))
        let ar = L10n(.ar, bundle: Bundle(for: AppModel.self))
        let keys = en.keys.filter { $0.hasPrefix("chat_controls.") }
        XCTAssertFalse(keys.isEmpty)
        XCTAssertEqual(Set(keys), Set(ar.keys.filter { $0.hasPrefix("chat_controls.") }))
        XCTAssertEqual(ApprovalSheet.title("smart", [], en), "Smart")
        XCTAssertEqual(ApprovalSheet.title("custom", [Choice(value: "custom", label: "Custom", labels: LocalizedText(ar: "مخصص", en: "Custom mode"))], ar), "مخصص")
    }
}

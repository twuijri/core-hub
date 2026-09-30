@testable import CoreHub
import CoreHubClient
import XCTest

/// Drawing a workflow on the phone (WorkflowEditRules): what is saved is the contract's own
/// `WorkflowWrite`, so the web's canvas opens it unchanged.
final class WorkflowEditorTests: XCTestCase {
    private func empty() -> WorkflowEditRules.Draft { WorkflowEditRules.draft(nil) }

    func testAddingStepsNamesThemPlacesThemAndLinksEachAfterTheOneBefore() {
        var draft = empty()
        let first = WorkflowEditRules.add(.agent, title: "Draft", to: &draft, agentID: "A1")
        let second = WorkflowEditRules.add(.approval, title: "Check", to: &draft)
        let third = WorkflowEditRules.add(.agent, title: "Publish", to: &draft)
        XCTAssertEqual([first, second, third], ["agent_1", "approval_1", "agent_2"])
        XCTAssertEqual(draft.nodes[0].agentId, "A1")
        XCTAssertNil(draft.nodes[1].agentId)
        XCTAssertEqual(draft.edges.map { "\($0.from)>\($0.to):\($0.route.rawValue)" }, ["agent_1>approval_1:success", "approval_1>agent_2:success"])
        XCTAssertEqual(draft.nodes[0].position, WorkflowNodePosition(x: 40, y: 40))
        XCTAssertEqual(draft.nodes[1].position.x, 40 + WorkflowEditRules.nodeWidth + 72)
        XCTAssertEqual(WorkflowEditRules.add(.delay, title: "Wait", to: &draft, after: "agent_1"), "delay_1")
        XCTAssertEqual(draft.nodes.last?.input, "60")
        // Its spot after agent_1 is approval_1's: it goes below.
        XCTAssertEqual(draft.nodes.last?.position.x, draft.nodes[1].position.x)
        XCTAssertGreaterThan(draft.nodes.last?.position.y ?? 0, draft.nodes[1].position.y)
    }

    func testRemovingAStepRemovesItsLinksAndConnectingTwiceOrToItselfDoesNothing() {
        var draft = empty()
        WorkflowEditRules.add(.agent, title: "A", to: &draft)
        WorkflowEditRules.add(.notify, title: "B", to: &draft)
        XCTAssertNil(WorkflowEditRules.connect("agent_1", to: "agent_1", route: .always, in: &draft))
        XCTAssertNil(WorkflowEditRules.connect("agent_1", to: "nope", route: .always, in: &draft))
        XCTAssertEqual(WorkflowEditRules.connect("agent_1", to: "notify_1", route: .success, in: &draft), "e1")
        XCTAssertEqual(WorkflowEditRules.connect("agent_1", to: "notify_1", route: .failure, in: &draft), "e2")
        XCTAssertEqual(draft.edges.count, 2)
        WorkflowEditRules.remove("notify_1", from: &draft)
        XCTAssertEqual(draft.nodes.map(\.id), ["agent_1"])
        XCTAssertTrue(draft.edges.isEmpty)
    }

    func testAStepReadsTheOutputOfEveryStepWithAPathToIt() {
        var draft = empty()
        WorkflowEditRules.add(.agent, title: "A", to: &draft)
        WorkflowEditRules.add(.condition, title: "B", to: &draft)
        WorkflowEditRules.add(.notify, title: "C", to: &draft)
        XCTAssertEqual(WorkflowEditRules.upstream(draft, of: "notify_1").map(\.id), ["agent_1", "condition_1"])
        XCTAssertTrue(WorkflowEditRules.upstream(draft, of: "agent_1").isEmpty)
        WorkflowEditRules.move("notify_1", by: -1, in: &draft)
        XCTAssertEqual(draft.nodes.map(\.id), ["agent_1", "notify_1", "condition_1"])
    }

    func testConditionsSplitAndJoinAsTheEngineReadsThem() {
        XCTAssertEqual(WorkflowEditRules.split("input exists"), WorkflowEditRules.Condition(path: "input", op: "exists", value: ""))
        XCTAssertEqual(WorkflowEditRules.split(#"steps.a.output contains "done""#), WorkflowEditRules.Condition(path: "steps.a.output", op: "contains", value: "done"))
        XCTAssertEqual(WorkflowEditRules.split("trigger.count >= 3"), WorkflowEditRules.Condition(path: "trigger.count", op: ">=", value: "3"))
        XCTAssertNil(WorkflowEditRules.split("a and b"))
        XCTAssertEqual(WorkflowEditRules.join(.init(path: "input", op: "==", value: "yes")), #"input == "yes""#)
        XCTAssertEqual(WorkflowEditRules.join(.init(path: "trigger.count", op: ">", value: " 2 ")), "trigger.count > 2")
        XCTAssertEqual(WorkflowEditRules.join(.init(path: "input", op: "empty", value: "x")), "input empty")
    }

    func testWhatIsSavedIsTheContractsWrite() {
        var draft = empty()
        draft.name = "  Morning  "
        WorkflowEditRules.add(.agent, title: "A", to: &draft, agentID: "A1")
        WorkflowEditRules.add(.approval, title: "Ok?", to: &draft)
        draft.nodes[1].agentId = "stray"
        draft.nodes[1].approvalRequired = true
        let write = WorkflowEditRules.write(draft, clearing: true)
        XCTAssertEqual(write.name, "Morning")
        XCTAssertNil(write.description)
        XCTAssertEqual(write.sendNull, [.description], "an emptied description is cleared on the hub")
        XCTAssertEqual(write.nodes?[0].agentId, "A1")
        XCTAssertNil(write.nodes?[1].agentId, "only an agent step names an agent")
        XCTAssertEqual(write.nodes?[1].approvalRequired, false)
        XCTAssertEqual(WorkflowEditRules.write(draft, clearing: false).sendNull, [])
        XCTAssertTrue(WorkflowEditRules.canSave(draft, validation: nil))
        XCTAssertFalse(WorkflowEditRules.canSave(draft, validation: WorkflowValidation(valid: false, problems: [WorkflowIssue(code: "agent_missing", message: "x")], warnings: [])))
        draft.name = " "
        XCTAssertFalse(WorkflowEditRules.canSave(draft, validation: nil))
    }

    /// A node as the hub reads it: the JSON the write encodes.
    private func json(_ value: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    func testAConditionsRulesRoundTripExactly() throws {
        // Several rules (§123) come from the hub; saved here, they go back as they came — an
        // operator this app does not offer included (it is a plain string).
        let raw = #"{"match":"any","items":[{"path":"trigger.event","operator":"==","value":"taskCreated"},{"path":"trigger.task_id","operator":"exists","value":null},{"path":"trigger.body.x","operator":"~=","value":"a"}]}"#
        let rules = try JSONDecoder().decode(WorkflowRules.self, from: Data(raw.utf8))
        var draft = empty()
        draft.name = "Filter"
        WorkflowEditRules.add(.condition, title: "Only new", to: &draft)
        draft.nodes[0].rules = rules
        let written = try XCTUnwrap(WorkflowEditRules.write(draft, clearing: true).nodes?.first)
        XCTAssertEqual(written.rules, rules)
        XCTAssertEqual(WorkflowEditRules.check(draft).nodes?[0].rules, rules)
        let sent = try json(written)["rules"] as? [String: Any]
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? NSDictionary)
        XCTAssertEqual(sent.map { NSDictionary(dictionary: $0) }, original)
        // A condition this app never gave rules says nothing about them: the hub keeps its own.
        var plain = empty()
        WorkflowEditRules.add(.condition, title: "C", to: &plain)
        let untouched = try json(XCTUnwrap(WorkflowEditRules.write(plain, clearing: true).nodes?.first))
        XCTAssertFalse(untouched.keys.contains("rules"))
    }

    func testSwitchingSeveralRulesOnStartsFromTheComparisonAndOffSendsAnExplicitNull() throws {
        var draft = empty()
        draft.name = "Filter"
        WorkflowEditRules.add(.condition, title: "C", to: &draft)
        draft.nodes[0].input = "trigger.count >= 3"
        WorkflowEditRules.setSeveralRules(true, node: &draft.nodes[0])
        XCTAssertEqual(draft.nodes[0].rules, WorkflowRules(match: .all, items: [WorkflowRule(path: "trigger.count", _operator: ">=", value: "3")]))
        XCTAssertFalse(draft.nodes[0].sendNull.contains(.rules))
        WorkflowEditRules.setSeveralRules(false, node: &draft.nodes[0])
        XCTAssertNil(draft.nodes[0].rules)
        let off = try json(XCTUnwrap(WorkflowEditRules.write(draft, clearing: true).nodes?.first))
        XCTAssertTrue(off["rules"] is NSNull, "switched off, the rules are removed on the hub too")
        XCTAssertEqual(off["input"] as? String, "trigger.count >= 3", "the single line stays")
        // On again after off: the rules are sent, not the null.
        WorkflowEditRules.setSeveralRules(true, node: &draft.nodes[0])
        let on = try json(XCTUnwrap(WorkflowEditRules.write(draft, clearing: true).nodes?.first))
        XCTAssertNotNil(on["rules"] as? [String: Any])
        // No rule left at all: the same explicit null.
        draft.nodes[0].rules?.items = []
        let emptied = try json(XCTUnwrap(WorkflowEditRules.write(draft, clearing: true).nodes?.first))
        XCTAssertTrue(emptied["rules"] is NSNull)
    }

    func testTheFirstRuleIsTheSingleComparisonOrTheTriggersEvent() {
        XCTAssertEqual(WorkflowEditRules.firstRule("input exists"), WorkflowRule(path: "input", _operator: "exists", value: nil))
        XCTAssertEqual(WorkflowEditRules.firstRule(#"steps.a.output contains "done""#), WorkflowRule(path: "steps.a.output", _operator: "contains", value: "done"))
        let event = WorkflowRule(path: "trigger.event", _operator: "==", value: "")
        XCTAssertEqual(WorkflowEditRules.firstRule(nil), event)
        XCTAssertEqual(WorkflowEditRules.firstRule(""), event)
        XCTAssertEqual(WorkflowEditRules.firstRule("a and b"), event)
    }

    func testEditingRulesKeepsValuesTheWayTheEngineReadsThem() {
        var rules = WorkflowRules(match: .all, items: [WorkflowRule(path: "trigger.event", _operator: "==", value: "taskCreated")])
        rules = WorkflowEditRules.setRule(rules, at: 0, op: "exists")
        XCTAssertNil(rules.items[0].value, "exists and empty carry no value")
        rules = WorkflowEditRules.setRule(rules, at: 0, op: "!=")
        XCTAssertEqual(rules.items[0].value, "", "back to a comparison: an empty value")
        rules = WorkflowEditRules.setRule(rules, at: 0, path: "trigger.task_id", value: "T1")
        XCTAssertEqual(rules.items[0], WorkflowRule(path: "trigger.task_id", _operator: "!=", value: "T1"))
        XCTAssertEqual(WorkflowEditRules.setRule(rules, at: 5, path: "x"), rules, "an index out of range changes nothing")
        XCTAssertEqual(WorkflowEditRules.removeRule(rules, at: 0), rules, "the last rule stays")
        rules = WorkflowEditRules.addRule(rules)
        XCTAssertEqual(rules.items.last, WorkflowRule(path: "trigger.event", _operator: "==", value: ""))
        XCTAssertEqual(WorkflowEditRules.removeRule(rules, at: 0).items, [WorkflowRule(path: "trigger.event", _operator: "==", value: "")])
        var draft = empty()
        WorkflowEditRules.add(.agent, title: "A", to: &draft)
        WorkflowEditRules.add(.condition, title: "B", to: &draft)
        XCTAssertEqual(WorkflowEditRules.ruleSuggestions(draft, of: "condition_1"), WorkflowEditRules.triggerPaths + ["input", "steps.agent_1.output"])
        XCTAssertEqual(WorkflowEditRules.triggerPaths.first, "trigger.event")
    }

    func testSendTargetsAreAddedAndRemovedAndAnUnknownPlatformIsKept() throws {
        let raw = #"{"targets":[{"platform":"whatsapp","chat_id":"+9665"},{"platform":"core_hub","session_id":"01J8QK3ZR2W7M5N4P6T8V9X0SS","title":"Reports"}]}"#
        var send = try JSONDecoder().decode(WorkflowSend.self, from: Data(raw.utf8))
        let whatsapp = send.targets[0]
        send = WorkflowEditRules.setTarget(send, platform: "telegram", WorkflowEditRules.telegramTarget(chatID: " -1001 "))
        XCTAssertEqual(WorkflowEditRules.target(send, "telegram")?.chatId, "-1001")
        send = WorkflowEditRules.setTarget(send, platform: "telegram", WorkflowEditRules.telegramTarget(chatID: "-1002"))
        XCTAssertEqual(send.targets.filter { $0.platform == "telegram" }.count, 1, "one target per platform")
        send = WorkflowEditRules.setTarget(send, platform: "core_hub", nil)
        XCTAssertNil(WorkflowEditRules.target(send, "core_hub"))
        XCTAssertEqual(send.targets.map(\.platform), ["whatsapp", "telegram"])
        XCTAssertEqual(send.targets.first, whatsapp, "a platform this app does not know is kept untouched")
        let session = Session(id: "01J8QK3ZR2W7M5N4P6T8V9X0SS", profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date,
                              agentId: "01J8QK3ZR2W7M5N4P6T8V9X0AG", title: "Reports", source: .chat, pinned: false, archived: false,
                              messageCount: 0, status: .idle, notify: false)
        XCTAssertEqual(WorkflowEditRules.conversationTarget(session),
                       WorkflowSendTarget(platform: "core_hub", sessionId: session.id, title: "Reports", agentId: "01J8QK3ZR2W7M5N4P6T8V9X0AG"))
        XCTAssertEqual(WorkflowEditRules.conversationTarget(nil), WorkflowSendTarget(platform: "core_hub"))
        XCTAssertTrue(WorkflowEditRules.canTestSend(send, text: "Hello"))
        XCTAssertFalse(WorkflowEditRules.canTestSend(send, text: "  "))
        XCTAssertFalse(WorkflowEditRules.canTestSend(WorkflowSend(targets: []), text: "Hello"))
        XCTAssertEqual(WorkflowEditRules.sendTest(send, text: " Hi ").text, "Hi")
        // Words with variables: named once each as the hub names them, no test until each has a
        // value, and the test carries the words filled in — never `{{steps.analysis.output}}`.
        let words = "Result: {{steps.analysis.output}} for {{ input }} ({{steps.analysis.output}})"
        XCTAssertEqual(WorkflowEditRules.variables(in: words), ["steps.analysis.output", "input"])
        XCTAssertFalse(WorkflowEditRules.canTestSend(send, text: words))
        var values = ["steps.analysis.output": "done", "input": ""]
        XCTAssertEqual(WorkflowEditRules.missing(in: words, values: values), ["input"])
        XCTAssertEqual(WorkflowEditRules.fill(words, values: values), "Result: done for {{ input }} (done)")
        values["input"] = "release 2"
        XCTAssertTrue(WorkflowEditRules.canTestSend(send, text: words, values: values))
        XCTAssertEqual(WorkflowEditRules.sendTest(send, text: words, values: values).text, "Result: done for release 2 (done)")
        let result = WorkflowSendResult(status: .partial, messageIds: [], deliveredTo: ["telegram:-1002"],
                                        failures: [WorkflowSendResultFailuresInner(target: "whatsapp:+9665", reason: "unknown platform")])
        XCTAssertEqual(WorkflowEditRules.failureLines(result), ["whatsapp:+9665: unknown platform"])
    }

    func testTelegramFormattingIsReadChosenKeptWithTheChatIDAndSurvivesALoadAndSave() throws {
        // A step saved before §137: no field, read as plain, and written without one.
        let old = WorkflowSend(targets: [WorkflowEditRules.telegramTarget(chatID: "-1001")])
        XCTAssertEqual(WorkflowEditRules.formatting(of: WorkflowEditRules.target(old, "telegram")), "plain")
        XCTAssertNil(try json(old.targets[0])["formatting"], "absent stays absent: the hub keeps what was saved")

        var send = WorkflowEditRules.withFormatting(old, "html")
        XCTAssertEqual(WorkflowEditRules.target(send, "telegram")?.formatting, "html")
        // Editing the chat id keeps the formatting.
        let html = WorkflowEditRules.target(send, "telegram")
        send = WorkflowEditRules.setTarget(send, platform: "telegram",
                                           WorkflowEditRules.telegramTarget(chatID: " -1002 ", formatting: html?.formatting))
        XCTAssertEqual(WorkflowEditRules.target(send, "telegram")?.chatId, "-1002")
        XCTAssertEqual(WorkflowEditRules.target(send, "telegram")?.formatting, "html")
        // Only the three values.
        XCTAssertEqual(WorkflowEditRules.formatting(of: WorkflowSendTarget(platform: "telegram", formatting: "Markdown")), "plain")
        XCTAssertEqual(WorkflowEditRules.target(WorkflowEditRules.withFormatting(send, "bogus"), "telegram")?.formatting, "plain")
        XCTAssertEqual(WorkflowEditRules.target(WorkflowEditRules.withFormatting(send, "markdown_v2"), "telegram")?.formatting, "markdown_v2")
        let none = WorkflowSend(targets: [WorkflowEditRules.conversationTarget(nil)])
        XCTAssertEqual(WorkflowEditRules.withFormatting(none, "html"), none)

        // A workflow from the hub keeps the field through this app's load and save.
        let raw = #"{"targets":[{"platform":"telegram","chat_id":"-1001","formatting":"html"}]}"#
        let loaded = try JSONDecoder().decode(WorkflowSend.self, from: Data(raw.utf8))
        XCTAssertEqual(try json(loaded.targets[0])["formatting"] as? String, "html")
    }

    func testTheSendMessageEntryAddsANotifyStepWithNoTargetYet() throws {
        var draft = empty()
        draft.name = "Report"
        WorkflowEditRules.add(.agent, title: "A", to: &draft)
        let id = WorkflowEditRules.addSend(title: "Send message", to: &draft)
        XCTAssertEqual(id, "notify_1")
        XCTAssertEqual(draft.nodes.last?.kind, .notify)
        XCTAssertEqual(draft.nodes.last?.title, "Send message")
        XCTAssertEqual(draft.nodes.last?.send, WorkflowSend(targets: []))
        XCTAssertEqual(draft.edges.last.map { "\($0.from)>\($0.to)" }, "agent_1>notify_1")
        let sent = try json(XCTUnwrap(WorkflowEditRules.write(draft, clearing: false).nodes?.last))
        XCTAssertEqual((sent["send"] as? [String: Any])?["targets"] as? [String], [])
    }

    private func saved(onFailure: WorkflowFailureAlert?) -> Workflow {
        Workflow(id: "01J8QK3ZR2W7M5N4P6T8V9X0WF", profile: "work", ownerId: "u1", createdAt: Fixture.date, updatedAt: Fixture.date,
                 name: "Report", nodes: [], edges: [], status: .idle, runCount: 0, scheduleCount: 0, limits: WorkflowLimits(),
                 onFailure: onFailure)
    }

    func testTheFailureAlertIsWrittenOnlyWhenChangedAndClearedWithANull() throws {
        let alert = WorkflowFailureAlert(inbox: true, send: WorkflowSend(targets: [WorkflowSendTarget(platform: "telegram", chatId: "-1")]))
        var draft = WorkflowEditRules.draft(saved(onFailure: alert))
        XCTAssertEqual(draft.onFailure, alert)
        // Untouched: left out, so the hub keeps what it has (and what this app cannot read).
        let untouched = WorkflowEditRules.write(draft, clearing: true)
        XCTAssertNil(untouched.onFailure)
        XCTAssertFalse(untouched.sendNull.contains(.onFailure))
        XCTAssertFalse(try json(untouched).keys.contains("on_failure"))
        // The inbox alone: the alert, with no targets (an explicit null).
        WorkflowEditRules.setAlert(inbox: true, send: WorkflowSend(targets: []), in: &draft)
        let inbox = try json(WorkflowEditRules.write(draft, clearing: true))
        let written = try XCTUnwrap(inbox["on_failure"] as? [String: Any])
        XCTAssertEqual(written["inbox"] as? Bool, true)
        XCTAssertTrue(written["send"] is NSNull)
        // Targets alone keep an alert too.
        WorkflowEditRules.setAlert(inbox: false, send: WorkflowSend(targets: [WorkflowSendTarget(platform: "core_hub")]), in: &draft)
        XCTAssertEqual(draft.onFailure?.inbox, false)
        XCTAssertEqual(draft.onFailure?.send?.targets.count, 1)
        // Nothing left: cleared on the hub with a null.
        WorkflowEditRules.setAlert(inbox: false, send: WorkflowSend(targets: []), in: &draft)
        XCTAssertNil(draft.onFailure)
        let cleared = WorkflowEditRules.write(draft, clearing: true)
        XCTAssertTrue(cleared.sendNull.contains(.onFailure))
        XCTAssertTrue(try json(cleared)["on_failure"] is NSNull)
        // A new workflow (a copy) carries what it has and never sends a null.
        let copy = WorkflowEditRules.copy(saved(onFailure: alert), name: "Report (copy)")
        XCTAssertEqual(WorkflowEditRules.write(copy, clearing: false).onFailure, alert)
        var fresh = empty()
        WorkflowEditRules.setAlert(inbox: false, send: nil, in: &fresh)
        XCTAssertFalse(WorkflowEditRules.write(fresh, clearing: false).sendNull.contains(.onFailure))
    }

    func testATriggersAddressIsTheHubTheAppIsSignedInToAndItsPath() {
        XCTAssertEqual(WorkflowEditRules.triggerURL(hub: "https://hub.example/", path: "/hooks/T1"), "https://hub.example/hooks/T1")
        XCTAssertEqual(WorkflowEditRules.triggerURL(hub: "http://10.0.0.2:8080", path: "/hooks/T1"), "http://10.0.0.2:8080/hooks/T1")
    }

    func testTryingAStepSendsItAsWrittenWithTheSamplesAndRefusesBadJSON() throws {
        var draft = empty()
        WorkflowEditRules.add(.notify, title: "Tell", to: &draft)
        draft.nodes[0].agentId = "stray"
        XCTAssertEqual(WorkflowEditRules.stepTest(node: draft.nodes[0], input: "", trigger: "{not json", execute: false), .failure(.badJSON))
        guard case .success(let body) = WorkflowEditRules.stepTest(node: draft.nodes[0], input: "  ", trigger: WorkflowEditRules.sampleTrigger, execute: true) else {
            return XCTFail("the sample event is valid JSON")
        }
        XCTAssertNil(body.node.agentId, "the step as it would be saved")
        XCTAssertEqual(body.execute, false, "only an agent step runs for real")
        XCTAssertNil(body.input)
        XCTAssertTrue(try json(body)["input"] is NSNull, "no sample input is an explicit null")
        XCTAssertEqual(body.trigger?["event"], JSONValue.string("taskStatusUpdated"))
        XCTAssertEqual(body.trigger?["task_id"], JSONValue.string("sample-task"))
        XCTAssertEqual(body.trigger?["body"]?["history_items"]?[0]?["after"]?["status"], JSONValue.string("review"))
        var agent = empty()
        WorkflowEditRules.add(.agent, title: "A", to: &agent, agentID: "A1")
        guard case .success(let run) = WorkflowEditRules.stepTest(node: agent.nodes[0], input: " hi ", trigger: "", execute: true) else {
            return XCTFail("an empty event is no event")
        }
        XCTAssertEqual(run.execute, true)
        XCTAssertEqual(run.input, "hi")
        XCTAssertNil(run.trigger)
        XCTAssertEqual(run.node.agentId, "A1")
    }

    func testTheLiveCheckSendsTheDrawingWithoutTheName() {
        // A new drawing has no name yet; the check never reads it and an older hub refused "".
        var draft = empty()
        WorkflowEditRules.add(.agent, title: "A", to: &draft, agentID: "A1")
        WorkflowEditRules.add(.notify, title: "B", to: &draft)
        WorkflowEditRules.connect("agent_1", to: "notify_1", route: .success, in: &draft)
        let check = WorkflowEditRules.check(draft)
        XCTAssertNil(check.name)
        XCTAssertEqual(check.nodes, WorkflowEditRules.write(draft, clearing: false).nodes)
        XCTAssertEqual(check.edges?.map(\.id), ["e1"])
        draft.name = "Morning"
        XCTAssertNil(WorkflowEditRules.check(draft).name, "named or not, the check leaves the name out")
    }

    func testFindingsAreSaidPerStepInThePersonsLanguage() {
        let l10n = L10n(.en, bundle: Bundle(for: AppModel.self))
        let mine = WorkflowIssue(code: "agent_missing", nodeId: "agent_1", message: "hub words")
        let unknown = WorkflowIssue(code: "something_new", message: "The hub's own words")
        let general = WorkflowIssue(code: "workflow_empty", message: "x")
        let validation = WorkflowValidation(valid: false, problems: [mine, general], warnings: [unknown])
        XCTAssertEqual(WorkflowEditRules.issues(validation, node: "agent_1"), [mine])
        XCTAssertEqual(WorkflowEditRules.general(validation), [general, unknown])
        XCTAssertTrue(WorkflowEditRules.isProblem(validation, mine))
        XCTAssertFalse(WorkflowEditRules.isProblem(validation, unknown))
        XCTAssertEqual(WorkflowEditRules.describe(mine, l10n), l10n("workflow_editor.issues.agent_missing"))
        XCTAssertEqual(WorkflowEditRules.describe(unknown, l10n), "The hub's own words")
    }

    func testSavedLimitsAreReadFromTheFields() {
        let (limits, problem) = WorkflowEditRules.limits(minutes: "30", cost: "2.5", stepMinutes: "")
        XCTAssertNil(problem)
        XCTAssertEqual(limits?.maxDurationSeconds, 1800)
        XCTAssertEqual(limits?.maxCost?.amount, "2.50")
        XCTAssertNil(limits?.stepTimeoutSeconds)
        XCTAssertEqual(WorkflowEditRules.limits(minutes: "0", cost: "", stepMinutes: "").1, .duration)
        let (none, _) = WorkflowEditRules.limits(minutes: "", cost: "", stepMinutes: "")
        XCTAssertEqual(none, WorkflowLimits(), "every field empty: no limit at all")
    }
}

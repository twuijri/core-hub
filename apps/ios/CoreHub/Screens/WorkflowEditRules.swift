// Drawing a workflow on the phone: the rules, apart from the views so they are unit-tested (the
// web's `schedules/workflows/model.ts` does the same for its canvas). A phone draws the steps as a
// list and the links as each step's "what follows"; what is saved is the contract's own
// `WorkflowWrite`, positions included, so the same workflow opens on the web's canvas unchanged.
// The hub stays the judge of what is valid (`schedules.validateWorkflow`).
import CoreHubClient
import Foundation

enum WorkflowEditRules {
    /// The longest wait a delay step takes (`MAX_DELAY_SECONDS` on the hub).
    static let maxDelaySeconds = 3600
    /// The size the web draws a step at, and the gap it leaves, so a step added here lands on the
    /// canvas where the web would put it.
    static let nodeWidth: Double = 208
    static let nodeHeight: Double = 76
    private static let gapX: Double = 72
    private static let gapY: Double = 40
    static let kinds: [WorkflowNode.Kind] = [.agent, .condition, .delay, .notify, .approval]

    /// What is being drawn.
    struct Draft: Hashable {
        var name: String
        var description: String
        var workingDir: String?
        var nodes: [WorkflowNode]
        var edges: [WorkflowEdge]
        var limits: WorkflowLimits?
        /// Who is told when a run fails (§127), as saved or as changed here.
        var onFailure: WorkflowFailureAlert? = nil
        /// The person changed the failure alert while editing: only then is it written, so an
        /// alert this app did not touch (or cannot read) stays as the hub has it.
        var alertTouched = false
    }

    static func draft(_ workflow: Workflow?) -> Draft {
        guard let workflow else { return Draft(name: "", description: "", workingDir: nil, nodes: [], edges: [], limits: nil) }
        return Draft(name: workflow.name, description: workflow.description ?? "", workingDir: workflow.workingDir,
                     nodes: workflow.nodes, edges: workflow.edges, limits: workflow.limits, onFailure: workflow.onFailure)
    }

    /// A copy of a saved workflow under a new name («… (copy)»).
    static func copy(_ workflow: Workflow, name: String) -> Draft {
        var copy = draft(workflow)
        copy.name = name
        return copy
    }

    // MARK: - Steps

    /// A fresh id for a step of this kind: `agent_1`, `agent_2`, … never one already taken.
    static func nextNodeID(_ kind: WorkflowNode.Kind, _ nodes: [WorkflowNode]) -> String {
        let taken = Set(nodes.map(\.id))
        var n = 1
        while taken.contains("\(kind.rawValue)_\(n)") { n += 1 }
        return "\(kind.rawValue)_\(n)"
    }

    static func nextEdgeID(_ edges: [WorkflowEdge]) -> String {
        let taken = Set(edges.map(\.id))
        var n = 1
        while taken.contains("e\(n)") { n += 1 }
        return "e\(n)"
    }

    /// What a new step says until someone changes it: runnable where it can be.
    static func defaultInput(_ kind: WorkflowNode.Kind) -> String {
        switch kind {
        case .delay: return "60"
        case .condition: return "input exists"
        default: return ""
        }
    }

    /// Where a new step goes on the canvas: after `after` (or the last step), along the reading
    /// direction; below it when that spot is taken.
    static func place(_ draft: Draft, after: String?) -> WorkflowNodePosition {
        guard let anchor = draft.nodes.first(where: { $0.id == after }) ?? draft.nodes.last else {
            return WorkflowNodePosition(x: 40, y: 40)
        }
        var spot = WorkflowNodePosition(x: anchor.position.x + nodeWidth + gapX, y: anchor.position.y)
        func overlaps(_ p: WorkflowNodePosition) -> Bool {
            draft.nodes.contains { abs($0.position.x - p.x) < nodeWidth && abs($0.position.y - p.y) < nodeHeight }
        }
        var guardCount = 0
        while overlaps(spot) && guardCount < 50 {
            spot = WorkflowNodePosition(x: spot.x, y: spot.y + nodeHeight + gapY)
            guardCount += 1
        }
        return spot
    }

    /// Adds a step after `after` (or at the end) and, when there is a step before it, links the two
    /// on success, as the phone has no canvas to draw that link on. Returns the new step's id.
    @discardableResult
    static func add(_ kind: WorkflowNode.Kind, title: String, to draft: inout Draft, after: String? = nil, agentID: String? = nil) -> String {
        let id = nextNodeID(kind, draft.nodes)
        let previous = after ?? draft.nodes.last?.id
        let node = WorkflowNode(
            id: id, kind: kind, title: title, agentId: kind == .agent ? agentID : nil,
            skills: [], input: defaultInput(kind), approvalRequired: false, position: place(draft, after: previous)
        )
        draft.nodes.append(node)
        if let previous { connect(previous, to: id, route: .success, in: &draft) }
        return id
    }

    /// The palette's "Send message" (§124): a notify step titled as it, with no target yet. It stays
    /// a `notify` node, so an app that does not know `send` still opens the workflow.
    @discardableResult
    static func addSend(title: String, to draft: inout Draft) -> String {
        let id = add(.notify, title: title, to: &draft)
        if let index = draft.nodes.firstIndex(where: { $0.id == id }) {
            draft.nodes[index].send = WorkflowSend(targets: [])
        }
        return id
    }

    /// Removes a step and every link to or from it: a link never outlives either end.
    static func remove(_ nodeID: String, from draft: inout Draft) {
        draft.nodes.removeAll { $0.id == nodeID }
        draft.edges.removeAll { $0.from == nodeID || $0.to == nodeID }
    }

    /// Links two steps on a route once; the id of the link, or nil when it cannot be made.
    @discardableResult
    static func connect(_ from: String, to: String, route: WorkflowEdge.Route, in draft: inout Draft) -> String? {
        let ids = Set(draft.nodes.map(\.id))
        guard from != to, ids.contains(from), ids.contains(to) else { return nil }
        if let existing = draft.edges.first(where: { $0.from == from && $0.to == to && $0.route == route }) { return existing.id }
        let id = nextEdgeID(draft.edges)
        draft.edges.append(WorkflowEdge(id: id, from: from, to: to, route: route))
        return id
    }

    /// Moves a step one place up or down the list (and so in the order a phone reads them).
    static func move(_ nodeID: String, by offset: Int, in draft: inout Draft) {
        guard let index = draft.nodes.firstIndex(where: { $0.id == nodeID }) else { return }
        let target = index + offset
        guard draft.nodes.indices.contains(target) else { return }
        draft.nodes.swapAt(index, target)
    }

    /// The steps that can have finished before this one: everything with a path to it. These are
    /// the `{{steps.<id>.output}}` a prompt can use.
    static func upstream(_ draft: Draft, of nodeID: String) -> [WorkflowNode] {
        var into: [String: [String]] = [:]
        for edge in draft.edges { into[edge.to, default: []].append(edge.from) }
        var seen = Set<String>()
        var stack = into[nodeID] ?? []
        while let id = stack.popLast() {
            if seen.contains(id) || id == nodeID { continue }
            seen.insert(id)
            stack.append(contentsOf: into[id] ?? [])
        }
        return draft.nodes.filter { seen.contains($0.id) }
    }

    // MARK: - Saving

    /// The drawing as the contract's `WorkflowWrite`: what `createWorkflow`/`updateWorkflow` take.
    static func write(_ draft: Draft, clearing: Bool) -> WorkflowWrite {
        let description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let nodes = draft.nodes.map { node -> WorkflowNode in
            var out = node
            if node.kind != .agent {
                out.agentId = nil
                out.model = nil
                out.provider = nil
            }
            if node.kind == .approval { out.approvalRequired = false }
            // A condition with no rule left answers from its single line again (§123).
            if node.kind == .condition, let rules = node.rules, rules.items.isEmpty {
                out.rules = nil
                out.sendNull.insert(.rules)
            }
            return out
        }
        var clear: Set<WorkflowWrite.Clearable> = clearing && description.isEmpty ? [.description] : []
        // The failure alert (§127) goes only once the person changed it here (a new workflow or a
        // copy carries what it has); emptied, it is cleared on the hub with an explicit null.
        let alert = draft.alertTouched || !clearing ? draft.onFailure : nil
        if clearing && draft.alertTouched && draft.onFailure == nil { clear.insert(.onFailure) }
        return WorkflowWrite(
            name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description,
            workingDir: draft.workingDir,
            nodes: nodes,
            edges: draft.edges,
            limits: draft.limits,
            onFailure: alert,
            sendNull: clear
        )
    }

    /// The drawing as the hub's live check takes it (`WorkflowCheck`): what saving sends, without
    /// the name — the check never reads it, and a hub older than the check's own body refused an
    /// empty one, so an unnamed drawing is checked on every hub.
    static func check(_ draft: Draft) -> WorkflowCheck {
        let saved = write(draft, clearing: false)
        return WorkflowCheck(
            description: saved.description,
            workingDir: saved.workingDir,
            nodes: saved.nodes,
            edges: saved.edges,
            limits: saved.limits
        )
    }

    /// A trigger's address on the hub the phone is signed in to.
    static func triggerURL(hub: String, path: String) -> String {
        (hub.hasSuffix("/") ? String(hub.dropLast()) : hub) + path
    }

    /// Saving waits for a name and for the hub's check to find no problem.
    static func canSave(_ draft: Draft, validation: WorkflowValidation?) -> Bool {
        !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (validation?.valid ?? true)
    }

    // MARK: - The hub's check

    static func issues(_ validation: WorkflowValidation?, node: String) -> [WorkflowIssue] {
        ((validation?.problems ?? []) + (validation?.warnings ?? [])).filter { $0.nodeId == node }
    }

    static func general(_ validation: WorkflowValidation?) -> [WorkflowIssue] {
        ((validation?.problems ?? []) + (validation?.warnings ?? [])).filter { $0.nodeId == nil && $0.edgeId == nil }
    }

    static func edgeIssues(_ validation: WorkflowValidation?, edge: String) -> [WorkflowIssue] {
        ((validation?.problems ?? []) + (validation?.warnings ?? [])).filter { $0.edgeId == edge }
    }

    static func isProblem(_ validation: WorkflowValidation?, _ issue: WorkflowIssue) -> Bool {
        (validation?.problems ?? []).contains(issue)
    }

    /// A finding in the person's language; a code this app does not know, in the hub's words.
    static func describe(_ issue: WorkflowIssue, _ l10n: L10n) -> String {
        let key = "workflow_editor.issues.\(issue.code)"
        return l10n.has(key) ? l10n(key, ["detail": issue.detail ?? ""]) : issue.message
    }

    // MARK: - Conditions

    /// The comparisons the engine understands, in the order offered.
    static let operators = ["==", "!=", ">", ">=", "<", "<=", "contains", "matches", "exists", "empty"]
    static let unary: Set<String> = ["exists", "empty"]
    static let operatorKey: [String: String] = [
        "==": "eq", "!=": "ne", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte",
        "contains": "contains", "matches": "matches", "exists": "exists", "empty": "empty",
    ]

    struct Condition: Equatable {
        var path: String
        var op: String
        var value: String
    }

    /// A condition's text as its three parts, or nil when it is not one comparison the form can
    /// show (the form then offers the text as it is).
    static func split(_ text: String) -> Condition? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return Condition(path: "", op: "==", value: "") }
        for op in ["exists", "empty"] where trimmed.hasSuffix(" \(op)") {
            return Condition(path: String(trimmed.dropLast(op.count + 1)).trimmingCharacters(in: .whitespaces), op: op, value: "")
        }
        for op in ["==", "!=", ">=", "<=", "contains", "matches", ">", "<"] {
            guard let range = trimmed.range(of: " \(op) ") else { continue }
            var raw = String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespaces)
            if raw.count >= 2, (raw.hasPrefix("\"") && raw.hasSuffix("\"")) || (raw.hasPrefix("'") && raw.hasSuffix("'")) {
                raw = String(raw.dropFirst().dropLast())
            }
            return Condition(path: String(trimmed[..<range.lowerBound]).trimmingCharacters(in: .whitespaces), op: op, value: raw)
        }
        return nil
    }

    /// The three parts as the text the engine reads; a value that is not a number is quoted.
    static func join(_ condition: Condition) -> String {
        let path = condition.path.trimmingCharacters(in: .whitespaces)
        if unary.contains(condition.op) { return "\(path) \(condition.op)" }
        let value = condition.value.trimmingCharacters(in: .whitespaces)
        let numeric = !value.isEmpty && Double(value) != nil
        return "\(path) \(condition.op) \(numeric ? value : "\"\(condition.value)\"")"
    }

    // MARK: - Several rules (§123)

    /// What a run a trigger started can read about its event, offered while a rule's path is edited.
    static let triggerPaths = [
        "trigger.event",
        "trigger.task_id",
        "trigger.event_id",
        "trigger.body.history_items.0.field",
        "trigger.body.history_items.0.after.status",
    ]

    /// A rule to start from: the single comparison when there is one, else the trigger's event.
    static func firstRule(_ input: String?) -> WorkflowRule {
        if let parts = split(input ?? ""), !parts.path.trimmingCharacters(in: .whitespaces).isEmpty {
            return WorkflowRule(path: parts.path, _operator: parts.op, value: unary.contains(parts.op) ? nil : parts.value)
        }
        return WorkflowRule(path: "trigger.event", _operator: "==", value: "")
    }

    /// "Several rules" on: every rule must hold, starting from the step's own comparison. Off:
    /// the rules go, sent as an explicit null so the hub drops them too (a node without the field
    /// keeps the saved rules).
    static func setSeveralRules(_ on: Bool, node: inout WorkflowNode) {
        if on {
            node.rules = WorkflowRules(match: .all, items: [firstRule(node.input)])
            node.sendNull.remove(.rules)
        } else {
            node.rules = nil
            node.sendNull.insert(.rules)
        }
    }

    /// One rule changed. `exists` and `empty` carry no value (null); another operator after them
    /// starts from an empty one. The operator stays the plain string the contract carries.
    static func setRule(_ rules: WorkflowRules, at index: Int, path: String? = nil, op: String? = nil, value: String? = nil) -> WorkflowRules {
        guard rules.items.indices.contains(index) else { return rules }
        var next = rules
        var rule = next.items[index]
        if let path { rule.path = path }
        if let op { rule._operator = op }
        if let value { rule.value = value }
        if unary.contains(rule._operator) {
            rule.value = nil
        } else if rule.value == nil {
            rule.value = ""
        }
        next.items[index] = rule
        return next
    }

    /// "Add a rule": another comparison of the trigger's event.
    static func addRule(_ rules: WorkflowRules) -> WorkflowRules {
        var next = rules
        next.items.append(WorkflowRule(path: "trigger.event", _operator: "==", value: ""))
        return next
    }

    /// Removes a rule; the last one stays (switch "Several rules" off instead).
    static func removeRule(_ rules: WorkflowRules, at index: Int) -> WorkflowRules {
        guard rules.items.count > 1, rules.items.indices.contains(index) else { return rules }
        var next = rules
        next.items.remove(at: index)
        return next
    }

    /// The paths offered for a rule of this step: the trigger's, the run's input, earlier steps'.
    static func ruleSuggestions(_ draft: Draft, of nodeID: String) -> [String] {
        triggerPaths + ["input"] + upstream(draft, of: nodeID).map { "steps.\($0.id).output" }
    }

    // MARK: - Send message (§124) and the failure alert (§127)

    static let telegram = "telegram"
    static let coreHub = "core_hub"

    /// The target of one platform, if the step sends there.
    static func target(_ send: WorkflowSend?, _ platform: String) -> WorkflowSendTarget? {
        send?.targets.first { $0.platform == platform }
    }

    /// Replaces (or, with nil, removes) the target of one platform; every other target — one of a
    /// platform this app does not know among them — stays as it is.
    static func setTarget(_ send: WorkflowSend, platform: String, _ target: WorkflowSendTarget?) -> WorkflowSend {
        var targets = send.targets.filter { $0.platform != platform }
        if let target { targets.append(target) }
        return WorkflowSend(targets: targets)
    }

    static func telegramTarget(chatID: String) -> WorkflowSendTarget {
        WorkflowSendTarget(platform: telegram, chatId: chatID.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// A conversation of the profile, with what lets the hub make it again if it is deleted; none
    /// picked yet: the platform alone.
    static func conversationTarget(_ session: Session?) -> WorkflowSendTarget {
        guard let session else { return WorkflowSendTarget(platform: coreHub) }
        return WorkflowSendTarget(platform: coreHub, sessionId: session.id, title: session.title, agentId: session.agentId)
    }

    /// A variable of the step's words, read with the hub's own pattern (`expr.ts` `pathsIn`).
    private static let variable = try! NSRegularExpression(pattern: #"\{\{\s*([A-Za-z0-9_.]+)\s*\}\}"#)

    /// Every variable of the words, once each, in order (`steps.analysis.output`, `input`).
    static func variables(in text: String?) -> [String] {
        let text = text ?? ""
        var out: [String] = []
        for match in variable.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range(at: 1), in: text) else { continue }
            let path = String(text[range])
            if !out.contains(path) { out.append(path) }
        }
        return out
    }

    /// The variables that have no value yet (an empty one counts as none).
    static func missing(in text: String?, values: [String: String]) -> [String] {
        variables(in: text).filter { (values[$0] ?? "").isEmpty }
    }

    /// The words with each value put in; a variable without one stays as written (the preview).
    static func fill(_ text: String?, values: [String: String]) -> String {
        let text = text ?? ""
        var out = ""
        var last = text.startIndex
        for match in variable.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let whole = Range(match.range, in: text), let name = Range(match.range(at: 1), in: text) else { continue }
            out += text[last..<whole.lowerBound]
            let value = values[String(text[name])] ?? ""
            out += value.isEmpty ? String(text[whole]) : value
            last = whole.upperBound
        }
        out += text[last...]
        return out
    }

    /// "Send test message" needs a target, words, and a value for each variable (2026-09-29): a test
    /// never sends `{{steps.analysis.output}}` as it is.
    static func canTestSend(_ send: WorkflowSend, text: String?, values: [String: String] = [:]) -> Bool {
        !send.targets.isEmpty && !(text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && missing(in: text, values: values).isEmpty
    }

    /// The test carries the words with the values put in, so it says what the run will say.
    static func sendTest(_ send: WorkflowSend, text: String?, values: [String: String] = [:]) -> WorkflowSendTest {
        WorkflowSendTest(send: send, text: fill(text, values: values).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Each target that did not take it: "target: reason".
    static func failureLines(_ result: WorkflowSendResult) -> [String] {
        result.failures.map { "\($0.target): \($0.reason)" }
    }

    /// The failure alert as changed here, as the web writes it: the inbox or at least one target
    /// keeps an alert; nothing left clears it.
    static func setAlert(inbox: Bool, send: WorkflowSend?, in draft: inout Draft) {
        draft.alertTouched = true
        let targets = send?.targets ?? []
        guard inbox || !targets.isEmpty else {
            draft.onFailure = nil
            return
        }
        draft.onFailure = targets.isEmpty
            ? WorkflowFailureAlert(inbox: inbox, send: nil, sendNull: [.send])
            : WorkflowFailureAlert(inbox: inbox, send: WorkflowSend(targets: targets))
    }

    // MARK: - Test this step (§127)

    /// A ClickUp-shaped sample event to start from (the web's `SAMPLE_TRIGGER`).
    static let sampleTrigger = """
    {
      "event": "taskStatusUpdated",
      "task_id": "sample-task",
      "body": {
        "history_items": [
          {
            "field": "status",
            "after": {
              "status": "review"
            }
          }
        ]
      }
    }
    """

    enum StepTestProblem: Error, Equatable { case badJSON }

    /// What "Try it" sends: the step as it would be saved, the sample input (none when empty), the
    /// sample event read as JSON (none when empty), and a real agent turn only when asked for an
    /// agent step. Invalid JSON sends nothing.
    static func stepTest(node: WorkflowNode, input: String, trigger: String, execute: Bool) -> Result<WorkflowStepTest, StepTestProblem> {
        var event: JSONValue?
        let text = trigger.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return .failure(.badJSON) }
            event = value
        }
        let single = Draft(name: "test", description: "", workingDir: nil, nodes: [node], edges: [], limits: nil)
        let written = write(single, clearing: false).nodes?.first ?? node
        let sample = input.trimmingCharacters(in: .whitespacesAndNewlines)
        return .success(WorkflowStepTest(
            node: written,
            input: sample.isEmpty ? nil : sample,
            trigger: event,
            execute: node.kind == .agent && execute,
            sendNull: sample.isEmpty ? [.input] : []
        ))
    }

    // MARK: - Models

    /// A step's model as the picker names it: the catalogue's label, else the id as saved; nil for
    /// none (the agent's own model).
    static func modelLabel(_ value: String?, options: [ChatControls.ModelOption]) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return options.first { $0.value == value }?.label ?? value
    }

    // MARK: - Limits

    /// The saved limits as typed: an empty field has none; minutes become seconds within the hub's
    /// bounds (a week, a day); a cost is a positive USD amount.
    static func limits(minutes: String, cost: String, stepMinutes: String) -> (WorkflowLimits?, WorkflowLogic.LimitProblem?) {
        let (override, problem) = WorkflowLogic.limits(minutes: minutes, cost: cost, stepMinutes: stepMinutes)
        if let problem { return (nil, problem) }
        return (WorkflowLimits(maxDurationSeconds: override?.maxDurationSeconds, maxCost: override?.maxCost, stepTimeoutSeconds: override?.stepTimeoutSeconds), nil)
    }
}

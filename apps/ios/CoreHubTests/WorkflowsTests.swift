@testable import CoreHub
import CoreHubClient
import XCTest

/// Workflows on the phone (B13): the run view's rules.
final class WorkflowsTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_790_000_000)

    private func node(_ id: String, _ title: String, kind: WorkflowNode.Kind = .agent) -> WorkflowNode {
        WorkflowNode(id: id, kind: kind, title: title, skills: [], approvalRequired: false, position: WorkflowNodePosition(x: 0, y: 0))
    }

    private func workflow() -> Workflow {
        Workflow(
            id: "wf", profile: "work", ownerId: "me", createdAt: date, updatedAt: date, name: "مراجعة ثم نشر",
            nodes: [node("review", "مراجعة"), node("publish", "نشر", kind: .approval), node("tell", "إشعار", kind: .notify)],
            edges: [], status: .idle, runCount: 4, scheduleCount: 0,
            limits: WorkflowLimits(maxDurationSeconds: 1800, maxCost: Money(amount: "2.00", currency: "USD"), stepTimeoutSeconds: nil)
        )
    }

    private func step(_ node: String, _ status: WorkflowStepStatus, approval: String? = nil) -> WorkflowStep {
        WorkflowStep(nodeId: node, attempt: 1, status: status, approvalId: approval, startedAt: date)
    }

    private func run(_ status: WorkflowRun.Status, _ steps: [WorkflowStep]) -> WorkflowRun {
        WorkflowRun(
            id: "run", profile: "work", ownerId: "me", createdAt: date, updatedAt: date, workflowId: "wf", jobId: "job",
            status: status, trigger: RunTrigger(kind: .user), steps: steps, limits: WorkflowLimits()
        )
    }

    func testALiveRunListsWhatRanThenTheNodesNotReachedYet() {
        let rows = WorkflowLogic.rows(workflow: workflow(), run: run(.waiting, [step("review", .succeeded), step("publish", .waitingApproval, approval: "ap")]))
        XCTAssertEqual(rows.map(\.nodeID), ["review", "publish", "tell"])
        XCTAssertEqual(rows.map(\.title), ["مراجعة", "نشر", "إشعار"])
        XCTAssertEqual(rows.last?.status, .pending)
        XCTAssertNil(rows.last?.step)
    }

    func testAFinishedRunShowsOnlyWhatRan() {
        let done = run(.failed, [step("review", .failed)])
        XCTAssertEqual(WorkflowLogic.rows(workflow: workflow(), run: done).map(\.nodeID), ["review"])
        XCTAssertTrue(WorkflowLogic.finished(done))
        XCTAssertFalse(WorkflowLogic.finished(run(.running, [])))
    }

    func testTheWaitingStepIsTheOneWithAnApprovalToAnswer() {
        XCTAssertEqual(WorkflowLogic.waiting(run(.waiting, [step("review", .succeeded), step("publish", .waitingApproval, approval: "ap")]))?.nodeId, "publish")
        XCTAssertNil(WorkflowLogic.waiting(run(.waiting, [step("publish", .waitingApproval)])))
    }

    func testTypedLimitsBecomeTheRunsOwnWithinTheHubsBounds() {
        XCTAssertNil(WorkflowLogic.limits(minutes: "", cost: "", stepMinutes: "").0)
        XCTAssertNil(WorkflowLogic.limits(minutes: "", cost: "", stepMinutes: "").1)
        let (limits, problem) = WorkflowLogic.limits(minutes: "30", cost: "1,5", stepMinutes: "10")
        XCTAssertNil(problem)
        XCTAssertEqual(limits?.maxDurationSeconds, 1800)
        XCTAssertEqual(limits?.maxCost?.amount, "1.50")
        XCTAssertEqual(limits?.maxCost?.currency, "USD")
        XCTAssertEqual(limits?.stepTimeoutSeconds, 600)
        XCTAssertEqual(WorkflowLogic.limits(minutes: "20000", cost: "", stepMinutes: "").1, .duration)
        XCTAssertEqual(WorkflowLogic.limits(minutes: "", cost: "", stepMinutes: "0").1, .step)
        XCTAssertEqual(WorkflowLogic.limits(minutes: "", cost: "-1", stepMinutes: "").1, .cost)
        XCTAssertEqual(WorkflowLogic.limits(minutes: "", cost: "0.001", stepMinutes: "").1, .cost)
        XCTAssertEqual(WorkflowLogic.minutes(1800), 30)
        XCTAssertEqual(WorkflowLogic.minutes(1), 1)
    }

    func testTheLimitFactsAreInThePersonsLanguage() {
        let facts = WorkflowLogic.facts(workflow().limits, L10n(.en, bundle: Bundle(for: AppModel.self)))
        XCTAssertEqual(facts, ["30 min", "$2.00"])
    }
}

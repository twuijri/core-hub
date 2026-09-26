@testable import CoreHub
import CoreHubClient
import XCTest

/// The Tasks board on the phone (B15): the web's columns and drop rules, reorder, and the §93 badges.
final class BoardTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_790_000_000)

    private func task(_ id: String, _ status: TaskStatus, profile: String = "work", waiting: [TaskDependencyState]? = nil, stuck: Date? = nil) -> HubTask {
        HubTask(
            id: id, profile: profile, ownerId: "me", createdAt: date, updatedAt: date, projectId: "p", title: "t\(id)",
            status: status, priority: .normal, tags: [], autoStart: false, position: "a0",
            subtaskCounts: HubTaskAllOfSubtaskCounts(total: 0, done: 0), dependsOn: [], lastRun: HubTaskAllOfLastRun(),
            attemptCount: 0, attachmentIds: [], waitingOn: waiting, stuckSince: stuck
        )
    }

    private func column(_ id: BoardLogic.ColumnID) -> BoardLogic.Column {
        BoardLogic.columns.first { $0.id == id }!
    }

    func testNineStatusesShowAsAnIntakeAndFourColumns() {
        XCTAssertEqual(BoardLogic.column(of: .triage).id, .intake)
        XCTAssertEqual(BoardLogic.column(of: .running).id, .queue)
        XCTAssertEqual(BoardLogic.column(of: .blocked).id, .waiting)
        XCTAssertEqual(BoardLogic.column(of: .archived).id, .done)
        let board = CoreHubClient.TaskColumns(
            columns: [
                TaskColumnsColumnsInner(status: .triage, count: 1, tasks: [task("1", .triage)]),
                TaskColumnsColumnsInner(status: .todo, count: 1, tasks: [task("2", .todo)]),
                TaskColumnsColumnsInner(status: .ready, count: 1, tasks: [task("3", .ready)]),
                TaskColumnsColumnsInner(status: .archived, count: 7, tasks: []),
            ],
            counts: StatusCounts(total: 3, byStatus: ["archived": 7])
        )
        let grouped = BoardLogic.group(board)
        XCTAssertEqual(grouped[.intake]?.map(\.id), ["1"])
        XCTAssertEqual(grouped[.queue]?.map(\.id), ["2", "3"])
        XCTAssertEqual(BoardLogic.archived(board), 7)
    }

    func testADropMeansTheMoveAPersonMayMakeAndAsksWhenItCanMeanTwo() {
        let todo = task("1", .todo)
        guard case .choose(let options) = BoardLogic.outcome(task: todo, column: column(.waiting), columnTasks: [], index: 0) else {
            return XCTFail("Waiting means scheduled or blocked")
        }
        XCTAssertEqual(options.map(\.to), [.scheduled, .blocked])
        XCTAssertTrue(options[1].transition.requiresReason)
        XCTAssertEqual(BoardLogic.outcome(task: todo, column: column(.done), columnTasks: [], index: 0), .refused)
        guard case .move(let drop) = BoardLogic.outcome(task: task("2", .review), column: column(.done), columnTasks: [], index: 0) else {
            return XCTFail("review into done is one move")
        }
        XCTAssertEqual(drop.to, .done)
        XCTAssertFalse(BoardLogic.isDropTarget(from: .todo, column: BoardLogic.intake))
        XCTAssertTrue(BoardLogic.isDropTarget(from: .triage, column: column(.queue)))
    }

    func testInsideItsColumnADropIsAReorderAfterTheCardAboveInTheSameProfile() {
        let a = task("a", .todo), b = task("b", .ready, profile: "home"), c = task("c", .todo), d = task("d", .todo)
        let queue = [a, b, c, d]
        XCTAssertEqual(BoardLogic.outcome(task: d, column: column(.queue), columnTasks: queue, index: 0), .reordered(afterTaskID: nil))
        XCTAssertEqual(BoardLogic.outcome(task: a, column: column(.queue), columnTasks: queue, index: 2), .reordered(afterTaskID: "c"))
        XCTAssertEqual(BoardLogic.outcome(task: d, column: column(.queue), columnTasks: queue, index: 2), .reordered(afterTaskID: "a"))
        XCTAssertEqual(BoardLogic.outcome(task: c, column: column(.queue), columnTasks: queue, index: 2), .unchanged)
    }

    func testWaitingFoldsWhileEmptyUnlessOpenedOrTheDraggedCardMayLandThere() {
        let waiting = column(.waiting)
        XCTAssertTrue(BoardLogic.collapsed(waiting, count: 0, openedByHand: false, dragging: nil))
        XCTAssertFalse(BoardLogic.collapsed(waiting, count: 1, openedByHand: false, dragging: nil))
        XCTAssertFalse(BoardLogic.collapsed(waiting, count: 0, openedByHand: true, dragging: nil))
        XCTAssertFalse(BoardLogic.collapsed(waiting, count: 0, openedByHand: false, dragging: .todo))
        XCTAssertFalse(BoardLogic.collapsed(column(.review), count: 0, openedByHand: false, dragging: nil))
    }

    func testACardSaysWhatItWaitsOnAndWhenItsRunWentQuiet() {
        let waits = task("1", .ready, waiting: [TaskDependencyState(id: "t2", title: "اكتب الاختبارات", status: .running)])
        XCTAssertEqual(BoardLogic.waitingOn(waits), ["اكتب الاختبارات"])
        XCTAssertTrue(BoardLogic.waitingOn(task("2", .ready)).isEmpty)
        XCTAssertTrue(BoardLogic.stuck(task("3", .running, stuck: date)))
        XCTAssertFalse(BoardLogic.stuck(task("4", .review, stuck: date)))
        XCTAssertFalse(BoardLogic.showsStatusWord(.todo))
        XCTAssertTrue(BoardLogic.showsStatusWord(.running))
    }
}

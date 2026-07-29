import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyAddTaskIntentTests: XCTestCase {
    private let fixedNow = Date(timeIntervalSince1970: 1_700_000_000) // Tuesday 2023-11-14 22:13:20 UTC

    func testResolvesToTodaysColumnOnTheSelectedWeekBoard() throws {
        let snapshot = TaskifySnapshot.empty // starts with a single visible Week board, selected.

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: nil,
            now: fixedNow
        ))

        let expectedWeekday = WeekdayColumn.containing(fixedNow)
        XCTAssertEqual(destination.boardID, snapshot.selectedBoardID)
        XCTAssertEqual(destination.columnID, expectedWeekday.rawValue)
        XCTAssertEqual(
            destination.dueDate,
            WeekDateResolver.date(for: expectedWeekday, inWeekContaining: fixedNow)
        )
    }

    func testResolvesToTheFirstColumnByOrderOnAListBoard() throws {
        let list = Board(
            name: "Groceries",
            kind: .list,
            columns: [
                BoardColumn(id: "second", name: "Second", order: 2),
                BoardColumn(id: "first", name: "First", order: 1),
            ]
        )
        let snapshot = TaskifySnapshot(boards: [list], tasks: [], selectedBoardID: list.id)

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: nil,
            now: fixedNow
        ))

        XCTAssertEqual(destination.boardID, list.id)
        XCTAssertEqual(destination.columnID, "first")
        XCTAssertNil(destination.dueDate)
    }

    func testRequestedBoardNameOverridesTheSelectedBoardWithCaseInsensitiveMatch() throws {
        let selected = Board.week(id: "week-1", name: "Week")
        let groceries = Board(name: "Groceries", kind: .list, columns: [
            BoardColumn(id: "col", name: "To Buy", order: 0),
        ])
        let snapshot = TaskifySnapshot(boards: [selected, groceries], tasks: [], selectedBoardID: selected.id)

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: "groceries",
            now: fixedNow
        ))

        XCTAssertEqual(destination.boardID, groceries.id)
        XCTAssertEqual(destination.columnID, "col")
    }

    func testRequestedBoardNameFallsBackToSelectedBoardWhenNoMatchExists() throws {
        let selected = Board.week(id: "week-1", name: "Week")
        let snapshot = TaskifySnapshot(boards: [selected], tasks: [], selectedBoardID: selected.id)

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: "does not exist",
            now: fixedNow
        ))

        XCTAssertEqual(destination.boardID, selected.id)
    }

    func testCompoundBoardResolvesToItsFirstChildsFirstColumn() throws {
        let child = Board(id: "child-1", name: "Chores", kind: .list, columns: [
            BoardColumn(id: "col", name: "Todo", order: 0),
        ])
        let compound = Board(
            id: "compound-1",
            name: "Home",
            kind: .compound,
            children: [child.id]
        )
        let snapshot = TaskifySnapshot(boards: [compound, child], tasks: [], selectedBoardID: compound.id)

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: nil,
            now: fixedNow
        ))

        XCTAssertEqual(destination.boardID, child.id)
        XCTAssertEqual(destination.columnID, "col")
    }

    func testFallsBackToAnyAddableBoardWhenTheSelectedBoardIsBible() throws {
        let bible = Board(id: "bible-1", name: "Bible", kind: .bible)
        let week = Board.week(id: "week-1", name: "Week")
        let snapshot = TaskifySnapshot(boards: [bible, week], tasks: [], selectedBoardID: bible.id)

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: nil,
            now: fixedNow
        ))

        XCTAssertEqual(destination.boardID, week.id)
    }

    func testReturnsNilWhenNoAddableBoardExistsAtAll() {
        let bible = Board(id: "bible-1", name: "Bible", kind: .bible)
        let snapshot = TaskifySnapshot(boards: [bible], tasks: [], selectedBoardID: bible.id)

        XCTAssertNil(TaskifyAddTaskDestination.resolve(in: snapshot, requestedBoardName: nil, now: fixedNow))
    }

    func testAddTaskUsesTheGivenBoardTitleAndPositionMatchingSnapshotAddTask() throws {
        let list = Board(name: "Groceries", kind: .list, columns: [
            BoardColumn(id: "col", name: "To Buy", order: 0),
        ])
        var snapshot = TaskifySnapshot(boards: [list], tasks: [], selectedBoardID: list.id)
        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: nil,
            now: fixedNow
        ))

        let task = snapshot.addTask(
            title: "  Buy milk  ",
            boardID: destination.boardID,
            columnID: destination.columnID,
            dueDate: destination.dueDate
        )

        XCTAssertEqual(task?.title, "Buy milk")
        XCTAssertEqual(task?.boardID, list.id)
        XCTAssertEqual(task?.columnID, "col")
        XCTAssertEqual(snapshot.tasks.count, 1)
    }
}

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

    func testHiddenCompoundChildCanBeNamedAsADestination() throws {
        let workTasks = Board(
            id: "work-tasks",
            name: "Work Tasks",
            kind: .list,
            columns: [BoardColumn(id: "todo", name: "To Do", order: 0)],
            hidden: true
        )
        let work = Board(
            id: "work",
            name: "Work",
            kind: .compound,
            children: [workTasks.id]
        )
        let personal = Board.week(id: "personal", name: "Personal Schedule")
        let snapshot = TaskifySnapshot(
            boards: [personal, work, workTasks],
            tasks: [],
            selectedBoardID: personal.id
        )

        XCTAssertEqual(
            TaskifyAddTaskDestination.namedBoards(in: snapshot).map(\.name),
            ["Personal Schedule", "Work", "Work Tasks"]
        )

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: "Work Tasks",
            now: fixedNow
        ))
        XCTAssertEqual(destination.boardID, workTasks.id)
        XCTAssertEqual(destination.columnID, "todo")
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

    func testSpokenFollowUpSeparatesQuotedTitleAndExistingBoard() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Add “test” to my work tasks board",
            visibleBoardNames: ["Personal Schedule", "Work Tasks"]
        )

        XCTAssertEqual(request.title, "test")
        XCTAssertEqual(request.requestedBoardName, "Work Tasks")
    }

    func testSpokenDirectPhraseSeparatesTitleAndBoardWithoutBoardSuffix() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Add test to my work tasks in Taskify",
            visibleBoardNames: ["Personal Schedule", "Work Tasks"]
        )

        XCTAssertEqual(request.title, "test")
        XCTAssertEqual(request.requestedBoardName, "Work Tasks")
    }

    func testSpokenDirectPhraseTreatsTasksAsASuffixForShortBoardName() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Add test to my work tasks in Taskify",
            visibleBoardNames: ["Personal Schedule", "Work"]
        )

        XCTAssertEqual(request.title, "test")
        XCTAssertEqual(request.requestedBoardName, "Work")
    }

    func testSpokenFollowUpSeparatesUnquotedTitleAndExistingBoard() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Add buy printer paper to the Work Tasks board",
            visibleBoardNames: ["Personal Schedule", "Work Tasks"]
        )

        XCTAssertEqual(request.title, "buy printer paper")
        XCTAssertEqual(request.requestedBoardName, "Work Tasks")
    }

    func testSpokenOneShotOrderSeparatesBoardAndTitle() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Add a task in Taskify to my Work Tasks board titled “test”",
            visibleBoardNames: ["Personal Schedule", "Work Tasks"]
        )

        XCTAssertEqual(request.title, "test")
        XCTAssertEqual(request.requestedBoardName, "Work Tasks")
    }

    func testSpokenParserPrefersLongestMatchingBoardName() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Add review proposal to Work Tasks board",
            visibleBoardNames: ["Work", "Work Tasks"]
        )

        XCTAssertEqual(request.title, "review proposal")
        XCTAssertEqual(request.requestedBoardName, "Work Tasks")
    }

    func testSpokenParserDoesNotGuessUnknownBoardNames() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Research the school board",
            visibleBoardNames: ["Personal Schedule", "Work Tasks"]
        )

        XCTAssertEqual(request.title, "Research the school board")
        XCTAssertNil(request.requestedBoardName)
    }

    func testSpokenParserHandlesTerseAddFollowUp() {
        let request = TaskifySpokenTaskRequestParser.parse(
            "Add buy milk",
            visibleBoardNames: ["Personal Schedule"]
        )

        XCTAssertEqual(request.title, "buy milk")
        XCTAssertNil(request.requestedBoardName)
    }
}

import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyAddTaskIntentTests: XCTestCase {
    private let fixedNow = Date(timeIntervalSince1970: 1_700_000_000) // Tuesday 2023-11-14 22:13:20 UTC

    private func temporaryStore() throws -> (JSONTaskStore, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return (
            JSONTaskStore(fileURL: directory.appendingPathComponent("taskify.json")),
            directory
        )
    }

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

    func testStableBoardAndColumnIDsResolveTheExactSection() throws {
        let list = Board(
            id: "work-board",
            name: "Work",
            kind: .list,
            columns: [
                BoardColumn(id: "later", name: "Later", order: 1),
                BoardColumn(id: "now", name: "Now", order: 0),
            ]
        )
        let snapshot = TaskifySnapshot(boards: [list], tasks: [], selectedBoardID: list.id)

        let destination = try XCTUnwrap(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardID: list.id,
            requestedColumnID: "later",
            now: fixedNow
        ))

        XCTAssertEqual(destination.boardID, list.id)
        XCTAssertEqual(destination.columnID, "later")
    }

    func testStableBoardIDRejectsAColumnFromAnotherBoard() {
        let work = Board(
            id: "work",
            name: "Work",
            kind: .list,
            columns: [BoardColumn(id: "work-column", name: "To Do", order: 0)]
        )
        let home = Board(
            id: "home",
            name: "Home",
            kind: .list,
            columns: [BoardColumn(id: "home-column", name: "To Do", order: 0)]
        )
        let snapshot = TaskifySnapshot(boards: [work, home], tasks: [], selectedBoardID: work.id)

        XCTAssertNil(TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardID: work.id,
            requestedColumnID: "home-column",
            now: fixedNow
        ))
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

    func testExternalAddTaskSavesSettingsAndPendingPublicationInTheInjectedStore() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let list = Board(name: "Groceries", kind: .list, columns: [
            BoardColumn(id: "to-buy", name: "To Buy", order: 0),
        ])
        let existing = TaskItem(
            id: "existing",
            boardID: list.id,
            title: "Bread",
            order: 8,
            columnID: "to-buy"
        )
        try await store.save(TaskifySnapshot(
            boards: [list],
            tasks: [existing],
            selectedBoardID: list.id
        ))

        let created = try await TaskifyExternalActions.addTask(
            title: "  Buy milk  ",
            requestedBoardName: "groceries",
            note: "Two cartons",
            priority: .high,
            interpretNaturalLanguageTitle: false,
            store: store,
            settings: TaskifyDeviceTaskSettings(
                weekStart: .monday,
                newTaskPosition: .bottom,
                editorPublicKey: String(repeating: "a", count: 64)
            ),
            publisher: .disabled,
            now: fixedNow
        )

        let saved = try await store.load(areas: [.tasks])
        let task = try XCTUnwrap(saved.tasks.first { $0.id == created.task.id })
        XCTAssertEqual(task.title, "Buy milk")
        XCTAssertEqual(task.note, "Two cartons")
        XCTAssertEqual(task.priority, .high)
        XCTAssertEqual(task.boardID, list.id)
        XCTAssertEqual(task.columnID, "to-buy")
        XCTAssertEqual(task.order, 9)
        XCTAssertEqual(task.createdAt, fixedNow)
        XCTAssertEqual(task.createdBy, String(repeating: "a", count: 64))
        XCTAssertEqual(task.lastEditedBy, String(repeating: "a", count: 64))
        XCTAssertEqual(task.publishPending, true)
        XCTAssertEqual(created.board.id, list.id)
        XCTAssertEqual(created.displayBoard.id, list.id)
    }

    func testExternalAddTaskUsesStableSectionIDsInsteadOfDuplicateNames() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = Board(
            id: "first-work",
            name: "Work",
            kind: .list,
            columns: [BoardColumn(id: "first-todo", name: "To Do", order: 0)]
        )
        let second = Board(
            id: "second-work",
            name: "Work",
            kind: .list,
            columns: [
                BoardColumn(id: "second-todo", name: "To Do", order: 0),
                BoardColumn(id: "second-later", name: "Later", order: 1),
            ]
        )
        try await store.save(TaskifySnapshot(
            boards: [first, second],
            tasks: [],
            selectedBoardID: first.id
        ))

        let created = try await TaskifyExternalActions.addTask(
            title: "Review proposal",
            requestedBoardName: second.name,
            requestedBoardID: second.id,
            requestedColumnID: "second-later",
            store: store,
            publisher: .disabled,
            now: fixedNow
        )

        XCTAssertEqual(created.task.boardID, second.id)
        XCTAssertEqual(created.task.columnID, "second-later")
    }

    func testExternalAddTaskParsesNaturalTitleAndPresentsItsCompoundParent() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let child = Board(
            id: "home-tasks",
            name: "Home Tasks",
            kind: .list,
            columns: [BoardColumn(id: "todo", name: "To Do", order: 0)],
            hidden: true
        )
        let compound = Board(
            id: "home",
            name: "Home",
            kind: .compound,
            children: [child.id]
        )
        try await store.save(TaskifySnapshot(
            boards: [compound, child],
            tasks: [],
            selectedBoardID: compound.id
        ))

        let publisher = TaskifyExternalPublisher(
            prepare: { stamp in
                try TaskEventCodec.taskEvent(
                    task: stamp.task,
                    board: stamp.board,
                    createdAt: stamp.timestamp
                )
            },
            send: { _, _ in false }
        )
        let created = try await TaskifyExternalActions.addTask(
            title: "Add vacuum to my Home board",
            requestedBoardName: nil,
            interpretNaturalLanguageTitle: true,
            store: store,
            settings: TaskifyDeviceTaskSettings(),
            publisher: publisher,
            now: fixedNow
        )

        XCTAssertEqual(created.task.title, "vacuum")
        XCTAssertEqual(created.board.id, child.id)
        XCTAssertEqual(created.displayBoard.id, compound.id)
        let saved = try await store.load(areas: [.tasks])
        XCTAssertEqual(saved.tasks.first?.publishPending, true)
    }

    func testExternalAddTaskRejectsEmptyTitlesWithoutSaving() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await store.save(.empty)

        do {
            _ = try await TaskifyExternalActions.addTask(
                title: "   ",
                requestedBoardName: nil,
                store: store,
                publisher: .disabled,
                now: fixedNow
            )
            XCTFail("Expected an empty-title error")
        } catch {
            XCTAssertEqual(error as? TaskifyExternalAddTaskError, .emptyTitle)
        }
        let saved = try await store.load(areas: [.tasks])
        XCTAssertTrue(saved.tasks.isEmpty)
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

    func testSpokenBatchSplitsAListAndUsesOneNamedBoard() {
        let request = TaskifySpokenTaskBatchParser.parse(
            "Add standup, planning and retrospective to my Work Tasks board in Taskify",
            visibleBoardNames: ["Personal Schedule", "Work Tasks"]
        )

        XCTAssertEqual(request.titles, ["standup", "planning", "retrospective"])
        XCTAssertEqual(request.requestedBoardName, "Work Tasks")
    }

    func testSpokenBatchKeepsAQuotedConjunctionInOneTitle() {
        let request = TaskifySpokenTaskBatchParser.parse(
            "Add “Research and Development meeting” and staff meeting to Taskify",
            visibleBoardNames: ["Work"]
        )

        XCTAssertEqual(request.titles, ["Research and Development meeting", "staff meeting"])
    }

    func testSpokenBatchCleansNumberedAndCommandPrefixes() {
        let request = TaskifySpokenTaskBatchParser.parse(
            "These tasks: first add team sync; second create customer review; finally make retrospective",
            visibleBoardNames: []
        )

        XCTAssertEqual(request.titles, ["team sync", "customer review", "retrospective"])
    }

    func testSpokenBatchReportsItemsBeyondTheSafeLimit() {
        let spoken = (1...22).map { "task \($0)" }.joined(separator: ", ")

        let request = TaskifySpokenTaskBatchParser.parse(spoken, visibleBoardNames: [])

        XCTAssertEqual(request.titles.count, TaskifySpokenTaskBatchParser.maximumTaskCount)
        XCTAssertEqual(request.omittedCount, 2)
    }

    func testExternalBatchAddsEveryTaskWithOneDestination() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let personal = Board.week(id: "personal", name: "Personal Schedule")
        let work = Board(
            id: "work",
            name: "Work Tasks",
            kind: .list,
            columns: [BoardColumn(id: "todo", name: "To Do", order: 0)]
        )
        try await store.save(TaskifySnapshot(
            boards: [personal, work],
            tasks: [],
            selectedBoardID: personal.id
        ))

        let created = try await TaskifyExternalActions.addTasks(
            spokenRequest: "Add standup, planning and retrospective to my Work Tasks board",
            requestedBoardName: nil,
            store: store,
            settings: TaskifyDeviceTaskSettings(newTaskPosition: .top),
            publisher: .disabled,
            now: fixedNow
        )

        XCTAssertEqual(created.map(\.task.title), ["standup", "planning", "retrospective"])
        XCTAssertEqual(Set(created.map(\.task.boardID)), [work.id])
        XCTAssertEqual(Set(created.map(\.displayBoard.name)), ["Work Tasks"])
        let saved = try await store.load(areas: [.tasks])
        let batch = saved.tasks.filter { $0.boardID == work.id }
        XCTAssertEqual(batch.count, 3)
        XCTAssertTrue(batch.allSatisfy { $0.publishPending == true })
        XCTAssertEqual(
            batch.sorted { $0.order < $1.order }.map(\.title),
            ["standup", "planning", "retrospective"]
        )
    }

    func testExternalBatchRejectsOverflowWithoutSavingAnyTasks() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let board = Board(
            name: "Work",
            kind: .list,
            columns: [BoardColumn(id: "todo", name: "To Do", order: 0)]
        )
        try await store.save(TaskifySnapshot(boards: [board], tasks: [], selectedBoardID: board.id))
        let spoken = (1...21).map { "task \($0)" }.joined(separator: ", ")

        do {
            _ = try await TaskifyExternalActions.addTasks(
                spokenRequest: spoken,
                requestedBoardName: nil,
                store: store,
                publisher: .disabled,
                now: fixedNow
            )
            XCTFail("Expected the oversized request to be rejected")
        } catch {
            XCTAssertEqual(error as? TaskifyExternalAddTaskError, .tooManyTasks)
        }

        let saved = try await store.load(areas: [.tasks])
        XCTAssertTrue(saved.tasks.isEmpty)
    }

    func testExternalDeleteTasksDeletesAllTargetsAndMarksThemForPublication() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let board = Board(
            id: "work",
            name: "Work",
            kind: .list,
            columns: [BoardColumn(id: "todo", name: "To Do", order: 0)]
        )
        let first = TaskItem(id: "first", boardID: board.id, title: "First", columnID: "todo")
        let second = TaskItem(id: "second", boardID: board.id, title: "Second", columnID: "todo")
        try await store.save(TaskifySnapshot(
            boards: [board],
            tasks: [first, second],
            selectedBoardID: board.id
        ))

        let count = try await TaskifyExternalActions.deleteTasks(
            [first.id, second.id, first.id],
            store: store,
            publisher: .disabled,
            preserveAttachmentReferences: true,
            now: fixedNow
        )

        XCTAssertEqual(count, 2)
        let saved = try await store.load(areas: [.tasks])
        XCTAssertTrue(saved.tasks.allSatisfy(\.isDeleted))
        XCTAssertTrue(saved.tasks.allSatisfy { $0.publishPending == true })
    }

    func testExternalReminderSchemaCreatesListAndSectionWithDurableHandoff() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await store.save(.empty)

        let board = try await TaskifyExternalActions.createListBoard(
            name: "  Launch Plan  ",
            store: store,
            now: fixedNow
        )
        defer { TaskifyExternalBoardMutationStore.removePending([board.id]) }
        let created = try await TaskifyExternalActions.createListSection(
            name: "  Waiting  ",
            boardID: board.id,
            store: store
        )

        XCTAssertEqual(board.name, "Launch Plan")
        XCTAssertEqual(created.column.name, "Waiting")
        XCTAssertTrue(TaskifyExternalBoardMutationStore.pendingIDs().contains(board.id))
        let saved = try await store.load(areas: [.tasks])
        XCTAssertEqual(saved.boards.first(where: { $0.id == board.id })?.columns.map(\.name), ["Items", "Waiting"])
    }

    func testExternalCalendarSchemaCreatesEventWithDurableHandoff() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let board = Board(
            id: "meetings",
            name: "Meetings",
            kind: .list,
            columns: [BoardColumn(id: "upcoming", name: "Upcoming", order: 0)]
        )
        try await store.save(TaskifySnapshot(boards: [board], tasks: [], selectedBoardID: board.id))
        let end = fixedNow.addingTimeInterval(30 * 60)

        let created = try await TaskifyExternalActions.createCalendarEvent(
            title: "  Teams planning  ",
            startDate: fixedNow,
            endDate: end,
            isAllDay: false,
            boardID: board.id,
            details: "Agenda",
            location: "Microsoft Teams",
            store: store
        )
        defer { TaskifyExternalCalendarMutationStore.removePending([created.event.id]) }

        XCTAssertEqual(created.event.title, "Teams planning")
        XCTAssertEqual(created.event.boardID, board.id)
        XCTAssertEqual(created.event.columnID, "upcoming")
        XCTAssertEqual(
            try XCTUnwrap(created.event.startDate).timeIntervalSince1970,
            fixedNow.timeIntervalSince1970,
            accuracy: 0.001
        )
        XCTAssertEqual(
            try XCTUnwrap(created.event.endDate).timeIntervalSince1970,
            end.timeIntervalSince1970,
            accuracy: 0.001
        )
        XCTAssertEqual(created.event.locations, ["Microsoft Teams"])
        XCTAssertTrue(TaskifyExternalCalendarMutationStore.pendingIDs().contains(created.event.id))
        let saved = try await store.readTaskifyEventsWrittenElsewhere()
        XCTAssertEqual(saved.first(where: { $0.id == created.event.id }), created.event)
    }
}

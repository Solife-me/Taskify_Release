import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifySnapshotTests: XCTestCase {
    func testEmptySnapshotStartsWithVisibleWeekBoard() {
        let snapshot = TaskifySnapshot.empty

        XCTAssertEqual(snapshot.visibleBoards.map(\.name), ["Week"])
        XCTAssertEqual(snapshot.selectedBoard?.kind, .week)
        XCTAssertEqual(snapshot.selectedBoard?.columns.count, 7)
    }

    func testBoardRelayUpdatesNormalizeAndKeepAtLeastOneRelay() {
        var snapshot = TaskifySnapshot.empty

        XCTAssertTrue(snapshot.updateBoardRelayURLs(
            boardID: snapshot.selectedBoardID,
            relayURLs: [
                " relay.example ",
                "wss://relay.example/",
                "ws://localhost:7777",
            ]
        ))
        XCTAssertEqual(
            snapshot.selectedBoard?.effectiveRelayURLs,
            ["wss://relay.example", "ws://localhost:7777"]
        )
        XCTAssertFalse(snapshot.updateBoardRelayURLs(
            boardID: snapshot.selectedBoardID,
            relayURLs: ["https://not-a-nostr-relay.example"]
        ))
        XCTAssertEqual(
            snapshot.selectedBoard?.effectiveRelayURLs,
            ["wss://relay.example", "ws://localhost:7777"]
        )
    }

    func testScannedBoardShareJoinsWithNameAndRelays() throws {
        let rawShare = #"{"v":1,"kind":"taskify-share","item":{"type":"board","boardId":"4f35858d-066b-4f2d-a2f4-235794c77780","boardName":"Family Week","relays":["wss://relay.solife.me","wss://nos.lol"]}}"#
        let share = try XCTUnwrap(BoardShareContract.decode(rawShare))
        var snapshot = TaskifySnapshot.empty

        let board = try XCTUnwrap(snapshot.joinWeekBoard(
            nostrBoardID: share.boardID,
            name: share.boardName ?? "Shared Board",
            relayURLs: share.relayURLs
        ))

        XCTAssertEqual(board.name, "Family Week")
        XCTAssertEqual(board.nostrBoardID, "4f35858d-066b-4f2d-a2f4-235794c77780")
        XCTAssertEqual(board.effectiveRelayURLs, ["wss://relay.solife.me", "wss://nos.lol"])
        XCTAssertEqual(snapshot.selectedBoardID, board.id)
    }

    func testQuickAddCreatesTrimmedTaskInRequestedDay() {
        var snapshot = TaskifySnapshot.empty
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        let task = snapshot.addTask(
            title: "  Ship native slice  ",
            boardID: "week-default",
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: now,
            now: now
        )

        XCTAssertEqual(task?.title, "Ship native slice")
        XCTAssertEqual(task?.columnID, "monday")
        XCTAssertEqual(snapshot.tasks.count, 1)
        XCTAssertTrue(snapshot.tasks[0].dueDateEnabled)
    }

    func testCompletionRemovesTaskFromUpcoming() {
        var snapshot = TaskifySnapshot.empty
        let dueDate = Date(timeIntervalSince1970: 1_700_086_400)
        let task = snapshot.addTask(
            title: "Review build",
            boardID: "week-default",
            columnID: WeekdayColumn.tuesday.rawValue,
            dueDate: dueDate
        )

        XCTAssertEqual(snapshot.upcomingTasks(from: Date(timeIntervalSince1970: 1_700_000_000)).count, 1)
        XCTAssertTrue(snapshot.toggleCompletion(taskID: try XCTUnwrap(task?.id), now: dueDate))
        XCTAssertTrue(snapshot.upcomingTasks(from: Date(timeIntervalSince1970: 1_700_000_000)).isEmpty)
    }

    func testUpcomingOrganizerMatchesPWAFilteringAndSortControls() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let firstDay = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 22,
            hour: 8
        )))
        let laterFirstDay = try XCTUnwrap(calendar.date(byAdding: .hour, value: 1, to: firstDay))
        let secondDay = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: firstDay))
        let tasks = [
            TaskItem(
                id: "home-low",
                boardID: "home",
                title: "Call plumber",
                note: "Kitchen sink",
                dueDate: laterFirstDay,
                dueDateEnabled: true,
                dueTimeEnabled: true,
                priority: .low,
                createdAt: Date(timeIntervalSince1970: 100),
                order: 2
            ),
            TaskItem(
                id: "work-high",
                boardID: "work",
                title: "Approve launch",
                dueDate: firstDay,
                dueDateEnabled: true,
                dueTimeEnabled: true,
                priority: .high,
                createdAt: Date(timeIntervalSince1970: 200),
                order: 1
            ),
            TaskItem(
                id: "home-tomorrow",
                boardID: "home",
                title: "Buy filters",
                dueDate: secondDay,
                dueDateEnabled: true,
                priority: .medium,
                createdAt: Date(timeIntervalSince1970: 300),
                order: 0
            ),
        ]

        let selectedDay = UpcomingTaskOrganizer.filter(
            tasks,
            searchText: "",
            includedBoardIDs: nil,
            selectedDate: firstDay,
            calendar: calendar
        )
        XCTAssertEqual(Set(selectedDay.map(\.id)), Set(["home-low", "work-high"]))
        XCTAssertEqual(
            UpcomingTaskOrganizer.taskCountsByDay(tasks, calendar: calendar),
            [
                calendar.startOfDay(for: firstDay): 2,
                calendar.startOfDay(for: secondDay): 1,
            ]
        )

        let searchedHomeTasks = UpcomingTaskOrganizer.filter(
            tasks,
            searchText: "sink",
            includedBoardIDs: Set(["home"]),
            selectedDate: nil,
            calendar: calendar
        )
        XCTAssertEqual(searchedHomeTasks.map(\.id), ["home-low"])

        let prioritySorted = UpcomingTaskOrganizer.sort(
            selectedDay,
            mode: .priority,
            direction: .descending,
            boardGrouping: .mixed,
            boardOrder: ["home", "work"]
        )
        XCTAssertEqual(prioritySorted.map(\.id), ["work-high", "home-low"])

        let groupedByBoard = UpcomingTaskOrganizer.sort(
            selectedDay,
            mode: .dueDate,
            direction: .ascending,
            boardGrouping: .grouped,
            boardOrder: ["home", "work"]
        )
        XCTAssertEqual(groupedByBoard.map(\.id), ["home-low", "work-high"])
    }

    func testListBoardCreatesColumnsAndValidatesTaskPlacement() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "  Projects  "))
        let firstColumn = try XCTUnwrap(board.columns.first)
        let secondColumn = try XCTUnwrap(snapshot.addListColumn(boardID: board.id, name: "  Doing  "))

        XCTAssertEqual(snapshot.selectedBoard?.name, "Projects")
        XCTAssertEqual(snapshot.selectedBoard?.kind, .list)
        XCTAssertEqual(snapshot.selectedBoard?.columns.map(\.name), ["Items", "Doing"])
        XCTAssertNil(snapshot.addTask(
            title: "Wrong list",
            boardID: board.id,
            columnID: "missing",
            dueDate: nil
        ))

        let task = snapshot.addTask(
            title: "List task",
            boardID: board.id,
            columnID: secondColumn.id,
            dueDate: nil
        )
        XCTAssertEqual(task?.columnID, secondColumn.id)
        XCTAssertTrue(snapshot.tasks(
            boardID: board.id,
            columnID: firstColumn.id,
            includeCompleted: true
        ).isEmpty)
    }

    func testCompoundBoardAggregatesOrderedListBoardsAndManagesChildren() throws {
        var snapshot = TaskifySnapshot.empty
        let projects = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        _ = try XCTUnwrap(snapshot.addListColumn(boardID: projects.id, name: "Doing"))
        let home = try XCTUnwrap(snapshot.createListBoard(name: "Home"))
        let compound = try XCTUnwrap(snapshot.createCompoundBoard(
            name: "Everything",
            childBoardIDs: [home.id, projects.id]
        ))

        XCTAssertEqual(snapshot.selectedBoard?.kind, .compound)
        XCTAssertEqual(
            compound.children,
            [home.effectiveNostrBoardID, projects.effectiveNostrBoardID]
        )
        XCTAssertEqual(
            snapshot.compoundChildBoards(for: compound.id).map(\.name),
            ["Home", "Projects"]
        )
        XCTAssertTrue(snapshot.moveCompoundChild(
            boardID: compound.id,
            childBoardID: projects.id,
            direction: -1
        ))
        XCTAssertEqual(
            snapshot.compoundChildBoards(for: compound.id).map(\.name),
            ["Projects", "Home"]
        )
        XCTAssertTrue(snapshot.setCompoundChild(
            boardID: compound.id,
            childBoardID: home.id,
            included: false
        ))
        XCTAssertEqual(snapshot.compoundChildBoards(for: compound.id).map(\.name), ["Projects"])
        XCTAssertTrue(snapshot.setCompoundHideChildBoardNames(boardID: compound.id, hidden: true))
        XCTAssertTrue(snapshot.selectedBoard?.hideChildBoardNames == true)
    }

    func testBoardRenameAndArchiveLifecycleKeepsAUsableSelection() throws {
        var snapshot = TaskifySnapshot.empty
        let projects = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))

        XCTAssertTrue(snapshot.renameBoard(boardID: projects.id, name: "  Client work  "))
        XCTAssertEqual(snapshot.boards.first(where: { $0.id == projects.id })?.name, "Client work")
        XCTAssertFalse(snapshot.renameBoard(boardID: projects.id, name: "   "))

        XCTAssertTrue(snapshot.archiveBoard(boardID: projects.id))
        XCTAssertTrue(snapshot.boards.first(where: { $0.id == projects.id })?.archived == true)
        XCTAssertEqual(snapshot.selectedBoardID, "week-default")
        XCTAssertFalse(snapshot.archiveBoard(boardID: "week-default"))

        XCTAssertTrue(snapshot.unarchiveBoard(boardID: projects.id))
        XCTAssertTrue(snapshot.boards.first(where: { $0.id == projects.id })?.isVisible == true)
    }

    func testRemoteBoardMetadataPreservesLocalArchiveState() throws {
        var snapshot = TaskifySnapshot.empty
        let projects = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        XCTAssertTrue(snapshot.archiveBoard(boardID: projects.id))
        var remote = projects
        remote.name = "Renamed remotely"

        XCTAssertTrue(snapshot.mergeRemoteBoard(remote, eventCreatedAt: 50))

        let merged = try XCTUnwrap(snapshot.boards.first(where: { $0.id == projects.id }))
        XCTAssertEqual(merged.name, "Renamed remotely")
        XCTAssertTrue(merged.archived)
        XCTAssertFalse(merged.hidden)
        XCTAssertFalse(snapshot.visibleBoards.contains(where: { $0.id == projects.id }))
    }

    func testDeletingBoardRemovesItsTasksAndCompoundReferences() throws {
        var snapshot = TaskifySnapshot.empty
        let projects = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let home = try XCTUnwrap(snapshot.createListBoard(name: "Home"))
        let compound = try XCTUnwrap(snapshot.createCompoundBoard(
            name: "Everything",
            childBoardIDs: [projects.id, home.id]
        ))
        let projectColumn = try XCTUnwrap(projects.columns.first)
        let projectTask = try XCTUnwrap(snapshot.addTask(
            title: "Remove with board",
            boardID: projects.id,
            columnID: projectColumn.id,
            dueDate: nil
        ))
        _ = try XCTUnwrap(snapshot.addTask(
            title: "Keep on home",
            boardID: home.id,
            columnID: try XCTUnwrap(home.columns.first).id,
            dueDate: nil
        ))

        let result = try XCTUnwrap(snapshot.deleteBoard(boardID: projects.id))

        XCTAssertEqual(result.deletedBoardID, projects.id)
        XCTAssertEqual(result.deletedTaskIDs, [projectTask.id])
        XCTAssertEqual(result.updatedCompoundBoardIDs, [compound.id])
        XCTAssertFalse(snapshot.boards.contains(where: { $0.id == projects.id }))
        XCTAssertFalse(snapshot.tasks.contains(where: { $0.id == projectTask.id }))
        XCTAssertEqual(snapshot.compoundChildBoards(for: compound.id).map(\.id), [home.id])
    }

    func testDeletingOnlyVisibleBoardRepairsTheWorkspace() throws {
        var snapshot = TaskifySnapshot.empty

        XCTAssertNotNil(snapshot.deleteBoard(boardID: "week-default"))
        XCTAssertEqual(snapshot.visibleBoards.count, 1)
        XCTAssertEqual(snapshot.selectedBoard?.kind, .week)
        XCTAssertFalse(snapshot.selectedBoardID.isEmpty)
    }

    func testDraggingTaskMovesAndReordersWithinListBoard() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let backlog = try XCTUnwrap(board.columns.first)
        let doing = try XCTUnwrap(snapshot.addListColumn(boardID: board.id, name: "Doing"))
        let moved = try XCTUnwrap(snapshot.addTask(
            title: "Moved",
            boardID: board.id,
            columnID: backlog.id,
            dueDate: nil
        ))
        let first = try XCTUnwrap(snapshot.addTask(
            title: "First",
            boardID: board.id,
            columnID: doing.id,
            dueDate: nil
        ))
        let last = try XCTUnwrap(snapshot.addTask(
            title: "Last",
            boardID: board.id,
            columnID: doing.id,
            dueDate: nil
        ))
        let movedIndex = try XCTUnwrap(snapshot.tasks.firstIndex(where: { $0.id == moved.id }))
        snapshot.tasks[movedIndex].completed = true
        snapshot.tasks[movedIndex].completedAt = Date(timeIntervalSince1970: 1_700_000_000)
        snapshot.tasks[movedIndex].hiddenUntilDate = Date.distantFuture

        let result = try XCTUnwrap(snapshot.moveTask(
            taskID: moved.id,
            toBoardID: board.id,
            columnID: doing.id,
            beforeTaskID: last.id,
            editorPublicKey: "editor"
        ))

        XCTAssertFalse(result.crossedBoards)
        XCTAssertEqual(Set(result.updatedTaskIDs), Set([moved.id, last.id]))
        XCTAssertEqual(
            snapshot.tasks(boardID: board.id, columnID: doing.id, includeCompleted: true).map(\.id),
            [first.id, moved.id, last.id]
        )
        let updated = try XCTUnwrap(snapshot.tasks.first(where: { $0.id == moved.id }))
        XCTAssertFalse(updated.completed)
        XCTAssertNil(updated.completedAt)
        XCTAssertNil(updated.hiddenUntilDate)
        XCTAssertEqual(updated.lastEditedBy, "editor")

        XCTAssertNotNil(snapshot.moveTask(
            taskID: last.id,
            toBoardID: board.id,
            columnID: doing.id,
            beforeTaskID: first.id
        ))
        XCTAssertEqual(
            snapshot.tasks(boardID: board.id, columnID: doing.id, includeCompleted: true).map(\.id),
            [last.id, first.id, moved.id]
        )
    }

    func testDraggingTaskAcrossWeekdaysPreservesTimeAndReorders() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let sunday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 19,
            hour: 14,
            minute: 30
        )))
        let monday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 20
        )))
        var snapshot = TaskifySnapshot.empty
        let first = try XCTUnwrap(snapshot.addTask(
            title: "First Monday task",
            boardID: "week-default",
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: monday
        ))
        let last = try XCTUnwrap(snapshot.addTask(
            title: "Last Monday task",
            boardID: "week-default",
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: monday
        ))
        let moved = try XCTUnwrap(snapshot.addTask(
            title: "Move from Sunday",
            boardID: "week-default",
            columnID: WeekdayColumn.sunday.rawValue,
            dueDate: sunday
        ))
        let movedIndex = try XCTUnwrap(snapshot.tasks.firstIndex(where: { $0.id == moved.id }))
        snapshot.tasks[movedIndex].dueTimeEnabled = true
        snapshot.tasks[movedIndex].dueTimeZone = "UTC"
        snapshot.tasks[movedIndex].completed = true

        let result = try XCTUnwrap(snapshot.moveTask(
            taskID: moved.id,
            toBoardID: "week-default",
            columnID: WeekdayColumn.monday.rawValue,
            beforeTaskID: last.id,
            editorPublicKey: "editor",
            calendar: calendar
        ))

        XCTAssertFalse(result.crossedBoards)
        XCTAssertEqual(Set(result.updatedTaskIDs), Set([moved.id, last.id]))
        XCTAssertEqual(
            snapshot.tasks(
                boardID: "week-default",
                columnID: WeekdayColumn.monday.rawValue,
                includeCompleted: true
            ).map(\.id),
            [first.id, moved.id, last.id]
        )
        let updated = try XCTUnwrap(snapshot.tasks.first(where: { $0.id == moved.id }))
        XCTAssertEqual(updated.columnID, WeekdayColumn.monday.rawValue)
        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day, .hour, .minute], from: try XCTUnwrap(updated.dueDate)),
            DateComponents(year: 2026, month: 7, day: 20, hour: 14, minute: 30)
        )
        XCTAssertTrue(updated.dueDateEnabled)
        XCTAssertFalse(updated.completed)
        XCTAssertEqual(updated.lastEditedBy, "editor")
    }

    func testDraggingAcrossCompoundChildrenChangesSourceBoard() throws {
        var snapshot = TaskifySnapshot.empty
        let personal = try XCTUnwrap(snapshot.createListBoard(name: "Personal"))
        let personalColumn = try XCTUnwrap(personal.columns.first)
        let work = try XCTUnwrap(snapshot.createListBoard(name: "Work"))
        let workColumn = try XCTUnwrap(work.columns.first)
        let compound = try XCTUnwrap(snapshot.createCompoundBoard(
            name: "Everything",
            childBoardIDs: [personal.id, work.id]
        ))
        let moved = try XCTUnwrap(snapshot.addTask(
            title: "Move me",
            boardID: personal.id,
            columnID: personalColumn.id,
            dueDate: nil
        ))
        let existing = try XCTUnwrap(snapshot.addTask(
            title: "Existing",
            boardID: work.id,
            columnID: workColumn.id,
            dueDate: nil
        ))

        let result = try XCTUnwrap(snapshot.moveTask(
            taskID: moved.id,
            toBoardID: work.id,
            columnID: workColumn.id,
            beforeTaskID: existing.id
        ))

        XCTAssertTrue(result.crossedBoards)
        XCTAssertEqual(result.sourceBoardID, personal.id)
        XCTAssertEqual(result.targetBoardID, work.id)
        XCTAssertEqual(
            snapshot.tasks(boardID: work.id, columnID: workColumn.id, includeCompleted: true).map(\.id),
            [moved.id, existing.id]
        )
        XCTAssertTrue(snapshot.tasks(
            boardID: personal.id,
            columnID: personalColumn.id,
            includeCompleted: true
        ).isEmpty)
        XCTAssertEqual(snapshot.compoundChildBoards(for: compound.id).map(\.id), [personal.id, work.id])
        XCTAssertNil(snapshot.moveTask(
            taskID: moved.id,
            toBoardID: "week-default",
            columnID: WeekdayColumn.monday.rawValue
        ))
    }

    func testRemoteCompoundCreatesHiddenSyncableChildStubs() throws {
        let parent = Board(
            id: "local-compound",
            name: "Shared compound",
            kind: .compound,
            children: ["child-a", "child-b"],
            nostrBoardID: "parent-board",
            relayURLs: ["wss://relay.solife.me"]
        )
        var snapshot = TaskifySnapshot(
            boards: [parent],
            tasks: [],
            selectedBoardID: parent.id
        )

        XCTAssertEqual(snapshot.visibleBoards.map(\.id), [parent.id])
        XCTAssertEqual(Set(snapshot.boardsForSync.map(\.effectiveNostrBoardID)), Set([
            "parent-board",
            "child-a",
            "child-b",
        ]))

        let child = try XCTUnwrap(snapshot.boards.first(where: { $0.effectiveNostrBoardID == "child-a" }))
        XCTAssertTrue(child.hidden)
        XCTAssertTrue(child.archived)
        XCTAssertEqual(child.kind, .list)
        let column = try XCTUnwrap(child.columns.first)
        XCTAssertNotNil(snapshot.addTask(
            title: "Added through compound",
            boardID: child.id,
            columnID: column.id,
            dueDate: nil
        ))
    }

    func testListColumnsRenameAndReorderWithoutMovingTasks() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let first = try XCTUnwrap(board.columns.first)
        let second = try XCTUnwrap(snapshot.addListColumn(boardID: board.id, name: "Doing"))
        let third = try XCTUnwrap(snapshot.addListColumn(boardID: board.id, name: "Done"))
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Keep placement",
            boardID: board.id,
            columnID: second.id,
            dueDate: nil
        ))

        XCTAssertTrue(snapshot.renameListColumn(boardID: board.id, columnID: second.id, name: "  In progress  "))
        XCTAssertTrue(snapshot.reorderListColumns(
            boardID: board.id,
            orderedColumnIDs: [third.id, first.id, second.id]
        ))

        let updated = try XCTUnwrap(snapshot.boards.first(where: { $0.id == board.id }))
        XCTAssertEqual(updated.columns.map(\.id), [third.id, first.id, second.id])
        XCTAssertEqual(updated.columns.map(\.order), [0, 1, 2])
        XCTAssertEqual(updated.columns.last?.name, "In progress")
        XCTAssertEqual(snapshot.tasks.first(where: { $0.id == task.id })?.columnID, second.id)
        XCTAssertFalse(snapshot.renameListColumn(boardID: board.id, columnID: second.id, name: "   "))
    }

    func testRemovingListCanMoveTasksToNeighbor() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let destination = try XCTUnwrap(board.columns.first)
        let source = try XCTUnwrap(snapshot.addListColumn(boardID: board.id, name: "Doing"))
        _ = try XCTUnwrap(snapshot.addTask(
            title: "Already there",
            boardID: board.id,
            columnID: destination.id,
            dueDate: nil
        ))
        let firstMoved = try XCTUnwrap(snapshot.addTask(
            title: "First moved",
            boardID: board.id,
            columnID: source.id,
            dueDate: nil
        ))
        let secondMoved = try XCTUnwrap(snapshot.addTask(
            title: "Second moved",
            boardID: board.id,
            columnID: source.id,
            dueDate: nil
        ))

        let result = try XCTUnwrap(snapshot.removeListColumn(
            boardID: board.id,
            columnID: source.id,
            strategy: .moveTasks(toColumnID: destination.id),
            editorPublicKey: "editor"
        ))

        XCTAssertEqual(result.movedTaskIDs, [firstMoved.id, secondMoved.id])
        XCTAssertTrue(result.deletedTaskIDs.isEmpty)
        XCTAssertEqual(snapshot.selectedBoard?.columns.map(\.id), [destination.id])
        let movedTasks = snapshot.tasks
            .filter { result.movedTaskIDs.contains($0.id) }
            .sorted { $0.order < $1.order }
        XCTAssertEqual(movedTasks.map(\.columnID), [destination.id, destination.id])
        XCTAssertEqual(movedTasks.map(\.order), [1, 2])
        XCTAssertEqual(movedTasks.map(\.lastEditedBy), ["editor", "editor"])
    }

    func testRemovingListCanDeleteTasksButProtectsFinalList() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let finalColumn = try XCTUnwrap(board.columns.first)
        let deletedColumn = try XCTUnwrap(snapshot.addListColumn(boardID: board.id, name: "Discard"))
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Delete with list",
            boardID: board.id,
            columnID: deletedColumn.id,
            dueDate: nil
        ))

        let result = try XCTUnwrap(snapshot.removeListColumn(
            boardID: board.id,
            columnID: deletedColumn.id,
            strategy: .deleteTasks
        ))

        XCTAssertEqual(result.deletedTaskIDs, [task.id])
        XCTAssertTrue(snapshot.tasks.first(where: { $0.id == task.id })?.isDeleted == true)
        XCTAssertNil(snapshot.removeListColumn(
            boardID: board.id,
            columnID: finalColumn.id,
            strategy: .deleteTasks
        ))
        XCTAssertEqual(snapshot.selectedBoard?.columns.map(\.id), [finalColumn.id])
    }

    func testRichTaskEditMovesListAndNormalizesSubtasks() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let firstColumn = try XCTUnwrap(board.columns.first)
        let secondColumn = try XCTUnwrap(snapshot.addListColumn(boardID: board.id, name: "Done next"))
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Draft",
            boardID: board.id,
            columnID: firstColumn.id,
            dueDate: nil
        ))
        let dueDate = Date(timeIntervalSince1970: 1_800_000_000)

        XCTAssertTrue(snapshot.updateTask(
            taskID: task.id,
            title: "  Ship milestone  ",
            note: "  Include native editor  ",
            dueDate: dueDate,
            dueDateEnabled: true,
            dueTimeEnabled: true,
            dueTimeZone: "America/Chicago",
            priority: .high,
            columnID: secondColumn.id,
            subtasks: [
                TaskSubtask(id: "one", title: "  Build UI  "),
                TaskSubtask(id: "two", title: "   "),
            ],
            editorPublicKey: "editor"
        ))

        let updated = try XCTUnwrap(snapshot.tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(updated.title, "Ship milestone")
        XCTAssertEqual(updated.note, "Include native editor")
        XCTAssertEqual(updated.columnID, secondColumn.id)
        XCTAssertEqual(updated.priority, .high)
        XCTAssertEqual(updated.dueDate, dueDate)
        XCTAssertTrue(updated.dueTimeEnabled)
        XCTAssertEqual(updated.subtasks, [TaskSubtask(id: "one", title: "Build UI")])
        XCTAssertEqual(updated.lastEditedBy, "editor")
    }

    func testEditingTaskPreservesSyncedAttachments() throws {
        var snapshot = TaskifySnapshot.empty
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Attachment task",
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: nil
        ))
        snapshot.tasks[0].images = ["https://originless.example/image"]
        snapshot.tasks[0].documents = [TaskDocument(
            id: "doc",
            name: "notes.txt",
            mimeType: "text/plain",
            kind: "txt",
            remoteURL: "https://originless.example/document",
            encrypted: true,
            encryptionBoardID: snapshot.selectedBoardID
        )]

        XCTAssertTrue(snapshot.updateTask(
            taskID: task.id,
            title: "Renamed attachment task",
            note: "Still attached",
            dueDate: nil,
            dueDateEnabled: false,
            dueTimeEnabled: false,
            dueTimeZone: nil,
            priority: nil,
            columnID: task.columnID,
            subtasks: []
        ))

        let updated = try XCTUnwrap(snapshot.tasks.first)
        XCTAssertEqual(updated.images, ["https://originless.example/image"])
        XCTAssertEqual(updated.documents?.map(\.id), ["doc"])
    }

    func testNativeTaskMutationsPreserveOpaquePWASyncFields() {
        let board = Board(
            id: "advanced-board",
            name: "Advanced",
            kind: .list,
            columns: [
                BoardColumn(id: "todo", name: "To Do", order: 0),
                BoardColumn(id: "done", name: "Done", order: 1),
            ]
        )
        let opaqueFields: [String: TaskPayloadValue] = [
            "assignees": .array([
                .object([
                    "pubkey": .string(String(repeating: "a", count: 64)),
                    "status": .string("accepted"),
                ]),
            ]),
            "bounty": .object([
                "id": .string("bounty-1"),
                "amount": .integer(21),
            ]),
            "futureField": .null,
        ]
        let task = TaskItem(
            id: "advanced-task",
            boardID: board.id,
            title: "Original",
            columnID: "todo",
            preservedSyncFields: opaqueFields
        )
        var snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [task],
            selectedBoardID: board.id
        )

        XCTAssertTrue(snapshot.updateTask(
            taskID: task.id,
            title: "Edited",
            note: "Native edit",
            dueDate: nil,
            dueDateEnabled: false,
            dueTimeEnabled: false,
            dueTimeZone: nil,
            priority: .medium,
            columnID: "todo",
            subtasks: []
        ))
        XCTAssertEqual(snapshot.tasks.first?.preservedSyncFields, opaqueFields)

        XCTAssertNotNil(snapshot.moveTask(
            taskID: task.id,
            toBoardID: board.id,
            columnID: "done"
        ))
        XCTAssertEqual(snapshot.tasks.first?.preservedSyncFields, opaqueFields)

        XCTAssertTrue(snapshot.toggleCompletion(taskID: task.id))
        XCTAssertEqual(snapshot.tasks.first?.preservedSyncFields, opaqueFields)

        var remoteUpdate = snapshot.tasks[0]
        remoteUpdate.title = "Newer PWA edit"
        remoteUpdate.preservedSyncFields = [
            "bounty": .null,
            "newFutureField": .boolean(true),
        ]
        XCTAssertTrue(snapshot.mergeRemoteTask(remoteUpdate, eventCreatedAt: 10))
        XCTAssertEqual(snapshot.tasks[0].preservedSyncFields?["assignees"], opaqueFields["assignees"])
        XCTAssertEqual(snapshot.tasks[0].preservedSyncFields?["futureField"], .null)
        XCTAssertEqual(snapshot.tasks[0].preservedSyncFields?["bounty"], .null)
        XCTAssertEqual(snapshot.tasks[0].preservedSyncFields?["newFutureField"], .boolean(true))
    }

    func testReplacingAttachmentsSupportsNativeAddAndRemove() throws {
        var snapshot = TaskifySnapshot.empty
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Native attachments",
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.tuesday.rawValue,
            dueDate: nil
        ))
        let document = try XCTUnwrap(TaskDocumentContract.remoteDocument(
            name: "plan.pdf",
            mimeType: "application/pdf",
            size: 1_024,
            remoteURL: "https://originless.example/ipfs/document",
            boardID: snapshot.selectedBoardID
        ))

        XCTAssertTrue(snapshot.replaceTaskAttachments(
            taskID: task.id,
            images: ["https://originless.example/ipfs/image"],
            documents: [document],
            editorPublicKey: "editor"
        ))
        XCTAssertEqual(snapshot.tasks[0].images?.count, 1)
        XCTAssertEqual(snapshot.tasks[0].documents?.map(\.id), [document.id])
        XCTAssertEqual(snapshot.tasks[0].lastEditedBy, "editor")

        XCTAssertTrue(snapshot.replaceTaskAttachments(
            taskID: task.id,
            images: [],
            documents: []
        ))
        XCTAssertNil(snapshot.tasks[0].images)
        XCTAssertNil(snapshot.tasks[0].documents)
    }

    func testNewerRemoteBoardMetadataWins() throws {
        var snapshot = TaskifySnapshot.empty
        let local = try XCTUnwrap(snapshot.joinWeekBoard(nostrBoardID: "shared-list"))
        var remote = local
        remote.name = "Projects"
        remote.kind = .list
        remote.columns = [BoardColumn(id: "items", name: "Items", order: 0)]

        XCTAssertTrue(snapshot.mergeRemoteBoard(remote, eventCreatedAt: 20))
        XCTAssertEqual(snapshot.selectedBoard?.kind, .list)
        XCTAssertEqual(snapshot.selectedBoard?.name, "Projects")

        var stale = remote
        stale.name = "Stale"
        XCTAssertFalse(snapshot.mergeRemoteBoard(stale, eventCreatedAt: 19))
        XCTAssertEqual(snapshot.selectedBoard?.name, "Projects")
    }

    func testCompletingRecurringTaskCreatesNextInstance() throws {
        var snapshot = TaskifySnapshot.empty
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let dueDate = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 20,
            hour: 9
        )))
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Daily review",
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: dueDate,
            now: dueDate
        ))
        XCTAssertTrue(snapshot.updateTask(
            taskID: task.id,
            title: task.title,
            note: "",
            dueDate: dueDate,
            dueDateEnabled: true,
            dueTimeEnabled: true,
            dueTimeZone: "UTC",
            priority: nil,
            columnID: task.columnID,
            subtasks: [TaskSubtask(id: "step", title: "Review", completed: true)],
            recurrence: .daily(),
            reminders: [TaskReminder(rawValue: "15m")],
            editorPublicKey: "author",
            calendar: calendar
        ))

        XCTAssertTrue(snapshot.toggleCompletion(taskID: task.id, editorPublicKey: "author", now: dueDate))
        let completed = try XCTUnwrap(snapshot.tasks.first(where: { $0.id == task.id }))
        let next = try XCTUnwrap(snapshot.tasks.first(where: { $0.id != task.id }))

        XCTAssertTrue(completed.completed)
        XCTAssertEqual(completed.seriesID, task.id)
        XCTAssertEqual(next.id, "recurrence:\(task.id):2026-07-21")
        XCTAssertEqual(next.seriesID, task.id)
        XCTAssertEqual(next.dueDate, calendar.date(byAdding: .day, value: 1, to: dueDate))
        XCTAssertFalse(try XCTUnwrap(next.subtasks?.first).completed)
        XCTAssertEqual(next.reminders, [TaskReminder(rawValue: "15m")])
        XCTAssertEqual(next.columnID, WeekdayColumn.tuesday.rawValue)
        XCTAssertEqual(next.hiddenUntilDate, calendar.startOfDay(for: try XCTUnwrap(next.dueDate)))
        XCTAssertTrue(snapshot.tasks(
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.tuesday.rawValue,
            includeCompleted: false,
            now: dueDate
        ).isEmpty)
        XCTAssertEqual(snapshot.upcomingTasks(from: dueDate).map(\.id), [next.id])
    }

    func testRecurrenceHonorsWeekdaysAndEndDate() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let friday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 24,
            hour: 10
        )))
        let monday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 27,
            hour: 10
        )))
        let rule = TaskRecurrence.weekly(days: [1, 2, 3, 4, 5], until: monday)

        XCTAssertEqual(
            rule.nextOccurrence(
                after: friday,
                dueTimeEnabled: true,
                timeZoneIdentifier: "UTC",
                calendar: calendar
            ),
            monday
        )
        XCTAssertNil(rule.nextOccurrence(
            after: monday,
            dueTimeEnabled: true,
            timeZoneIdentifier: "UTC",
            calendar: calendar
        ))
    }

    func testReminderFireDatesMatchPWAOffsets() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let dueDate = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 20
        )))
        let task = TaskItem(
            boardID: "board",
            title: "Date-only reminder",
            dueDate: dueDate,
            dueDateEnabled: true,
            reminders: [TaskReminder(rawValue: "1d"), TaskReminder(rawValue: "0d")],
            reminderTime: "09:30"
        )
        let dates = task.reminderFireDates(calendar: calendar)

        XCTAssertEqual(dates.map(\.0.rawValue), ["1d", "0d"])
        XCTAssertEqual(
            dates.map(\.1),
            [
                calendar.date(byAdding: .minute, value: -1_440, to: try XCTUnwrap(task.reminderAnchor(calendar: calendar))),
                task.reminderAnchor(calendar: calendar),
            ]
        )
    }

    func testJSONStoreRoundTripsSnapshot() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileURL = directory.appendingPathComponent("taskify.json")
        let store = JSONTaskStore(fileURL: fileURL)
        var snapshot = TaskifySnapshot.empty
        _ = snapshot.addTask(
            title: "Persist me",
            boardID: "week-default",
            columnID: WeekdayColumn.friday.rawValue,
            dueDate: Date(timeIntervalSince1970: 1_700_000_000)
        )

        try await store.save(snapshot)
        let restored = try await store.load()

        XCTAssertEqual(restored, snapshot)
        try? FileManager.default.removeItem(at: directory)
    }

    func testWeekDateResolverReturnsRequestedWeekday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let reference = Date(timeIntervalSince1970: 1_721_260_800)

        let friday = WeekDateResolver.date(
            for: .friday,
            inWeekContaining: reference,
            calendar: calendar
        )

        XCTAssertEqual(calendar.component(.weekday, from: friday), 6)
    }
}

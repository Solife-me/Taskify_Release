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

    func testSubtaskCompletionTogglesInlineWithoutChangingTheParentTask() throws {
        var snapshot = TaskifySnapshot.empty
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Prepare release",
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: Date(timeIntervalSince1970: 1_700_000_000)
        ))
        XCTAssertTrue(snapshot.updateTask(
            taskID: task.id,
            title: task.title,
            note: "Keep this note",
            dueDate: task.dueDate,
            dueDateEnabled: true,
            dueTimeEnabled: false,
            dueTimeZone: nil,
            priority: .high,
            columnID: task.columnID,
            subtasks: [
                TaskSubtask(id: "first", title: "Build", completed: false),
                TaskSubtask(id: "second", title: "Test", completed: true),
            ],
            recurrence: nil,
            reminders: [],
            editorPublicKey: "original-editor"
        ))

        XCTAssertTrue(snapshot.toggleSubtaskCompletion(
            taskID: task.id,
            subtaskID: "first",
            editorPublicKey: "inline-editor"
        ))
        let updated = try XCTUnwrap(snapshot.tasks.first { $0.id == task.id })
        XCTAssertFalse(updated.completed)
        XCTAssertEqual(updated.title, "Prepare release")
        XCTAssertEqual(updated.note, "Keep this note")
        XCTAssertEqual(updated.priority, .high)
        XCTAssertEqual(updated.subtasks, [
            TaskSubtask(id: "first", title: "Build", completed: true),
            TaskSubtask(id: "second", title: "Test", completed: true),
        ])
        XCTAssertEqual(updated.lastEditedBy, "inline-editor")

        XCTAssertFalse(snapshot.toggleSubtaskCompletion(
            taskID: task.id,
            subtaskID: "missing"
        ))
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

    func testNewTaskPositionDefaultsToTopMatchingThePWA() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let column = try XCTUnwrap(board.columns.first)

        let first = try XCTUnwrap(snapshot.addTask(
            title: "First",
            boardID: board.id,
            columnID: column.id,
            dueDate: nil
        ))
        let second = try XCTUnwrap(snapshot.addTask(
            title: "Second",
            boardID: board.id,
            columnID: column.id,
            dueDate: nil
        ))

        XCTAssertEqual(
            snapshot.tasks(boardID: board.id, columnID: column.id, includeCompleted: true).map(\.id),
            [second.id, first.id],
            "defaulting to top, like the PWA, means the newest task leads"
        )

        let third = try XCTUnwrap(snapshot.addTask(
            title: "Third",
            boardID: board.id,
            columnID: column.id,
            dueDate: nil,
            newTaskPosition: .bottom
        ))
        XCTAssertEqual(
            snapshot.tasks(boardID: board.id, columnID: column.id, includeCompleted: true).map(\.id),
            [second.id, first.id, third.id]
        )
    }

    func testIndexCardDefaultsOffAndCanBeToggledForListAndCompoundBoards() throws {
        var snapshot = TaskifySnapshot.empty
        let projects = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        XCTAssertFalse(projects.indexCardEnabled, "matches the PWA's opt-in default")

        let compound = try XCTUnwrap(snapshot.createCompoundBoard(
            name: "Everything",
            childBoardIDs: [projects.id]
        ))
        XCTAssertFalse(compound.indexCardEnabled)

        XCTAssertTrue(snapshot.setBoardIndexCardEnabled(boardID: projects.id, enabled: true))
        XCTAssertEqual(snapshot.boards.first(where: { $0.id == projects.id })?.indexCardEnabled, true)

        XCTAssertTrue(snapshot.setBoardIndexCardEnabled(boardID: compound.id, enabled: true))
        XCTAssertEqual(snapshot.boards.first(where: { $0.id == compound.id })?.indexCardEnabled, true)

        let week = try XCTUnwrap(snapshot.createWeekBoard(name: "This Week"))
        XCTAssertFalse(
            snapshot.setBoardIndexCardEnabled(boardID: week.id, enabled: true),
            "week boards have fixed columns and don't support the index card"
        )
    }

    func testBoardClearCompletedPreferenceCanBeToggledForSyncedBoards() throws {
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.selectedBoardID

        XCTAssertFalse(try XCTUnwrap(snapshot.selectedBoard).clearCompletedDisabled)
        XCTAssertTrue(snapshot.setBoardClearCompletedEnabled(boardID: boardID, enabled: false))
        XCTAssertTrue(try XCTUnwrap(snapshot.selectedBoard).clearCompletedDisabled)
        XCTAssertTrue(snapshot.setBoardClearCompletedEnabled(boardID: boardID, enabled: true))
        XCTAssertFalse(try XCTUnwrap(snapshot.selectedBoard).clearCompletedDisabled)

        snapshot.boards.append(Board(id: "bible", name: "Bible", kind: .bible))
        XCTAssertFalse(snapshot.setBoardClearCompletedEnabled(boardID: "bible", enabled: false))
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
            dueDate: nil,
            newTaskPosition: .bottom
        ))
        let first = try XCTUnwrap(snapshot.addTask(
            title: "First",
            boardID: board.id,
            columnID: doing.id,
            dueDate: nil,
            newTaskPosition: .bottom
        ))
        let last = try XCTUnwrap(snapshot.addTask(
            title: "Last",
            boardID: board.id,
            columnID: doing.id,
            dueDate: nil,
            newTaskPosition: .bottom
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
            dueDate: monday,
            newTaskPosition: .bottom
        ))
        let last = try XCTUnwrap(snapshot.addTask(
            title: "Last Monday task",
            boardID: "week-default",
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: monday,
            newTaskPosition: .bottom
        ))
        let moved = try XCTUnwrap(snapshot.addTask(
            title: "Move from Sunday",
            boardID: "week-default",
            columnID: WeekdayColumn.sunday.rawValue,
            dueDate: sunday,
            newTaskPosition: .bottom
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

    func testHorizontalDragAutoScrollStartsSoonerAndAcceleratesNearTheEdge() throws {
        let policy = HorizontalDragAutoScrollPolicy(viewportWidth: 400)

        XCTAssertNil(policy.command(forHorizontalLocation: 200))
        let approachingLeft = try XCTUnwrap(policy.command(forHorizontalLocation: 78))
        let atLeftEdge = try XCTUnwrap(policy.command(forHorizontalLocation: 8))
        let approachingRight = try XCTUnwrap(policy.command(forHorizontalLocation: 322))
        let atRightEdge = try XCTUnwrap(policy.command(forHorizontalLocation: 392))

        XCTAssertEqual(approachingLeft.direction, .backward)
        XCTAssertEqual(atLeftEdge.direction, .backward)
        XCTAssertEqual(approachingRight.direction, .forward)
        XCTAssertEqual(atRightEdge.direction, .forward)
        XCTAssertLessThan(atLeftEdge.interval, approachingLeft.interval)
        XCTAssertLessThan(atRightEdge.interval, approachingRight.interval)
        XCTAssertGreaterThanOrEqual(atLeftEdge.interval, 0.38)
        XCTAssertLessThanOrEqual(approachingLeft.interval, 0.75)
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
            dueDate: nil,
            newTaskPosition: .bottom
        ))
        let firstMoved = try XCTUnwrap(snapshot.addTask(
            title: "First moved",
            boardID: board.id,
            columnID: source.id,
            dueDate: nil,
            newTaskPosition: .bottom
        ))
        let secondMoved = try XCTUnwrap(snapshot.addTask(
            title: "Second moved",
            boardID: board.id,
            columnID: source.id,
            dueDate: nil,
            newTaskPosition: .bottom
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

    func testTimedTaskUsesItsOwnTimeZoneWhenChoosingWeekColumn() throws {
        var snapshot = TaskifySnapshot.empty
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Late Pacific task",
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: nil
        ))
        var pacificCalendar = Calendar(identifier: .gregorian)
        pacificCalendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let lateWednesday = try XCTUnwrap(pacificCalendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 22,
            hour: 23,
            minute: 30
        )))
        var deviceCalendar = Calendar(identifier: .gregorian)
        deviceCalendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))

        XCTAssertTrue(snapshot.updateTask(
            taskID: task.id,
            title: task.title,
            note: "",
            dueDate: lateWednesday,
            dueDateEnabled: true,
            dueTimeEnabled: true,
            dueTimeZone: "America/Los_Angeles",
            priority: nil,
            columnID: task.columnID,
            subtasks: [],
            calendar: deviceCalendar
        ))

        XCTAssertEqual(snapshot.tasks.first?.columnID, WeekdayColumn.wednesday.rawValue)
    }

    func testRecurringTimedTaskUsesItsOwnTimeZoneForNextWeekColumn() throws {
        var snapshot = TaskifySnapshot.empty
        var pacificCalendar = Calendar(identifier: .gregorian)
        pacificCalendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let lateWednesday = try XCTUnwrap(pacificCalendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 22,
            hour: 23,
            minute: 30
        )))
        let task = try XCTUnwrap(snapshot.addTask(
            title: "Nightly Pacific task",
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.wednesday.rawValue,
            dueDate: lateWednesday,
            now: lateWednesday
        ))
        XCTAssertTrue(snapshot.updateTask(
            taskID: task.id,
            title: task.title,
            note: "",
            dueDate: lateWednesday,
            dueDateEnabled: true,
            dueTimeEnabled: true,
            dueTimeZone: "America/Los_Angeles",
            priority: nil,
            columnID: task.columnID,
            subtasks: [],
            recurrence: .daily(),
            calendar: pacificCalendar
        ))

        XCTAssertTrue(snapshot.toggleCompletion(taskID: task.id, now: lateWednesday))

        let next = try XCTUnwrap(snapshot.tasks.first(where: { $0.id != task.id }))
        XCTAssertEqual(next.columnID, WeekdayColumn.thursday.rawValue)
        XCTAssertEqual(
            pacificCalendar.component(.hour, from: try XCTUnwrap(next.dueDate)),
            23
        )
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

    func testTaskifyEventReminderFireDatesMatchPWAOffsets() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 20,
            hour: 14
        )))
        let event = TaskifyEvent(
            id: "event-1",
            boardID: "board",
            title: "Planning session",
            schedule: .time,
            startISO: ISO8601DateFormatter().string(from: start),
            startTimeZoneID: "UTC",
            reminders: [TaskReminder(rawValue: "15m"), TaskReminder(rawValue: "1h")],
            canonicalAddress: "",
            viewAddress: "",
            eventKey: "",
            inviteToken: "",
            rsvpStatus: .accepted
        )

        let dates = event.reminderFireDates(calendar: calendar)

        XCTAssertEqual(dates.map(\.0.rawValue), ["15m", "1h"])
        XCTAssertEqual(
            dates.map(\.1),
            [
                start.addingTimeInterval(-15 * 60),
                start.addingTimeInterval(-60 * 60),
            ]
        )
    }

    func testRecurringTaskifyEventBuildsPWACompatibleBoundedSeries() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let start = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 10,
            day: 26,
            hour: 9
        )))
        let seed = TaskifyEvent(
            id: "event-seed",
            boardID: "week-default",
            order: 0,
            title: "Weekly planning",
            schedule: .time,
            startISO: ISO8601DateFormatter().string(from: start),
            endISO: ISO8601DateFormatter().string(from: start.addingTimeInterval(3_600)),
            startTimeZoneID: "America/Chicago",
            endTimeZoneID: "America/Chicago",
            recurrence: .weekly(days: [1]),
            seriesID: "event-seed",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 1, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted
        )
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [seed]

        let changes = snapshot.rebuildTaskifyEventSeries(seedID: seed.id)

        XCTAssertEqual(changes.updatedEventIDs.count, 51)
        XCTAssertTrue(changes.deletedEventIDs.isEmpty)
        let events = try XCTUnwrap(snapshot.taskifyEvents)
        XCTAssertEqual(events.filter { !$0.isDeleted }.count, 52)
        let firstID = "recurrence_event-seed_2026-11-02"
        let first = try XCTUnwrap(events.first { $0.id == firstID })
        XCTAssertEqual(first.seriesID, seed.id)
        XCTAssertEqual(first.recurrence, seed.recurrence)
        XCTAssertEqual(first.startTimeZoneID, "America/Chicago")
        XCTAssertEqual(
            try XCTUnwrap(first.endDate).timeIntervalSince(try XCTUnwrap(first.startDate)),
            3_600,
            accuracy: 0.1
        )
        XCTAssertNotEqual(first.eventKey, seed.eventKey)
        XCTAssertFalse(first.eventKey.isEmpty)

        let localHour = calendar.component(.hour, from: try XCTUnwrap(first.startDate))
        XCTAssertEqual(localHour, 9, "Weekly recurrences must retain wall-clock time across DST")
        XCTAssertTrue(snapshot.rebuildTaskifyEventSeries(seedID: seed.id).updatedEventIDs.isEmpty)

        snapshot.taskifyEvents?[0].title = "Updated weekly planning"
        let editChanges = snapshot.rebuildTaskifyEventSeries(seedID: seed.id)
        XCTAssertEqual(editChanges.updatedEventIDs.count, 51)
        XCTAssertEqual(
            snapshot.taskifyEvents?.first { $0.id == firstID }?.title,
            "Updated weekly planning"
        )
    }

    func testMovingTaskifyEventAcrossBoardsReturnsSourceTombstoneMaterial() throws {
        var snapshot = TaskifySnapshot.empty
        let listBoard = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let destination = try XCTUnwrap(snapshot.addListColumn(
            boardID: listBoard.id,
            name: "Scheduled"
        ))
        let event = TaskifyEvent(
            id: "event-1",
            boardID: "week-default",
            order: 2,
            title: "Planning session",
            schedule: .date,
            startDateValue: "2026-07-30",
            canonicalAddress: "30310:old:event-1",
            viewAddress: "30311:old:event-1",
            eventKey: Data(repeating: 5, count: 32).base64EncodedString(),
            inviteToken: "",
            relayURLs: ["wss://old.example"],
            rsvpStatus: .accepted
        )
        snapshot.taskifyEvents = [event]

        let result = try XCTUnwrap(snapshot.moveTaskifyEvent(
            eventID: event.id,
            toBoardID: listBoard.id,
            columnID: destination.id,
            editorPublicKey: "editor"
        ))

        XCTAssertTrue(result.crossedBoards)
        XCTAssertEqual(result.movedEventIDs, [event.id])
        XCTAssertEqual(result.sourceEvents, [event])
        let moved = try XCTUnwrap(snapshot.taskifyEvents?.first)
        XCTAssertEqual(moved.boardID, listBoard.id)
        XCTAssertEqual(moved.columnID, destination.id)
        XCTAssertEqual(moved.lastEditedBy, "editor")
        XCTAssertEqual(moved.canonicalAddress, "")
        XCTAssertEqual(moved.viewAddress, "")
        XCTAssertEqual(moved.relayURLs, listBoard.effectiveRelayURLs)
        XCTAssertNil(moved.nostrUpdatedAt)
    }

    func testMovingTaskifyEventSeriesBetweenListsMovesActiveInstancesTogether() throws {
        var snapshot = TaskifySnapshot.empty
        let board = try XCTUnwrap(snapshot.createListBoard(name: "Projects"))
        let firstColumn = try XCTUnwrap(board.columns.first)
        let secondColumn = try XCTUnwrap(snapshot.addListColumn(
            boardID: board.id,
            name: "Scheduled"
        ))
        let seed = TaskifyEvent(
            id: "event-seed",
            boardID: board.id,
            columnID: firstColumn.id,
            order: 0,
            title: "Daily planning",
            schedule: .date,
            startDateValue: "2026-07-30",
            recurrence: .daily(),
            seriesID: "event-seed",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 6, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted
        )
        var instance = seed
        instance.id = "recurrence_event-seed_2026-07-31"
        instance.order = 1
        instance.startDateValue = "2026-07-31"
        instance.eventKey = Data(repeating: 7, count: 32).base64EncodedString()
        snapshot.taskifyEvents = [seed, instance]

        let result = try XCTUnwrap(snapshot.moveTaskifyEvent(
            eventID: seed.id,
            toBoardID: board.id,
            columnID: secondColumn.id
        ))

        XCTAssertFalse(result.crossedBoards)
        XCTAssertTrue(result.sourceEvents.isEmpty)
        XCTAssertEqual(Set(result.movedEventIDs), Set([seed.id, instance.id]))
        XCTAssertEqual(
            Set((snapshot.taskifyEvents ?? []).compactMap(\.columnID)),
            Set([secondColumn.id])
        )
    }

    func testMovingReadOnlyTaskifyEventIsRejected() {
        let event = TaskifyEvent(
            id: "shared-event",
            boardID: "week-default",
            title: "Shared event",
            schedule: .date,
            startDateValue: "2026-07-30",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 8, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted,
            readOnly: true
        )
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [event]

        XCTAssertNil(snapshot.moveTaskifyEvent(
            eventID: event.id,
            toBoardID: "week-default",
            columnID: nil
        ))
        XCTAssertEqual(snapshot.taskifyEvents, [event])
    }

    func testRemovingTaskifyEventRecurrenceTombstonesGeneratedSeries() {
        let seed = TaskifyEvent(
            id: "event-seed",
            boardID: "week-default",
            title: "Daily standup",
            schedule: .date,
            startDateValue: "2026-07-27",
            recurrence: .daily(),
            seriesID: "event-seed",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 2, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted
        )
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [seed]
        _ = snapshot.rebuildTaskifyEventSeries(seedID: seed.id)
        snapshot.taskifyEvents?[0].recurrence = nil
        snapshot.taskifyEvents?[0].seriesID = nil

        let changes = snapshot.rebuildTaskifyEventSeries(
            seedID: seed.id,
            replacingSeriesID: seed.id
        )

        XCTAssertEqual(changes.deletedEventIDs.count, 23)
        XCTAssertEqual(snapshot.acceptedTaskifyEvents, [snapshot.taskifyEvents![0]])
    }

    func testDeletingThisAndFutureTaskifyEventsEndsEarlierSeriesOccurrences() throws {
        let seed = TaskifyEvent(
            id: "event-seed",
            boardID: "week-default",
            title: "Daily standup",
            schedule: .date,
            startDateValue: "2026-07-27",
            recurrence: .daily(),
            seriesID: "event-seed",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 3, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted
        )
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [seed]
        _ = snapshot.rebuildTaskifyEventSeries(seedID: seed.id)

        let cutoffID = "recurrence_event-seed_2026-07-29"
        let changes = snapshot.deleteTaskifyEvent(
            eventID: cutoffID,
            scope: .thisAndFuture,
            editorPublicKey: "editor"
        )

        XCTAssertEqual(changes.deletedEventIDs.count, 22)
        let remaining = snapshot.acceptedTaskifyEvents
        XCTAssertEqual(remaining.map(\.startDateValue), ["2026-07-27", "2026-07-28"])
        XCTAssertEqual(remaining.map(\.seriesID), [seed.id, seed.id])
        for event in remaining {
            let until = try XCTUnwrap(event.recurrence?.untilDate)
            XCTAssertEqual(
                Calendar.current.startOfDay(for: until),
                Calendar.current.startOfDay(for: try XCTUnwrap(TaskifyEvent.dateOnly("2026-07-28")))
            )
        }
        for event in snapshot.taskifyEvents ?? [] {
            let until = try XCTUnwrap(event.recurrence?.untilDate)
            XCTAssertEqual(
                Calendar.current.startOfDay(for: until),
                Calendar.current.startOfDay(for: try XCTUnwrap(TaskifyEvent.dateOnly("2026-07-28")))
            )
        }
    }

    func testDeletingThisAndFutureRecurringTasksCapsAndTombstonesTheSeries() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let seriesID = "task-series"
        let dates = [
            DateComponents(year: 2026, month: 7, day: 27),
            DateComponents(year: 2026, month: 7, day: 28),
            DateComponents(year: 2026, month: 7, day: 29),
            DateComponents(year: 2026, month: 7, day: 30),
        ].compactMap(calendar.date(from:))
        XCTAssertEqual(dates.count, 4)

        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = dates.enumerated().map { index, date in
            TaskItem(
                id: index == 0
                    ? seriesID
                    : "recurrence:\(seriesID):2026-07-\(27 + index)",
                boardID: snapshot.boards[0].id,
                title: "Daily review",
                dueDate: date,
                dueDateEnabled: true,
                dueTimeZone: "UTC",
                recurrence: .daily(),
                seriesID: seriesID,
                columnID: WeekdayColumn.containing(date, calendar: calendar).rawValue
            )
        }

        let selectedID = "recurrence:\(seriesID):2026-07-29"
        let changes = snapshot.deleteTask(
            taskID: selectedID,
            scope: .thisAndFuture,
            editorPublicKey: "editor"
        )

        XCTAssertEqual(Set(changes.deletedTaskIDs), [
            selectedID,
            "recurrence:\(seriesID):2026-07-30",
        ])
        XCTAssertEqual(Set(changes.updatedTaskIDs), [
            seriesID,
            "recurrence:\(seriesID):2026-07-28",
        ])
        XCTAssertEqual(
            snapshot.tasks.filter { !$0.isDeleted }.compactMap(\.dueDate),
            Array(dates.prefix(2))
        )
        for task in snapshot.tasks {
            XCTAssertEqual(task.seriesID, seriesID)
            XCTAssertEqual(
                task.recurrence?.untilDate,
                calendar.date(from: DateComponents(year: 2026, month: 7, day: 28))
            )
        }
    }

    func testRemoteRecurringTaskTombstoneBlocksLaterStaleFutureOccurrencesAfterReload() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let board = TaskifySnapshot.empty.boards[0]
        let seriesID = "remote-series"
        let cutoff = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 7, day: 28))
        )
        let tombstoneDate = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 7, day: 29))
        )
        let tombstone = TaskItem(
            id: "recurrence:\(seriesID):2026-07-29",
            boardID: board.id,
            title: "Remote recurring task",
            dueDate: tombstoneDate,
            dueDateEnabled: true,
            recurrence: .daily(until: cutoff),
            seriesID: seriesID,
            deleted: true
        )
        var snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [],
            selectedBoardID: board.id
        )

        XCTAssertTrue(snapshot.mergeRemoteTask(tombstone, eventCreatedAt: 200))

        let encoded = try JSONEncoder().encode(snapshot)
        snapshot = try JSONDecoder().decode(TaskifySnapshot.self, from: encoded)
        snapshot.repairSelection()

        let futureDate = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))
        )
        let staleFuture = TaskItem(
            id: "recurrence:\(seriesID):2026-07-30",
            boardID: board.id,
            title: "Remote recurring task",
            dueDate: futureDate,
            dueDateEnabled: true,
            recurrence: .daily(),
            seriesID: seriesID
        )
        XCTAssertTrue(snapshot.mergeRemoteTask(staleFuture, eventCreatedAt: 500))

        let mergedFuture = try XCTUnwrap(snapshot.tasks.first { $0.id == staleFuture.id })
        XCTAssertTrue(mergedFuture.isDeleted)
        XCTAssertEqual(mergedFuture.recurrence?.untilDate, cutoff)
    }

    func testRemoteRecurringEventTombstoneBlocksLaterStaleFutureOccurrencesAfterReload() throws {
        let board = TaskifySnapshot.empty.boards[0]
        let seriesID = "remote-event-series"
        let cutoff = try XCTUnwrap(TaskifyEvent.dateOnly("2026-07-28"))
        let tombstone = TaskifyEvent(
            id: "recurrence_remote-event-series_2026-07-29",
            boardID: board.id,
            title: "Remote recurring event",
            schedule: .date,
            startDateValue: "2026-07-29",
            recurrence: .daily(until: cutoff),
            seriesID: seriesID,
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 7, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted,
            deleted: true
        )
        var snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [],
            selectedBoardID: board.id
        )

        XCTAssertTrue(snapshot.mergeRemoteTaskifyEvent(tombstone, eventCreatedAt: 200))

        let encoded = try JSONEncoder().encode(snapshot)
        snapshot = try JSONDecoder().decode(TaskifySnapshot.self, from: encoded)
        snapshot.repairSelection()

        let staleFuture = TaskifyEvent(
            id: "recurrence_remote-event-series_2026-07-30",
            boardID: board.id,
            title: "Remote recurring event",
            schedule: .date,
            startDateValue: "2026-07-30",
            recurrence: .daily(),
            seriesID: seriesID,
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 8, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted
        )
        XCTAssertTrue(snapshot.mergeRemoteTaskifyEvent(staleFuture, eventCreatedAt: 500))

        let mergedFuture = try XCTUnwrap(
            snapshot.taskifyEvents?.first { $0.id == staleFuture.id }
        )
        XCTAssertTrue(mergedFuture.isDeleted)
        XCTAssertEqual(mergedFuture.recurrence?.untilDate, cutoff)
    }

    func testTaskifyEventRecurrenceWindowRefillsAsOccurrencesPass() throws {
        let seed = TaskifyEvent(
            id: "event-seed",
            boardID: "week-default",
            title: "Daily standup",
            schedule: .date,
            startDateValue: "2026-07-01",
            recurrence: .daily(),
            seriesID: "event-seed",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 4, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted
        )
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [seed]
        _ = snapshot.rebuildTaskifyEventSeries(seedID: seed.id)
        let now = try XCTUnwrap(TaskifyEvent.dateOnly("2026-07-20"))

        let changes = snapshot.ensureTaskifyEventRecurrenceWindow(now: now)

        XCTAssertEqual(changes.updatedEventIDs.count, 19)
        XCTAssertTrue(changes.deletedEventIDs.isEmpty)
        let future = snapshot.acceptedTaskifyEvents.filter {
            ($0.endDate ?? $0.startDate ?? .distantPast) >= Calendar.current.startOfDay(for: now)
        }
        XCTAssertEqual(future.count, 24)
        XCTAssertNotNil(snapshot.taskifyEvents?.first {
            $0.id == "recurrence_event-seed_2026-08-12"
        })
        XCTAssertTrue(snapshot.ensureTaskifyEventRecurrenceWindow(now: now).allEventIDs.isEmpty)
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

    func testJSONStoreReportsAndStabilizesLoadTimeRepairs() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileURL = directory.appendingPathComponent("taskify.json")
        let store = JSONTaskStore(fileURL: fileURL)
        var legacySnapshot = TaskifySnapshot.empty
        legacySnapshot.boards[0].nostrBoardID = nil
        legacySnapshot.boards[0].relayURLs = []
        legacySnapshot.schemaVersion = 0
        try await store.save(legacySnapshot)

        let repairedLoad = try await store.loadWithRepairStatus()
        XCTAssertTrue(repairedLoad.wasRepaired)
        XCTAssertFalse(try XCTUnwrap(repairedLoad.snapshot.boards.first?.nostrBoardID).isEmpty)
        XCTAssertFalse(try XCTUnwrap(repairedLoad.snapshot.boards.first?.relayURLs).isEmpty)
        XCTAssertEqual(repairedLoad.snapshot.schemaVersion, TaskifySnapshot.currentSchemaVersion)

        try await store.save(repairedLoad.snapshot)
        let stableLoad = try await store.loadWithRepairStatus()
        XCTAssertFalse(stableLoad.wasRepaired)
        XCTAssertEqual(stableLoad.snapshot, repairedLoad.snapshot)
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

    func testScriptureMemorySortOrdersEntriesPerPWASemantics() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let isoFormatter = ISO8601DateFormatter()
        // Deliberately out of canonical/added order so each sort mode produces a distinct result.
        let exodus = ScriptureMemoryEntry(
            id: "exodus",
            bookID: "exo",
            chapter: 3,
            startVerse: 1,
            endVerse: 1,
            addedAtISO: isoFormatter.string(from: now.addingTimeInterval(-3600)),
            lastReviewISO: isoFormatter.string(from: now.addingTimeInterval(-86_400 * 30)),
            stage: 0
        )
        let genesis = ScriptureMemoryEntry(
            id: "genesis",
            bookID: "gen",
            chapter: 1,
            startVerse: 1,
            endVerse: 3,
            addedAtISO: isoFormatter.string(from: now.addingTimeInterval(-7200)),
            lastReviewISO: nil,
            stage: 0
        )
        let entries = [exodus, genesis]

        XCTAssertEqual(
            ScriptureMemoryAlgorithm.sortedEntries(entries, sort: .canonical, baseDays: 1, now: now)
                .map(\.entry.id),
            ["genesis", "exodus"],
            "Genesis precedes Exodus canonically regardless of add order"
        )
        XCTAssertEqual(
            ScriptureMemoryAlgorithm.sortedEntries(entries, sort: .oldest, baseDays: 1, now: now)
                .map(\.entry.id),
            ["genesis", "exodus"]
        )
        XCTAssertEqual(
            ScriptureMemoryAlgorithm.sortedEntries(entries, sort: .newest, baseDays: 1, now: now)
                .map(\.entry.id),
            ["exodus", "genesis"]
        )
        XCTAssertEqual(
            ScriptureMemoryAlgorithm.sortedEntries(entries, sort: .needsReview, baseDays: 1, now: now)
                .map(\.entry.id),
            ["genesis", "exodus"],
            "Never-reviewed Genesis is more overdue than a 30-day-old review of Exodus"
        )
    }

    // MARK: - Batched remote task merge

    private func makeSyncTask(id: String, title: String, boardID: String = "home") -> TaskItem {
        TaskItem(
            id: id,
            boardID: boardID,
            title: title,
            createdAt: Date(timeIntervalSince1970: 1_000),
            order: 0
        )
    }

    func testBatchedRemoteTaskMergeMatchesSequentialMerge() {
        var base = TaskifySnapshot.empty
        base.tasks = (0..<50).map { makeSyncTask(id: "task-\($0)", title: "local \($0)") }
        for index in base.tasks.indices {
            base.tasks[index].nostrUpdatedAt = 100
        }

        // Mix of updates (newer + stale) and brand-new inserts, plus a duplicate id.
        var records: [(task: TaskItem, eventCreatedAt: Int)] = []
        records.append((makeSyncTask(id: "task-3", title: "remote newer"), 200))
        records.append((makeSyncTask(id: "task-7", title: "remote stale"), 50))
        records.append((makeSyncTask(id: "new-a", title: "inserted a"), 300))
        records.append((makeSyncTask(id: "new-b", title: "inserted b"), 300))
        records.append((makeSyncTask(id: "new-a", title: "inserted a v2"), 400))

        var sequential = base
        for record in records {
            sequential.mergeRemoteTask(record.task, eventCreatedAt: record.eventCreatedAt)
        }

        var batched = base
        let changed = batched.mergeRemoteTasks(records)

        XCTAssertTrue(changed)
        XCTAssertEqual(
            batched.tasks.map(\.id),
            sequential.tasks.map(\.id),
            "Batched merge must produce the same task ordering as sequential merges"
        )
        XCTAssertEqual(
            batched.tasks.map(\.title),
            sequential.tasks.map(\.title),
            "Batched merge must resolve conflicts the same way as sequential merges"
        )
        XCTAssertEqual(
            batched.tasks.map { $0.nostrUpdatedAt ?? 0 },
            sequential.tasks.map { $0.nostrUpdatedAt ?? 0 }
        )

        // Stale record must not overwrite; newer must win; duplicate resolves to newest.
        XCTAssertEqual(batched.tasks.first { $0.id == "task-3" }?.title, "remote newer")
        XCTAssertEqual(batched.tasks.first { $0.id == "task-7" }?.title, "local 7")
        XCTAssertEqual(batched.tasks.first { $0.id == "new-a" }?.title, "inserted a v2")
    }

    func testBatchedMergeReturnsFalseWhenNothingChanges() {
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [makeSyncTask(id: "task-1", title: "local")]
        snapshot.tasks[0].nostrUpdatedAt = 500

        XCTAssertFalse(snapshot.mergeRemoteTasks([]))
        XCTAssertFalse(
            snapshot.mergeRemoteTasks([(makeSyncTask(id: "task-1", title: "stale"), 100)]),
            "A backlog of only-stale records must not report a change (avoids a pointless save + re-render)"
        )
        XCTAssertEqual(snapshot.tasks[0].title, "local")
    }

    func testBatchedMergeScalesBetterThanSequentialOnLargeBacklog() {
        let existingCount = 2_000
        let backlogCount = 1_000

        var base = TaskifySnapshot.empty
        base.tasks = (0..<existingCount).map { makeSyncTask(id: "task-\($0)", title: "local \($0)") }
        for index in base.tasks.indices {
            base.tasks[index].nostrUpdatedAt = 100
        }
        let records: [(task: TaskItem, eventCreatedAt: Int)] = (0..<backlogCount).map {
            (makeSyncTask(id: "task-\($0)", title: "remote \($0)"), 200)
        }

        var sequentialSnapshot = base
        let sequentialStart = Date()
        for record in records {
            sequentialSnapshot.mergeRemoteTask(record.task, eventCreatedAt: record.eventCreatedAt)
        }
        let sequentialDuration = Date().timeIntervalSince(sequentialStart)

        var batchedSnapshot = base
        let batchedStart = Date()
        batchedSnapshot.mergeRemoteTasks(records)
        let batchedDuration = Date().timeIntervalSince(batchedStart)

        XCTAssertEqual(batchedSnapshot.tasks.map(\.title), sequentialSnapshot.tasks.map(\.title))
        print("sequential=\(sequentialDuration)s batched=\(batchedDuration)s speedup=\(sequentialDuration / max(batchedDuration, 1e-9))x")
        XCTAssertLessThan(
            batchedDuration * 5,
            sequentialDuration,
            "Batched merge should be dramatically faster than repeated linear scans"
        )
    }
}

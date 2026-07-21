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

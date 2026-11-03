import Foundation
import XCTest
@testable import TaskifyCore
import TaskifyWatchShared

/// Reminders set by Siri (every Apple client) and from the Apple Watch editor.
final class ReminderFromSiriAndWatchTests: XCTestCase {
    private let fixedNow = Date(timeIntervalSince1970: 1_700_000_000) // Tuesday 2023-11-14 22:13:20 UTC
    private let calendar = Calendar.current

    private func temporaryStore() throws -> (JSONTaskStore, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return (JSONTaskStore(fileURL: directory.appendingPathComponent("taskify.json")), directory)
    }

    private func at(dayOffset: Int, hour: Int, minute: Int = 0) -> Date {
        let day = calendar.date(byAdding: .day, value: dayOffset, to: calendar.startOfDay(for: fixedNow))!
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day)!
    }

    // MARK: - Adding a task with a reminder outside the app

    func testTimedReminderKeepsItsTimeAndLandsOnItsDayOfTheWeek() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let board = Board.week()
        try await store.save(TaskifySnapshot(boards: [board], tasks: [], selectedBoardID: board.id))
        let due = at(dayOffset: 2, hour: 13)

        let created = try await TaskifyExternalActions.addTask(
            title: "Take out the trash",
            requestedBoardName: nil,
            dueDate: due,
            dueTimeEnabled: true,
            reminders: [TaskReminder(rawValue: "0h")],
            store: store,
            publisher: .disabled,
            now: fixedNow
        )

        let saved = try await store.load(areas: [.tasks])
        let task = try XCTUnwrap(saved.tasks.first { $0.id == created.task.id })
        XCTAssertEqual(task.dueDate, due)
        XCTAssertTrue(task.dueDateEnabled)
        XCTAssertTrue(task.dueTimeEnabled)
        XCTAssertEqual(task.dueTimeZone, TimeZone.current.identifier)
        XCTAssertEqual(task.reminders, [TaskReminder(rawValue: "0h")])
        XCTAssertNil(task.reminderTime)
        XCTAssertEqual(task.columnID, WeekdayColumn.containing(due).rawValue)
        XCTAssertNotEqual(task.columnID, WeekdayColumn.containing(fixedNow).rawValue)
        XCTAssertEqual(task.reminderFireDates().map(\.1), [due])
        XCTAssertEqual(task.publishPending, true)
    }

    func testDayReminderRemindsAtTheDefaultReminderTime() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let list = Board(id: "list", name: "Errands", kind: .list, columns: [BoardColumn(id: "todo", name: "To do", order: 0)])
        try await store.save(TaskifySnapshot(boards: [list], tasks: [], selectedBoardID: list.id))
        let day = calendar.startOfDay(for: at(dayOffset: 1, hour: 0))

        let created = try await TaskifyExternalActions.addTask(
            title: "Pay rent",
            requestedBoardName: nil,
            dueDate: day,
            reminders: [TaskReminder(rawValue: "0d")],
            store: store,
            publisher: .disabled,
            now: fixedNow
        )

        XCTAssertFalse(created.task.dueTimeEnabled)
        XCTAssertEqual(created.task.columnID, "todo")
        XCTAssertEqual(created.task.reminders, [TaskReminder(rawValue: "0d")])
        XCTAssertEqual(created.task.reminderTime, "09:00")
        let phrase = TaskifyReminderPhrase(title: "Pay rent", dueDate: day, hasTime: false)
        XCTAssertEqual(created.task.reminderFireDates().map(\.1), [phrase.fireDate()])
        XCTAssertEqual(phrase.reminderRawValues, ["0d"])
    }

    func testAddingWithoutADateIgnoresReminders() async throws {
        let (store, directory) = try temporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let list = Board(id: "list", name: "Errands", kind: .list, columns: [BoardColumn(id: "todo", name: "To do", order: 0)])
        try await store.save(TaskifySnapshot(boards: [list], tasks: [], selectedBoardID: list.id))

        let created = try await TaskifyExternalActions.addTask(
            title: "Buy milk",
            requestedBoardName: nil,
            reminders: [TaskReminder(rawValue: "0h")],
            store: store,
            publisher: .disabled,
            now: fixedNow
        )
        XCTAssertNil(created.task.dueDate)
        XCTAssertNil(created.task.reminders)
    }

    // MARK: - Notifications

    func testReminderNotificationsMatchTheAppSchedulersIdentifiers() {
        let account = String(repeating: "b", count: 64)
        let due = at(dayOffset: 1, hour: 13)
        let task = TaskItem(
            id: "t1", boardID: "board", title: "Take out the trash",
            dueDate: due, dueDateEnabled: true, dueTimeEnabled: true,
            reminders: [TaskReminder(rawValue: "15m"), TaskReminder(rawValue: "0h")]
        )

        let notifications = TaskifyTaskReminderNotification.notifications(for: task, accountID: account, after: fixedNow)
        XCTAssertEqual(notifications.map(\.identifier), ["taskify.task.t1.15m", "taskify.task.t1.0h"])
        XCTAssertEqual(notifications.map(\.fireDate), [due.addingTimeInterval(-15 * 60), due])
        XCTAssertEqual(notifications.map(\.body), ["15 minutes before", "At due time"])
        XCTAssertEqual(notifications.first?.title, "Take out the trash")
        XCTAssertEqual(notifications.first?.userInfo, [
            TaskifyNotificationContract.accountIDKey: account,
            TaskifyNotificationContract.taskIDKey: "t1",
            TaskifyNotificationContract.boardIDKey: "board",
        ])

        // Past reminders, and completed or deleted tasks, are not scheduled.
        XCTAssertEqual(
            TaskifyTaskReminderNotification.notifications(for: task, accountID: account, after: due.addingTimeInterval(-60))
                .map(\.identifier),
            ["taskify.task.t1.0h"]
        )
        var done = task
        done.completed = true
        XCTAssertTrue(TaskifyTaskReminderNotification.notifications(for: done, accountID: account, after: fixedNow).isEmpty)
        var deleted = task
        deleted.deleted = true
        XCTAssertTrue(TaskifyTaskReminderNotification.notifications(for: deleted, accountID: account, after: fixedNow).isEmpty)
    }

    // MARK: - Watch editor

    private func watchTask(payload: String?, dueTimeEnabled: Bool = true) -> TaskifyWatchTask {
        TaskifyWatchTask(
            id: "task", title: "Call mom", boardID: "board", boardName: "Board",
            columnName: nil, dueDate: at(dayOffset: 1, hour: 17), dueTimeEnabled: dueTimeEnabled,
            priority: nil, order: 0, syncPayload: payload.map { Data($0.utf8) }
        )
    }

    func testWatchEditReadsAndWritesTheTasksReminders() {
        let task = watchTask(payload: #"{"title":"Call mom","reminders":["15m"],"custom":"keep"}"#)
        var edit = TaskifyWatchTaskEdit(task: task)
        XCTAssertEqual(edit.reminders, ["15m"])
        XCTAssertTrue(edit.hasReminder("15m"))
        XCTAssertFalse(edit.hasReminder("0h"))

        edit.setReminder("0h", enabled: true)
        edit.setReminder("1h", enabled: true)
        edit.setReminder("15m", enabled: false)
        XCTAssertEqual(edit.reminders, ["0h", "1h"])

        let updated = task.applying(edit)
        XCTAssertEqual(updated.reminderRawValues, ["0h", "1h"])
        XCTAssertNil(updated.payloadObject["reminderTime"])
        XCTAssertEqual(updated.payloadObject["custom"] as? String, "keep")
    }

    func testWatchEditFollowsTheDueTimeAndDate() {
        var edit = TaskifyWatchTaskEdit(task: watchTask(payload: #"{"reminders":["0h","1d"]}"#))

        edit.dueTimeEnabled = false
        edit.normalizeReminders()
        XCTAssertEqual(edit.reminders, ["0d", "1d"])
        edit.reminderTime = "07:30"
        XCTAssertEqual(watchTask(payload: "{}").applying(edit).payloadObject["reminderTime"] as? String, "07:30")

        edit.dueTimeEnabled = true
        edit.normalizeReminders()
        XCTAssertEqual(edit.reminders, ["0h", "1d"])
        XCTAssertNil(edit.reminderTime)

        edit.dueDate = nil
        edit.normalizeReminders()
        XCTAssertEqual(edit.reminders, [])
        let cleared = watchTask(payload: #"{"reminders":["0h"]}"#).applying(edit)
        XCTAssertNil(cleared.payloadObject["reminders"])
    }

    func testWatchTaskWithoutAPayloadLeavesRemindersUnknown() throws {
        let task = watchTask(payload: nil)
        let edit = TaskifyWatchTaskEdit(task: task)
        XCTAssertNil(edit.reminders)
        XCTAssertNil(task.applying(edit).payloadObject["reminders"])
    }

    func testWatchEditFromAnOlderBuildDecodesWithoutReminders() throws {
        let json = Data(#"{"title":"Call mom","note":"","dueTimeEnabled":false}"#.utf8)
        let edit = try JSONDecoder().decode(TaskifyWatchTaskEdit.self, from: json)
        XCTAssertNil(edit.reminders)
        XCTAssertNil(edit.reminderTime)
    }

    // MARK: - What Siri says

    func testConfirmationSaysWhenInWords() {
        let now = at(dayOffset: 0, hour: 10)
        let tomorrow = at(dayOffset: 1, hour: 13)
        let text = TaskifyReminderPhrase.confirmation(
            title: "Take out the trash", fireDate: tomorrow, boardName: "Home", now: now
        )
        XCTAssertTrue(text.hasPrefix("OK, I'll remind you to take out the trash tomorrow at "), text)
        XCTAssertTrue(text.hasSuffix(". It's on Home."), text)
        XCTAssertTrue(TaskifyReminderPhrase.spokenTime(of: at(dayOffset: 0, hour: 17), now: now).hasPrefix("today at "))
        XCTAssertTrue(
            TaskifyReminderPhrase.confirmation(title: "NASA form", fireDate: tomorrow, boardName: "Work", now: now)
                .contains("remind you to NASA form")
        )
    }

    func testAShortcutsDateWithoutATimeIsADay() {
        let midnight = calendar.startOfDay(for: at(dayOffset: 3, hour: 0))
        let phrase = TaskifyReminderPhrase(title: "Pay rent").applying(explicitDate: midnight)
        XCTAssertEqual(phrase.dueDate, midnight)
        XCTAssertFalse(phrase.hasTime)
        let timed = TaskifyReminderPhrase(title: "Pay rent").applying(explicitDate: at(dayOffset: 3, hour: 8, minute: 15))
        XCTAssertTrue(timed.hasTime)
        XCTAssertEqual(timed.fireDate(), at(dayOffset: 3, hour: 8, minute: 15))
    }
}

import Foundation
import XCTest
@testable import TaskifyCore

/// C10-1: the widget, Siri and Shortcuts edit tasks outside the app. They complete the way the
/// app does, with the user's settings, and never reopen a task completed elsewhere.
final class ExternalActionsTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    private func daily(_ id: String, completed: Bool = false, streak: Int? = nil) -> TaskItem {
        var task = TaskItem(
            id: id, boardID: "week-default", title: "Daily",
            dueDate: Date(timeIntervalSince1970: 1_790_000_000),
            dueDateEnabled: true, recurrence: .daily(), seriesID: "s"
        )
        task.completed = completed
        task.streak = streak
        return task
    }

    func testCompletingATaskCompletedElsewhereLeavesItCompleted() {
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [daily("done", completed: true)]
        let before = snapshot

        XCTAssertFalse(TaskifyExternalActions.setCompleted(
            true, taskID: "done", in: &snapshot, settings: TaskifyDeviceTaskSettings()
        ))
        XCTAssertEqual(snapshot, before)
    }

    func testCompletionFollowsTheStreakSetting() {
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [daily("today", streak: 3)]

        XCTAssertTrue(TaskifyExternalActions.setCompleted(
            true, taskID: "today", in: &snapshot,
            settings: TaskifyDeviceTaskSettings(streaksEnabled: false)
        ))
        XCTAssertEqual(snapshot.tasks.first { $0.id == "today" }?.streak, 3)
    }

    func testCompletionMatchesTheAppsCompletion() throws {
        let monday = try XCTUnwrap(Calendar(identifier: .gregorian).date(from: DateComponents(
            timeZone: utc, year: 2026, month: 7, day: 13, hour: 12
        )))
        let board = Board.week()
        let task = TaskItem(
            boardID: board.id, title: "Monthly review", dueDate: monday, dueDateEnabled: true,
            recurrence: .monthlyDay(day: 13), columnID: WeekdayColumn.monday.rawValue
        )
        let start = TaskifySnapshot(boards: [board], tasks: [task], selectedBoardID: board.id)
        let settings = TaskifyDeviceTaskSettings(
            streaksEnabled: false, weekStart: .monday, editorPublicKey: String(repeating: "a", count: 64)
        )

        var inApp = start
        XCTAssertTrue(inApp.toggleCompletion(
            taskID: task.id, editorPublicKey: settings.editorPublicKey,
            streaksEnabled: false, weekStartsOn: .monday, now: monday
        ))
        var outside = start
        XCTAssertTrue(TaskifyExternalActions.setCompleted(
            true, taskID: task.id, in: &outside, settings: settings, now: monday
        ))

        XCTAssertEqual(outside, inApp)
        XCTAssertEqual(outside.tasks.first { $0.id == task.id }?.lastEditedBy, settings.editorPublicKey)
    }

    func testMarkingIncompleteReopensOnlyACompletedTask() {
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [daily("open")]
        XCTAssertFalse(TaskifyExternalActions.setCompleted(
            false, taskID: "open", in: &snapshot, settings: TaskifyDeviceTaskSettings()
        ))
        snapshot.tasks = [daily("done", completed: true)]
        XCTAssertTrue(TaskifyExternalActions.setCompleted(
            false, taskID: "done", in: &snapshot, settings: TaskifyDeviceTaskSettings()
        ))
        XCTAssertEqual(snapshot.tasks.first?.completed, false)
    }

    func testSettingsRoundTripThroughSharedDefaults() throws {
        let name = "ExternalActionsTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }

        XCTAssertEqual(TaskifyDeviceTaskSettings.load(from: defaults), TaskifyDeviceTaskSettings())
        TaskifyDeviceTaskSettings.update(in: defaults) {
            $0.streaksEnabled = false
            $0.weekStart = .saturday
        }
        TaskifyDeviceTaskSettings.update(in: defaults) { $0.newTaskPosition = .bottom }
        XCTAssertEqual(
            TaskifyDeviceTaskSettings.load(from: defaults),
            TaskifyDeviceTaskSettings(streaksEnabled: false, weekStart: .saturday, newTaskPosition: .bottom)
        )
    }
}

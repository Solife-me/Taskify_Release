import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyCore

final class VoiceTaskCreationTests: XCTestCase {
    func testDateOnlyUsesLocalMidnightOnPhoneAndWatch() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let date = try XCTUnwrap(VoiceTaskDate.parse("2026-09-12", timeZone: zone))
        XCTAssertEqual(ISO8601DateFormatter().string(from: date), "2026-09-12T05:00:00Z")
        XCTAssertFalse(VoiceTaskDate.hasExplicitTime("2026-09-12"))
        XCTAssertTrue(VoiceTaskDate.hasExplicitTime("2026-09-12T18:00:00Z"))
        XCTAssertNil(VoiceTaskDate.parse("2026-02-30", timeZone: zone))
    }

    func testWatchApprovalPlacementUsesLocalDateAndHidesUnspecifiedClockTime() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let board = TaskifyWatchBoard(id: "week", name: "Week", openTaskCount: 0, kind: "week")
        let draft = TaskifyWatchVoiceDraft(title: "Tomorrow", dueISO: "2026-09-12")
        let preview = draft.taskPreview(board: board, calendar: calendar)
        XCTAssertEqual(preview.columnID, "saturday")
        XCTAssertEqual(preview.columnName, "Sat")
        XCTAssertFalse(preview.dueTimeEnabled)
        XCTAssertEqual(calendar.component(.day, from: try XCTUnwrap(preview.dueDate)), 12)
    }

    func testPreviewAndSaveUseTheSameFinalizedTaskFields() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-12T03:02:00Z"))
        var saved = TaskifySnapshot.empty
        var preview = saved
        let boardID = saved.selectedBoardID
        let voice = VoiceFinalTask(title: "Meet technician", dueISO: "2026-09-12T18:00:00Z", notes: "At the house", subtasks: ["Bring keys"], priority: 3, reminderMinutesBeforeDue: [15, 60], recurrence: .weekly(days: [6]))
        let before = saved.tasks.count
        let card = try XCTUnwrap(preview.addVoiceTasks([voice], defaultBoardID: boardID, calendar: calendar, now: now).first)
        XCTAssertEqual(saved.tasks.count, before, "Approval must not create a live task")
        let task = try XCTUnwrap(saved.addVoiceTasks([voice], defaultBoardID: boardID, calendar: calendar, now: now).first)
        XCTAssertEqual(task.title, card.title)
        XCTAssertEqual(task.note, card.note)
        XCTAssertEqual(task.dueDate, card.dueDate)
        XCTAssertEqual(calendar.component(.hour, from: try XCTUnwrap(task.dueDate)), 13)
        XCTAssertEqual(task.columnID, "saturday")
        XCTAssertEqual(task.dueTimeEnabled, card.dueTimeEnabled)
        XCTAssertEqual(task.reminders, card.reminders)
        XCTAssertEqual(task.recurrence, card.recurrence)
        XCTAssertEqual(task.subtasks?.map(\.title), card.subtasks?.map(\.title))
    }

    func testDateOnlyVoiceTaskDoesNotFallBackToToday() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.selectedBoardID
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-12T03:02:00Z"))
        let task = try XCTUnwrap(snapshot.addVoiceTasks([VoiceFinalTask(title: "Tomorrow", dueISO: "2026-09-12")], defaultBoardID: boardID, calendar: calendar, now: now).first)
        XCTAssertEqual(calendar.component(.day, from: try XCTUnwrap(task.dueDate)), 12)
        XCTAssertEqual(task.columnID, "saturday")
        XCTAssertFalse(task.dueTimeEnabled)
    }
}

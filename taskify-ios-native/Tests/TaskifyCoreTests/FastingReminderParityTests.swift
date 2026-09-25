import Foundation
import XCTest
@testable import TaskifyCore

/// The PWA's `fastingReminderDueTimesForMonth` must pick the same days for the same seed, or two
/// devices with random-mode reminders would keep deleting each other's. Values pinned from the PWA
/// (`fastingReminderParity.test.ts`).
final class FastingReminderParityTests: XCTestCase {
    private func days(year: Int, monthIndex: Int, perMonth: Int) -> [Int] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return FastingReminders.dueDates(
            year: year, monthIndex: monthIndex, mode: .random, weekday: 1,
            perMonth: perMonth, seed: "parity-seed", calendar: calendar
        ).map { calendar.component(.day, from: $0) }
    }

    func testRandomDaysMatchThePWA() {
        XCTAssertEqual(days(year: 2026, monthIndex: 9, perMonth: 5), [4, 10, 25, 26, 31])
        XCTAssertEqual(days(year: 2027, monthIndex: 1, perMonth: 3), [4, 11, 27])
    }
}

/// Fasting reminders are generated independently on every device, so they must be recognisable
/// and identical across clients: the PWA's series id, date-derived task ids, and no deletions
/// from a device where the feature is merely off.
final class FastingReminderReconcileTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()
    private let now = Date(timeIntervalSince1970: 1_790_000_000) // 2026-09-21

    private func reconcile(_ snapshot: inout TaskifySnapshot, enabled: Bool = true, removeWhenDisabled: Bool = false)
        -> (created: [TaskItem], updatedIDs: [String]) {
        snapshot.reconcileFastingReminders(
            enabled: enabled, mode: .weekday, weekday: 1, perMonth: 2, seed: "s",
            calendar: calendar, now: now, removeExistingWhenDisabled: removeWhenDisabled
        )
    }

    private func reminder(_ id: String, board: String, day: Int, completed: Bool = false) -> TaskItem {
        var task = TaskItem(
            id: id, boardID: board, title: "Fasting",
            dueDate: now.addingTimeInterval(TimeInterval(day * 86_400)), dueDateEnabled: true,
            seriesID: "fasting-reminder"
        )
        task.completed = completed
        return task
    }

    /// "week-default" is a different board on every device; reminders follow the shared board
    /// that already holds them, so a fresh device doesn't put them on its own startup board.
    func testRemindersFollowTheBoardThatAlreadyHoldsThem() {
        var snapshot = TaskifySnapshot.empty
        var shared = Board.week(id: "account-week", name: "Personal schedule")
        shared.nostrBoardID = "shared-nostr-id"
        snapshot.boards.append(shared)
        snapshot.tasks = [
            reminder("fasting-reminder:old-1", board: "account-week", day: -30, completed: true),
            reminder("fasting-reminder:old-2", board: "account-week", day: -20, completed: true),
        ]
        XCTAssertEqual(snapshot.fastingReminderTargetBoard()?.id, "account-week")
        let created = reconcile(&snapshot).created
        XCTAssertFalse(created.isEmpty)
        XCTAssertTrue(created.allSatisfy { $0.boardID == "account-week" })
    }

    func testDevicesAgreeWhenRemindersAreSplitAcrossBoards() {
        var snapshot = TaskifySnapshot.empty
        var first = Board.week(id: "board-a", name: "A")
        first.nostrBoardID = "zzz"
        var second = Board.week(id: "board-b", name: "B")
        second.nostrBoardID = "aaa"
        snapshot.boards.append(contentsOf: [first, second])
        snapshot.tasks = [
            reminder("fasting-reminder:x", board: "board-a", day: -5, completed: true),
            reminder("fasting-reminder:y", board: "board-b", day: -6, completed: true),
        ]
        // Equal counts: the lower shared board id wins, whatever the local order.
        XCTAssertEqual(snapshot.fastingReminderTargetBoard()?.id, "board-b")
        snapshot.tasks.append(reminder("fasting-reminder:z", board: "board-a", day: -7, completed: true))
        XCTAssertEqual(snapshot.fastingReminderTargetBoard()?.id, "board-a", "The board holding the most wins")
    }

    func testWithNoRemindersAnywhereTheDefaultWeekBoardIsUsed() {
        var snapshot = TaskifySnapshot.empty
        snapshot.boards.append(Board.week(id: "other-week", name: "Other"))
        XCTAssertEqual(snapshot.fastingReminderTargetBoard()?.id, "week-default")
    }

    func testCreatedRemindersUseThePWASeriesAndDateDerivedIDs() {
        var snapshot = TaskifySnapshot.empty
        let created = reconcile(&snapshot).created
        XCTAssertFalse(created.isEmpty)
        for task in created {
            XCTAssertEqual(task.seriesID, "fasting-reminder")
            let day = calendar.dateComponents([.year, .month, .day], from: task.dueDate!)
            XCTAssertEqual(task.id, String(format: "fasting-reminder:%04d-%02d-%02d", day.year!, day.month!, day.day!))
        }
        // Idempotent: nothing more to create.
        XCTAssertTrue(reconcile(&snapshot).created.isEmpty)
    }

    func testAReminderCreatedByTheOtherClientIsNotDuplicated() throws {
        var reference = TaskifySnapshot.empty
        let first = try XCTUnwrap(reconcile(&reference).created.first)
        var snapshot = TaskifySnapshot.empty
        // As synced from the PWA: its series id, a random id.
        snapshot.tasks.append(TaskItem(
            id: UUID().uuidString, boardID: first.boardID, title: "Fasting", note: "Fasting reminder",
            dueDate: first.dueDate, dueDateEnabled: true, seriesID: "fasting-reminder", columnID: first.columnID
        ))
        let created = reconcile(&snapshot).created
        XCTAssertFalse(created.contains { $0.dueDate == first.dueDate })
    }

    func testLegacyNativeSeriesIsMigrated() throws {
        var reference = TaskifySnapshot.empty
        let first = try XCTUnwrap(reconcile(&reference).created.first)
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks.append(TaskItem(
            id: "legacy", boardID: first.boardID, title: "Fasting", note: "Fasting reminder",
            dueDate: first.dueDate, dueDateEnabled: true, seriesID: "fasting-reminder-series", columnID: first.columnID
        ))
        let result = reconcile(&snapshot)
        XCTAssertTrue(result.updatedIDs.contains("legacy"))
        XCTAssertEqual(snapshot.tasks.first { $0.id == "legacy" }?.seriesID, "fasting-reminder")
        XCTAssertFalse(result.created.contains { $0.dueDate == first.dueDate })
    }

    func testFeatureOffLeavesOtherDevicesRemindersAlone() throws {
        var snapshot = TaskifySnapshot.empty
        _ = reconcile(&snapshot)
        let count = snapshot.tasks.filter { !$0.isDeleted }.count
        XCTAssertTrue(reconcile(&snapshot, enabled: false).updatedIDs.isEmpty)
        XCTAssertEqual(snapshot.tasks.filter { !$0.isDeleted }.count, count)
        // Turning it off on this device still clears the pending ones.
        XCTAssertEqual(reconcile(&snapshot, enabled: false, removeWhenDisabled: true).updatedIDs.count, count)
    }

    func testAnExistingReminderIDIsNeverRecreated() throws {
        var snapshot = TaskifySnapshot.empty
        let first = try XCTUnwrap(reconcile(&snapshot).created.first)
        let index = try XCTUnwrap(snapshot.tasks.firstIndex { $0.id == first.id })
        snapshot.tasks[index].deleted = true
        XCTAssertFalse(reconcile(&snapshot).created.contains { $0.id == first.id })
    }
}

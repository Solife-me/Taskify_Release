import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyWidgetDataTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_785_600_000) // 2026-08-02 12:00 UTC
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func snapshot(_ tasks: [(title: String, due: Date?, completed: Bool, deleted: Bool)]) -> TaskifySnapshot {
        let board = Board(name: "Work", kind: .list, columns: [BoardColumn(id: "col", name: "To do", order: 0)])
        var snapshot = TaskifySnapshot(boards: [board], tasks: [], selectedBoardID: board.id)
        for (offset, spec) in tasks.enumerated() {
            let task = TaskItem(
                boardID: board.id,
                title: spec.title,
                dueDate: spec.due,
                dueDateEnabled: spec.due != nil,
                createdAt: Date(timeIntervalSince1970: 1_000_000 + Double(offset)),
                order: offset,
                columnID: "col",
                completed: spec.completed,
                deleted: spec.deleted ? true : nil
            )
            snapshot.tasks.append(task)
        }
        return snapshot
    }

    private func at(_ hoursFromNow: Double) -> Date {
        now.addingTimeInterval(hoursFromNow * 3600)
    }

    // MARK: - Today

    func testIncludesTasksDueLaterToday() {
        let data = snapshot([("Standup", at(2), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.map(\.title), ["Standup"])
        XCTAssertTrue(data.overdue.isEmpty)
    }

    func testIncludesTasksDueEarlierTodayWithoutCallingThemOverdue() {
        // Earlier today is still today -- only a previous day counts as overdue.
        let data = snapshot([("Email", at(-3), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.map(\.title), ["Email"])
        XCTAssertTrue(data.overdue.isEmpty)
    }

    func testExcludesTasksDueTomorrow() {
        let data = snapshot([("Later", at(30), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.isEmpty)
    }

    func testExcludesCompletedAndDeletedTasks() {
        let data = snapshot([
            ("Done", at(1), true, false),
            ("Gone", at(1), false, true),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.isEmpty)
    }

    func testExcludesTasksWithNoDueDate() {
        let data = snapshot([("Someday", nil, false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.today.isEmpty)
    }

    // MARK: - Overdue

    func testSeparatesOverdueFromToday() {
        let data = snapshot([
            ("Yesterday", at(-30), false, false),
            ("Today", at(2), false, false),
        ]).widgetData(now: now, calendar: calendar)

        XCTAssertEqual(data.overdue.map(\.title), ["Yesterday"])
        XCTAssertEqual(data.today.map(\.title), ["Today"])
        XCTAssertTrue(data.overdue.allSatisfy(\.isOverdue))
        XCTAssertTrue(data.today.allSatisfy { !$0.isOverdue })
    }

    /// The Lock Screen shows one task, so it has to be the most pressing one.
    func testNextTaskPrefersOverdueWork() {
        let data = snapshot([
            ("Yesterday", at(-30), false, false),
            ("Today", at(1), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.nextTask?.title, "Yesterday")
    }

    func testNextTaskFallsBackToTodaysEarliest() {
        let data = snapshot([
            ("Afternoon", at(5), false, false),
            ("Morning", at(1), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.nextTask?.title, "Morning")
    }

    func testRemainingCountIncludesOverdue() {
        let data = snapshot([
            ("Yesterday", at(-30), false, false),
            ("Today", at(1), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.remainingCount, 2)
    }

    // MARK: - Ordering, limits, boards

    func testTasksAreOrderedByDueDate() {
        let data = snapshot([
            ("Third", at(6), false, false),
            ("First", at(1), false, false),
            ("Second", at(3), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.map(\.title), ["First", "Second", "Third"])
    }

    func testHonoursTheRowLimit() {
        let many = (1...20).map { ("Task \($0)", at(Double($0) * 0.1), false, false) }
        let data = snapshot(many).widgetData(now: now, calendar: calendar, limit: 5)
        XCTAssertEqual(data.today.count, 5)
        XCTAssertEqual(data.today.first?.title, "Task 1")
    }

    func testCarriesTheBoardNameForEachTask() {
        let data = snapshot([("Standup", at(1), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.first?.boardName, "Work")
    }

    func testBoardSummariesCountOnlyOpenTasks() {
        let data = snapshot([
            ("Open", at(1), false, false),
            ("Done", at(1), true, false),
            ("Deleted", at(1), false, true),
        ]).widgetData(now: now, calendar: calendar)

        XCTAssertEqual(data.boards.map(\.name), ["Work"])
        XCTAssertEqual(data.boards.first?.openTaskCount, 1)
    }

    func testSurvivesAJSONRoundTrip() throws {
        let data = snapshot([("Standup", at(1), false, false)])
            .widgetData(now: now, calendar: calendar)
        let decoded = try JSONDecoder().decode(
            TaskifyWidgetData.self,
            from: JSONEncoder().encode(data)
        )
        XCTAssertEqual(decoded, data)
    }
}

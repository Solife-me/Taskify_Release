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
    }

    func testIncludesTasksDueEarlierToday() {
        // Earlier today is still today; only a previous day is excluded.
        let data = snapshot([("Email", at(-3), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.map(\.title), ["Email"])
    }

    func testTomorrowIsUpcomingButNotToday() {
        let data = snapshot([("Later", at(30), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.today.isEmpty)
        XCTAssertEqual(data.todayCount, 0)
        XCTAssertEqual(data.upcoming.map(\.title), ["Later"])
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

    // MARK: - Overdue is not the widget's business

    /// Upcoming filters to `dueDate >= startOfToday`, so overdue work appears nowhere in the app.
    /// Week-board tasks are all created with a due date, so unfinished ones accumulate forever --
    /// counting them here produced a widget reporting a dozen tasks against an Upcoming view
    /// showing none.
    func testExcludesOverdueTasksEntirely() {
        let data = snapshot([
            ("Yesterday", at(-30), false, false),
            ("Last week", at(-24 * 7), false, false),
            ("Today", at(2), false, false),
        ]).widgetData(now: now, calendar: calendar)

        XCTAssertEqual(data.today.map(\.title), ["Today"])
        XCTAssertEqual(data.todayCount, 1)
    }

    func testShowsNothingWhenOnlyOverdueWorkExists() {
        let data = snapshot([("Yesterday", at(-30), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.isEmpty)
        XCTAssertNil(data.nextTask)
        XCTAssertEqual(data.todayCount, 0)
    }

    // MARK: - Upcoming vs Today

    /// The Upcoming widget looks ahead; the Today widget doesn't.
    func testUpcomingLooksBeyondTodayButTodayDoesNot() {
        let data = snapshot([
            ("Today", at(2), false, false),
            ("Tomorrow", at(26), false, false),
            ("Next week", at(24 * 7), false, false),
        ]).widgetData(now: now, calendar: calendar)

        XCTAssertEqual(data.today.map(\.title), ["Today"])
        XCTAssertEqual(data.upcoming.map(\.title), ["Today", "Tomorrow", "Next week"])
        XCTAssertEqual(data.todayCount, 1)
    }

    func testUpcomingExcludesOverdueToo() {
        let data = snapshot([
            ("Yesterday", at(-30), false, false),
            ("Tomorrow", at(26), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.upcoming.map(\.title), ["Tomorrow"])
    }

    /// With today clear, the Lock Screen should still name whatever is actually next.
    func testNextTaskLooksAheadWhenTodayIsEmpty() {
        let data = snapshot([("Thursday", at(48), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.today.isEmpty)
        XCTAssertEqual(data.nextTask?.title, "Thursday")
    }

    func testNextTaskIsTodaysEarliest() {
        let data = snapshot([
            ("Afternoon", at(5), false, false),
            ("Morning", at(1), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.nextTask?.title, "Morning")
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

import XCTest
@testable import TaskifyCore

/// C8-7: Upcoming's split of tasks into days, moved out of the view.
final class UpcomingDayGroupingTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        return calendar
    }

    private func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    func testTasksFallIntoTheirLocalDaySortedWithinIt() {
        let now = date("2026-10-20T15:00:00Z")
        var late = TaskItem(id: "late", boardID: "b", title: "Late")
        late.dueDate = date("2026-10-21T22:00:00Z") // 5 pm in Chicago, Oct 21
        late.dueTimeEnabled = true
        var early = TaskItem(id: "early", boardID: "b", title: "Early")
        early.dueDate = date("2026-10-21T14:00:00Z")
        early.dueTimeEnabled = true
        var nextDayUTC = TaskItem(id: "evening", boardID: "b", title: "Evening")
        nextDayUTC.dueDate = date("2026-10-22T03:00:00Z") // still Oct 21 in Chicago
        nextDayUTC.dueTimeEnabled = true
        let undated = TaskItem(id: "undated", boardID: "b", title: "Undated")

        let days = UpcomingTaskOrganizer.tasksByDay(
            [late, nextDayUTC, early, undated],
            mode: .dueDate, direction: .ascending, boardGrouping: .mixed, boardOrder: ["b"],
            calendar: calendar, now: now
        )
        let oct21 = calendar.startOfDay(for: date("2026-10-21T18:00:00Z"))
        XCTAssertEqual(days[oct21]?.map(\.id), ["early", "late", "evening"])
        XCTAssertEqual(days[calendar.startOfDay(for: now)]?.map(\.id), ["undated"], "an undated task shows today")
        XCTAssertEqual(days.count, 2)
    }
}

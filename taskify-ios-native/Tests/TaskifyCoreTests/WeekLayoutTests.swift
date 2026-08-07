import Foundation
import XCTest
@testable import TaskifyCore

final class WeekLayoutTests: XCTestCase {
    private var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    func testWeekdayOrderRotatesFromConfiguredStart() {
        XCTAssertEqual(
            WeekdayColumn.ordered(startingAt: .saturday),
            [.saturday, .sunday, .monday, .tuesday, .wednesday, .thursday, .friday]
        )
        XCTAssertEqual(
            WeekdayColumn.ordered(startingAt: .monday),
            [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday]
        )
        XCTAssertEqual(WeekdayColumn.ordered(startingAt: .sunday), WeekdayColumn.allCases)
    }

    func testRequestedDayUsesExplicitPWAWeekBoundary() throws {
        let calendar = utcCalendar
        let sunday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 26
        )))

        let mondayInMondayWeek = WeekDateResolver.date(
            for: .monday,
            inWeekContaining: sunday,
            weekStartsOn: .monday,
            calendar: calendar
        )
        let mondayInSundayWeek = WeekDateResolver.date(
            for: .monday,
            inWeekContaining: sunday,
            weekStartsOn: .sunday,
            calendar: calendar
        )

        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day], from: mondayInMondayWeek),
            DateComponents(year: 2026, month: 7, day: 20)
        )
        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day], from: mondayInSundayWeek),
            DateComponents(year: 2026, month: 7, day: 27)
        )
    }

    func testMonthlyRecurrenceRevealsAtConfiguredWeekStart() throws {
        let calendar = utcCalendar
        let dueDate = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 13,
            hour: 12
        )))
        let board = Board.week()
        let task = TaskItem(
            boardID: board.id,
            title: "Monthly review",
            dueDate: dueDate,
            dueDateEnabled: true,
            recurrence: .monthlyDay(day: 13),
            columnID: WeekdayColumn.monday.rawValue
        )
        var snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [task],
            selectedBoardID: board.id
        )

        XCTAssertTrue(snapshot.toggleCompletion(
            taskID: task.id,
            weekStartsOn: .monday,
            now: dueDate
        ))

        let next = try XCTUnwrap(snapshot.tasks.first(where: { $0.id != task.id }))
        let hiddenUntil = try XCTUnwrap(next.hiddenUntilDate)
        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day], from: hiddenUntil),
            DateComponents(year: 2026, month: 8, day: 10)
        )
    }

    func testChangingWeekStartRebasesExistingBoundaryTasks() throws {
        let calendar = utcCalendar
        let sunday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 26,
            hour: 12
        )))
        let monday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 27,
            hour: 12
        )))
        let board = Board.week()
        let task = TaskItem(
            boardID: board.id,
            title: "Monday boundary",
            dueDate: monday,
            dueDateEnabled: true,
            columnID: WeekdayColumn.monday.rawValue
        )
        var snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [task],
            selectedBoardID: board.id
        )

        XCTAssertEqual(
            snapshot.rebaseWeekVisibility(
                startingOn: .monday,
                calendar: calendar,
                now: sunday
            ),
            [task.id]
        )
        XCTAssertEqual(
            calendar.dateComponents(
                [.year, .month, .day],
                from: try XCTUnwrap(snapshot.tasks[0].hiddenUntilDate)
            ),
            DateComponents(year: 2026, month: 7, day: 27)
        )

        XCTAssertEqual(
            snapshot.rebaseWeekVisibility(
                startingOn: .sunday,
                calendar: calendar,
                now: sunday
            ),
            [task.id]
        )
        XCTAssertNil(snapshot.tasks[0].hiddenUntilDate)
    }
}

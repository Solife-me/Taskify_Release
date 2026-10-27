import XCTest
@testable import TaskifyCore

/// C8-4: when the day changes while the app is open or in the background, what was showing
/// "today" moves to the new today; a day the user chose stays chosen.
final class DayRolloverTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        return calendar
    }

    private func day(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = calendar.timeZone
        formatter.formatOptions = [.withFullDate]
        return formatter.date(from: value)!
    }

    func testASelectionOnTheOldTodayMovesToTheNewToday() {
        let selected = DayRollover.selectedDay(day("2026-10-19"), previousToday: day("2026-10-19"), today: day("2026-10-20"), calendar: calendar)
        XCTAssertEqual(selected, day("2026-10-20"))
    }

    func testAChosenDayStaysChosen() {
        let selected = DayRollover.selectedDay(day("2026-10-23"), previousToday: day("2026-10-19"), today: day("2026-10-20"), calendar: calendar)
        XCTAssertEqual(selected, day("2026-10-23"))
    }

    func testTheWeekColumnFollowsTodayOnlyFromTheOldToday() {
        XCTAssertEqual(
            DayRollover.weekColumn(WeekdayColumn.monday.rawValue, previousToday: day("2026-10-19"), today: day("2026-10-20"), calendar: calendar),
            WeekdayColumn.tuesday.rawValue
        )
        XCTAssertEqual(
            DayRollover.weekColumn(WeekdayColumn.friday.rawValue, previousToday: day("2026-10-19"), today: day("2026-10-20"), calendar: calendar),
            WeekdayColumn.friday.rawValue
        )
    }
}

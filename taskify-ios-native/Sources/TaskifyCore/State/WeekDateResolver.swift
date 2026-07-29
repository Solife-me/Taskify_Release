import Foundation

public enum WeekDateResolver {
    public static func startOfWeek(
        containing date: Date,
        startingOn firstDay: WeekdayColumn,
        calendar: Calendar = .current
    ) -> Date {
        let day = calendar.startOfDay(for: date)
        let currentWeekday = calendar.component(.weekday, from: day)
        let daysSinceStart = (currentWeekday - firstDay.calendarWeekday + 7) % 7
        return calendar.date(byAdding: .day, value: -daysSinceStart, to: day) ?? day
    }

    public static func date(
        for weekday: WeekdayColumn,
        inWeekContaining referenceDate: Date,
        weekStartsOn firstDay: WeekdayColumn? = nil,
        calendar: Calendar = .current
    ) -> Date {
        if let firstDay {
            let weekStart = startOfWeek(
                containing: referenceDate,
                startingOn: firstDay,
                calendar: calendar
            )
            let dayOffset = (weekday.calendarWeekday - firstDay.calendarWeekday + 7) % 7
            let targetDate = calendar.date(byAdding: .day, value: dayOffset, to: weekStart) ?? referenceDate
            return calendar.startOfDay(for: targetDate)
        }

        guard let weekInterval = calendar.dateInterval(of: .weekOfYear, for: referenceDate) else {
            return calendar.startOfDay(for: referenceDate)
        }

        let startWeekday = calendar.component(.weekday, from: weekInterval.start)
        let dayOffset = (weekday.calendarWeekday - startWeekday + 7) % 7
        let targetDate = calendar.date(byAdding: .day, value: dayOffset, to: weekInterval.start) ?? referenceDate
        return calendar.startOfDay(for: targetDate)
    }
}

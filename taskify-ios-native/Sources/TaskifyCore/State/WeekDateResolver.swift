import Foundation

public enum WeekDateResolver {
    public static func date(
        for weekday: WeekdayColumn,
        inWeekContaining referenceDate: Date,
        calendar: Calendar = .current
    ) -> Date {
        guard let weekInterval = calendar.dateInterval(of: .weekOfYear, for: referenceDate) else {
            return calendar.startOfDay(for: referenceDate)
        }

        let startWeekday = calendar.component(.weekday, from: weekInterval.start)
        let dayOffset = (weekday.calendarWeekday - startWeekday + 7) % 7
        let targetDate = calendar.date(byAdding: .day, value: dayOffset, to: weekInterval.start) ?? referenceDate
        return calendar.startOfDay(for: targetDate)
    }
}

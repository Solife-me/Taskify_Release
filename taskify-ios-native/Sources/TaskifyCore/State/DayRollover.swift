import Foundation

/// What a screen showing "today" does when the day changes under it (C8-4): a selection on the
/// old today moves to the new today, and a day the user chose stays chosen.
public enum DayRollover {
    public static func selectedDay(_ selected: Date, previousToday: Date, today: Date, calendar: Calendar = .current) -> Date {
        calendar.isDate(selected, inSameDayAs: previousToday) ? calendar.startOfDay(for: today) : selected
    }

    /// The week board's focused column (a `WeekdayColumn` raw value).
    public static func weekColumn(_ focused: String?, previousToday: Date, today: Date, calendar: Calendar = .current) -> String? {
        guard focused == WeekdayColumn.containing(previousToday, calendar: calendar).rawValue else { return focused }
        return WeekdayColumn.containing(today, calendar: calendar).rawValue
    }
}

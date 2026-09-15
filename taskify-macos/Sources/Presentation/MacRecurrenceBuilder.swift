import Foundation
import TaskifyCore

/// Turns a recurrence editor's picker choice plus its supporting fields into a `TaskRecurrence`.
/// Shared by the task and event editors so "weekly" and "every N months" build identically for
/// both, and so the one place that does the weekday/day-of-month arithmetic is tested.
public enum MacRecurrenceBuilder {
    public static func build(
        choice: String,
        referenceDate: Date,
        weeklyDays: Set<Int>,
        monthlyInterval: Int,
        interval: Int,
        intervalUnit: TaskRecurrenceUnit,
        until: Date?,
        existing: TaskRecurrence?,
        calendar: Calendar = .current
    ) -> TaskRecurrence? {
        switch choice {
        case "keep": existing
        case "none": nil
        case "daily": .daily(until: until)
        case "weekly": .weekly(days: weeklyDays.sorted(), until: until)
        case "monthly": .monthlyDay(day: calendar.component(.day, from: referenceDate), interval: monthlyInterval, until: until)
        case "interval": .every(interval, intervalUnit, until: until)
        default: existing
        }
    }
}

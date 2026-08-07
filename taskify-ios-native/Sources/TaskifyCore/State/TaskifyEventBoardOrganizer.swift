import Foundation

/// Produces the Taskify-event slices shown inside board columns. The PWA presents events before
/// tasks: week boards show only the active calendar week, while list boards keep current and
/// future events visible in their assigned list.
public enum TaskifyEventBoardOrganizer {
    public static func events(
        _ events: [TaskifyEvent],
        boardID: String,
        weekday: WeekdayColumn,
        weekStartsOn firstDay: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskifyEvent] {
        let targetDate = WeekDateResolver.date(
            for: weekday,
            inWeekContaining: now,
            weekStartsOn: firstDay,
            calendar: calendar
        )

        return events.filter { event in
            guard event.boardID == boardID,
                  !event.isDeleted,
                  let startDate = event.startDate else { return false }
            if event.isAllDay {
                return event.occurs(on: targetDate, calendar: calendar)
            }
            return calendar.isDate(startDate, inSameDayAs: targetDate)
        }.sorted(by: weekSort)
    }

    public static func events(
        _ events: [TaskifyEvent],
        boardID: String,
        columnID: String,
        weekStartsOn firstDay: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskifyEvent] {
        let visibleWeekStart = WeekDateResolver.startOfWeek(
            containing: now,
            startingOn: firstDay,
            calendar: calendar
        )

        return events.filter { event in
            guard event.boardID == boardID,
                  event.columnID == columnID,
                  !event.isDeleted,
                  let startDate = event.startDate else { return false }
            if event.isAllDay {
                let lastDate = max(startDate, event.endDate ?? startDate)
                return calendar.startOfDay(for: lastDate) >= visibleWeekStart
            }
            return calendar.startOfDay(for: startDate) >= visibleWeekStart
        }.sorted(by: listSort)
    }

    private static func weekSort(_ lhs: TaskifyEvent, _ rhs: TaskifyEvent) -> Bool {
        if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
        let lhsStart = lhs.startDate ?? .distantFuture
        let rhsStart = rhs.startDate ?? .distantFuture
        if lhsStart != rhsStart { return lhsStart < rhsStart }
        let lhsOrder = lhs.order ?? Int.max
        let rhsOrder = rhs.order ?? Int.max
        if lhsOrder != rhsOrder { return lhsOrder < rhsOrder }
        return lhs.id < rhs.id
    }

    private static func listSort(_ lhs: TaskifyEvent, _ rhs: TaskifyEvent) -> Bool {
        let lhsOrder = lhs.order ?? Int.max
        let rhsOrder = rhs.order ?? Int.max
        if lhsOrder != rhsOrder { return lhsOrder < rhsOrder }
        let lhsStart = lhs.startDate ?? .distantFuture
        let rhsStart = rhs.startDate ?? .distantFuture
        if lhsStart != rhsStart { return lhsStart < rhsStart }
        return lhs.id < rhs.id
    }
}

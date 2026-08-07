import Foundation

public struct BoardUpcomingGroup: Identifiable, Equatable, Sendable {
    public let date: Date
    public let tasks: [TaskItem]
    public let events: [TaskifyEvent]

    public var id: Date { date }

    public init(date: Date, tasks: [TaskItem], events: [TaskifyEvent]) {
        self.date = date
        self.tasks = tasks
        self.events = events
    }
}

/// Builds the board-scoped future timeline used by the PWA's Board Upcoming mode. Today remains
/// on the board itself; this projection starts tomorrow and places an all-day, multi-day event on
/// every future date it spans.
public enum BoardUpcomingOrganizer {
    private struct Bucket {
        var tasks: [TaskItem] = []
        var events: [TaskifyEvent] = []
    }

    public static func groups(
        tasks: [TaskItem],
        events: [TaskifyEvent],
        includedBoardIDs: Set<String>,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [BoardUpcomingGroup] {
        let today = calendar.startOfDay(for: now)
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: today) else { return [] }
        var buckets: [Date: Bucket] = [:]

        for task in tasks {
            guard includedBoardIDs.contains(task.boardID),
                  !task.isDeleted,
                  !task.completed,
                  task.dueDateEnabled,
                  let dueDate = task.dueDate else { continue }
            let date = calendar.startOfDay(for: dueDate)
            guard date >= tomorrow else { continue }
            buckets[date, default: Bucket()].tasks.append(task)
        }

        for event in events {
            guard let boardID = event.boardID,
                  includedBoardIDs.contains(boardID),
                  !event.isDeleted,
                  let startDate = event.startDate else { continue }

            if !event.isAllDay {
                let date = calendar.startOfDay(for: startDate)
                guard date >= tomorrow else { continue }
                buckets[date, default: Bucket()].events.append(event)
                continue
            }

            let first = max(calendar.startOfDay(for: startDate), tomorrow)
            let last = max(
                calendar.startOfDay(for: event.endDate ?? startDate),
                calendar.startOfDay(for: startDate)
            )
            guard first <= last else { continue }

            var date = first
            var expandedDayCount = 0
            while date <= last, expandedDayCount < 366 {
                buckets[date, default: Bucket()].events.append(event)
                guard let next = calendar.date(byAdding: .day, value: 1, to: date) else { break }
                date = next
                expandedDayCount += 1
            }
        }

        return buckets.map { date, bucket in
            BoardUpcomingGroup(
                date: date,
                tasks: bucket.tasks.sorted(by: taskSort),
                events: bucket.events.sorted(by: eventSort)
            )
        }
        .sorted { $0.date < $1.date }
    }

    private static func taskSort(_ lhs: TaskItem, _ rhs: TaskItem) -> Bool {
        let lhsDue = lhs.dueDate ?? .distantFuture
        let rhsDue = rhs.dueDate ?? .distantFuture
        if lhsDue != rhsDue { return lhsDue < rhsDue }
        if lhs.order != rhs.order { return lhs.order < rhs.order }
        return lhs.id < rhs.id
    }

    private static func eventSort(_ lhs: TaskifyEvent, _ rhs: TaskifyEvent) -> Bool {
        if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
        let lhsStart = lhs.startDate ?? .distantFuture
        let rhsStart = rhs.startDate ?? .distantFuture
        if lhsStart != rhsStart { return lhsStart < rhsStart }
        let lhsOrder = lhs.order ?? Int.max
        let rhsOrder = rhs.order ?? Int.max
        if lhsOrder != rhsOrder { return lhsOrder < rhsOrder }
        return lhs.id < rhs.id
    }
}

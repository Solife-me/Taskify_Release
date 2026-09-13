import Foundation

/// A flat timeline lets lazy containers materialize individual cards, including on crowded days.
public enum BoardUpcomingRow: Identifiable, Equatable, Sendable {
    case header(Date)
    case event(Date, TaskifyEvent)
    case task(Date, TaskItem)

    public enum ID: Hashable, Sendable {
        case header(Date)
        case event(Date, String)
        case task(Date, String)
    }

    public var id: ID {
        switch self {
        case .header(let date): .header(date)
        case .event(let date, let event): .event(date, event.id)
        case .task(let date, let task): .task(date, task.id)
        }
    }

    public static func rows(from groups: [BoardUpcomingGroup]) -> [BoardUpcomingRow] {
        groups.flatMap { group in
            [.header(group.date)]
                + group.events.map { .event(group.date, $0) }
                + group.tasks.map { .task(group.date, $0) }
        }
    }
}

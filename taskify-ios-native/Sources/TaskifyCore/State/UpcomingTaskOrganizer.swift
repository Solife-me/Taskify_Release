import Foundation

public enum UpcomingSortMode: String, Codable, CaseIterable, Sendable {
    case manual
    case dueDate
    case priority
    case createdAt
    case title

    public var label: String {
        switch self {
        case .manual: "Manual"
        case .dueDate: "Due Date"
        case .priority: "Priority"
        case .createdAt: "Creation Date"
        case .title: "A–Z"
        }
    }

    public var defaultDirection: UpcomingSortDirection {
        switch self {
        case .manual, .dueDate, .title: .ascending
        case .priority, .createdAt: .descending
        }
    }

    public var supportsDirection: Bool { self != .manual }
}

public enum UpcomingSortDirection: String, Codable, CaseIterable, Sendable {
    case ascending
    case descending
}

public enum UpcomingBoardGrouping: String, Codable, CaseIterable, Sendable {
    case mixed
    case grouped

    public var label: String {
        switch self {
        case .mixed: "Across boards"
        case .grouped: "Group by board"
        }
    }
}

public enum UpcomingTaskOrganizer {
    public static func taskCountsByDay(
        _ tasks: [TaskItem],
        calendar: Calendar = .current
    ) -> [Date: Int] {
        tasks.reduce(into: [:]) { counts, task in
            guard !task.isDeleted,
                  !task.completed,
                  task.dueDateEnabled,
                  let dueDate = task.dueDate else { return }
            counts[calendar.startOfDay(for: dueDate), default: 0] += 1
        }
    }

    public static func filter(
        _ tasks: [TaskItem],
        searchText: String,
        includedBoardIDs: Set<String>?,
        selectedDate: Date?,
        calendar: Calendar = .current
    ) -> [TaskItem] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return tasks.filter { task in
            guard !task.isDeleted,
                  !task.completed,
                  task.dueDateEnabled,
                  let dueDate = task.dueDate else { return false }
            if let includedBoardIDs, !includedBoardIDs.contains(task.boardID) {
                return false
            }
            if let selectedDate, !calendar.isDate(dueDate, inSameDayAs: selectedDate) {
                return false
            }
            guard !query.isEmpty else { return true }
            return task.title.localizedCaseInsensitiveContains(query) ||
                task.note.localizedCaseInsensitiveContains(query)
        }
    }

    public static func sort(
        _ tasks: [TaskItem],
        mode: UpcomingSortMode,
        direction: UpcomingSortDirection,
        boardGrouping: UpcomingBoardGrouping,
        boardOrder: [String]
    ) -> [TaskItem] {
        let boardRanks = Dictionary(
            uniqueKeysWithValues: boardOrder.enumerated().map { ($0.element, $0.offset) }
        )
        let fallbackRank = boardOrder.count

        func boardComparison(_ lhs: TaskItem, _ rhs: TaskItem) -> Int {
            let lhsRank = boardRanks[lhs.boardID] ?? fallbackRank
            let rhsRank = boardRanks[rhs.boardID] ?? fallbackRank
            if lhsRank != rhsRank { return lhsRank < rhsRank ? -1 : 1 }
            return 0
        }

        func directed(_ comparison: Int, _ requestedDirection: UpcomingSortDirection) -> Int {
            requestedDirection == .ascending ? comparison : -comparison
        }

        func dueComparison(
            _ lhs: TaskItem,
            _ rhs: TaskItem,
            _ requestedDirection: UpcomingSortDirection
        ) -> Int {
            if lhs.dueTimeEnabled != rhs.dueTimeEnabled {
                return lhs.dueTimeEnabled ? -1 : 1
            }
            guard lhs.dueTimeEnabled,
                  let lhsDueDate = lhs.dueDate,
                  let rhsDueDate = rhs.dueDate,
                  lhsDueDate != rhsDueDate else { return 0 }
            return directed(lhsDueDate < rhsDueDate ? -1 : 1, requestedDirection)
        }

        func priorityComparison(_ lhs: TaskItem, _ rhs: TaskItem) -> Int {
            let lhsValue = lhs.priority?.rawValue ?? 0
            let rhsValue = rhs.priority?.rawValue ?? 0
            guard lhsValue != rhsValue else { return 0 }
            return directed(lhsValue < rhsValue ? -1 : 1, direction)
        }

        func creationComparison(_ lhs: TaskItem, _ rhs: TaskItem) -> Int {
            guard lhs.createdAt != rhs.createdAt else { return 0 }
            return directed(lhs.createdAt < rhs.createdAt ? -1 : 1, direction)
        }

        func titleComparison(
            _ lhs: TaskItem,
            _ rhs: TaskItem,
            _ requestedDirection: UpcomingSortDirection
        ) -> Int {
            let result = lhs.title.localizedCaseInsensitiveCompare(rhs.title)
            guard result != .orderedSame else { return 0 }
            let comparison = result == .orderedAscending ? -1 : 1
            return directed(comparison, requestedDirection)
        }

        func fallbackComparison(_ lhs: TaskItem, _ rhs: TaskItem) -> Int {
            var result = dueComparison(lhs, rhs, .ascending)
            if result != 0 { return result }
            result = boardComparison(lhs, rhs)
            if result != 0 { return result }
            if lhs.order != rhs.order { return lhs.order < rhs.order ? -1 : 1 }
            result = titleComparison(lhs, rhs, .ascending)
            if result != 0 { return result }
            return lhs.id < rhs.id ? -1 : (lhs.id == rhs.id ? 0 : 1)
        }

        return tasks.sorted { lhs, rhs in
            if boardGrouping == .grouped || mode == .manual {
                let comparison = boardComparison(lhs, rhs)
                if comparison != 0 { return comparison < 0 }
            }

            let primary: Int
            switch mode {
            case .manual:
                primary = lhs.order == rhs.order ? 0 : (lhs.order < rhs.order ? -1 : 1)
            case .dueDate:
                primary = dueComparison(lhs, rhs, direction)
            case .priority:
                primary = priorityComparison(lhs, rhs)
            case .createdAt:
                primary = creationComparison(lhs, rhs)
            case .title:
                primary = titleComparison(lhs, rhs, direction)
            }
            if primary != 0 { return primary < 0 }
            return fallbackComparison(lhs, rhs) < 0
        }
    }

    /// Sorts tasks for a single board column: incomplete tasks first (ordered by `mode`),
    /// then completed tasks (ordered the same way), mirroring the PWA's `sortBoardTasks`.
    public static func sortBoardTasks(
        _ tasks: [TaskItem],
        mode: UpcomingSortMode,
        direction: UpcomingSortDirection
    ) -> [TaskItem] {
        let incomplete = tasks.filter { !$0.completed }
        let completed = tasks.filter(\.completed)
        func ordered(_ items: [TaskItem]) -> [TaskItem] {
            sort(items, mode: mode, direction: direction, boardGrouping: .mixed, boardOrder: [])
        }
        return ordered(incomplete) + ordered(completed)
    }
}

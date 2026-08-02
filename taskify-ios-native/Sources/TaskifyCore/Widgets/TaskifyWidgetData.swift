import Foundation

/// A single task as a widget shows it: enough to render a row and act on it, and nothing else.
public struct TaskifyWidgetTask: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let boardID: String
    public let boardName: String
    public let dueDate: Date?
    public let isOverdue: Bool

    public init(
        id: String,
        title: String,
        boardID: String,
        boardName: String,
        dueDate: Date?,
        isOverdue: Bool
    ) {
        self.id = id
        self.title = title
        self.boardID = boardID
        self.boardName = boardName
        self.dueDate = dueDate
        self.isOverdue = isOverdue
    }
}

public struct TaskifyWidgetBoard: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let openTaskCount: Int

    public init(id: String, name: String, openTaskCount: Int) {
        self.id = id
        self.name = name
        self.openTaskCount = openTaskCount
    }
}

/// Everything the widgets render, derived from a `TaskifySnapshot`.
///
/// Kept deliberately small and free of app types: a widget process decodes this, draws it, and
/// nothing more. Timelines are cheap to build and the payload stays well inside the memory a
/// widget extension is allowed.
public struct TaskifyWidgetData: Codable, Equatable, Sendable {
    public var today: [TaskifyWidgetTask]
    public var overdue: [TaskifyWidgetTask]
    public var boards: [TaskifyWidgetBoard]
    public var generatedAt: Date

    public init(
        today: [TaskifyWidgetTask] = [],
        overdue: [TaskifyWidgetTask] = [],
        boards: [TaskifyWidgetBoard] = [],
        generatedAt: Date = Date()
    ) {
        self.today = today
        self.overdue = overdue
        self.boards = boards
        self.generatedAt = generatedAt
    }

    /// What the Lock Screen "next task" widget shows: whatever is most pressing right now.
    /// Overdue work outranks anything merely due today.
    public var nextTask: TaskifyWidgetTask? {
        overdue.first ?? today.first
    }

    /// The count those small accessory slots show -- overdue included, since ignoring it would
    /// under-report what's actually outstanding.
    public var remainingCount: Int {
        today.count + overdue.count
    }

    public var isEmpty: Bool { today.isEmpty && overdue.isEmpty }
}

extension TaskifySnapshot {
    /// Builds the widget payload for a moment in time.
    ///
    /// "Today" matches what the Upcoming view shows for today rather than being defined afresh:
    /// both start from `upcomingTasks(from:)`, so a task can't appear in one and not the other.
    /// Anything due before today is split out as overdue -- Upcoming folds those into today's
    /// group, but a widget has room for only a handful of rows and burying overdue work among
    /// today's is how it gets missed.
    public func widgetData(
        now: Date = Date(),
        calendar: Calendar = .current,
        limit: Int = 12
    ) -> TaskifyWidgetData {
        let startOfToday = calendar.startOfDay(for: now)
        let endOfToday = calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday

        let boardNames = Dictionary(uniqueKeysWithValues: boards.map { ($0.id, $0.name) })

        func item(_ task: TaskItem, overdue: Bool) -> TaskifyWidgetTask {
            TaskifyWidgetTask(
                id: task.id,
                title: task.title,
                boardID: task.boardID,
                boardName: boardNames[task.boardID] ?? "",
                dueDate: task.dueDate,
                isOverdue: overdue
            )
        }

        let live = tasks.filter { !$0.isDeleted && !$0.completed && $0.dueDateEnabled && $0.dueDate != nil }
            .sorted {
                guard let lhs = $0.dueDate, let rhs = $1.dueDate else { return $0.createdAt < $1.createdAt }
                if lhs != rhs { return lhs < rhs }
                return $0.createdAt < $1.createdAt
            }

        let overdue = live
            .filter { ($0.dueDate ?? startOfToday) < startOfToday }
            .prefix(limit)
            .map { item($0, overdue: true) }

        let today = live
            .filter { task in
                guard let due = task.dueDate else { return false }
                return due >= startOfToday && due < endOfToday
            }
            .prefix(limit)
            .map { item($0, overdue: false) }

        let openCounts = tasks.reduce(into: [String: Int]()) { counts, task in
            guard !task.isDeleted, !task.completed else { return }
            counts[task.boardID, default: 0] += 1
        }

        let boardSummaries = visibleBoards
            .filter { $0.kind == .week || $0.kind == .list }
            .map { TaskifyWidgetBoard(id: $0.id, name: $0.name, openTaskCount: openCounts[$0.id] ?? 0) }

        return TaskifyWidgetData(
            today: Array(today),
            overdue: Array(overdue),
            boards: boardSummaries,
            generatedAt: now
        )
    }
}

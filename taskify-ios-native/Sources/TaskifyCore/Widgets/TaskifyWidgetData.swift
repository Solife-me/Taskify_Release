import Foundation

/// A single task as a widget shows it: enough to render a row and act on it, and nothing else.
public struct TaskifyWidgetTask: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let boardID: String
    public let boardName: String
    public let dueDate: Date?

    public init(
        id: String,
        title: String,
        boardID: String,
        boardName: String,
        dueDate: Date?
    ) {
        self.id = id
        self.title = title
        self.boardID = boardID
        self.boardName = boardName
        self.dueDate = dueDate
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
    /// Due today. The Today widget shows these and counts them.
    public var today: [TaskifyWidgetTask]
    /// Due today or later, earliest first. The Upcoming widget shows these and deliberately does
    /// not count them -- a running total of everything ahead of you isn't a number that means much.
    public var upcoming: [TaskifyWidgetTask]
    public var boards: [TaskifyWidgetBoard]
    public var generatedAt: Date

    public init(
        today: [TaskifyWidgetTask] = [],
        upcoming: [TaskifyWidgetTask] = [],
        boards: [TaskifyWidgetBoard] = [],
        generatedAt: Date = Date()
    ) {
        self.today = today
        self.upcoming = upcoming
        self.boards = boards
        self.generatedAt = generatedAt
    }

    /// The Lock Screen shows one thing, and the most useful one is whatever is next -- which may
    /// be later this week if today is clear.
    public var nextTask: TaskifyWidgetTask? { upcoming.first }

    /// Today's workload. Counts tasks only, and structurally cannot do otherwise: `widgetData`
    /// reads `tasks` alone, while Taskify events live in `taskifyEvents` and Apple Calendar items
    /// are never in the snapshot at all.
    public var todayCount: Int { today.count }

    public var isEmpty: Bool { today.isEmpty && upcoming.isEmpty }
}

extension TaskifySnapshot {
    /// Builds the widget payload for a moment in time.
    ///
    /// "Today" means exactly what Upcoming's today group means: tasks due today, and nothing else.
    /// An earlier version also surfaced overdue work, which read well in isolation but produced a
    /// count the app could not account for -- Upcoming filters to `dueDate >= startOfToday`, so it
    /// never shows overdue anywhere. Because week-board tasks are all created with a due date,
    /// unfinished ones pile up indefinitely, and the widget was reporting a dozen-odd "due" tasks
    /// against an Upcoming view showing nothing at all. A widget that disagrees with the app is
    /// worse than one that shows less.
    public func widgetData(
        now: Date = Date(),
        calendar: Calendar = .current,
        limit: Int = 12
    ) -> TaskifyWidgetData {
        let startOfToday = calendar.startOfDay(for: now)
        let endOfToday = calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday

        let boardNames = Dictionary(uniqueKeysWithValues: boards.map { ($0.id, $0.name) })

        func item(_ task: TaskItem) -> TaskifyWidgetTask {
            TaskifyWidgetTask(
                id: task.id,
                title: task.title,
                boardID: task.boardID,
                boardName: boardNames[task.boardID] ?? "",
                dueDate: task.dueDate
            )
        }

        let live = tasks.filter { !$0.isDeleted && !$0.completed && $0.dueDateEnabled && $0.dueDate != nil }
            .sorted {
                guard let lhs = $0.dueDate, let rhs = $1.dueDate else { return $0.createdAt < $1.createdAt }
                if lhs != rhs { return lhs < rhs }
                return $0.createdAt < $1.createdAt
            }

        let today = live
            .filter { task in
                guard let due = task.dueDate else { return false }
                return due >= startOfToday && due < endOfToday
            }
            .prefix(limit)
            .map(item)

        // Everything from today onward, matching Upcoming's own `dueDate >= startOfToday` filter.
        let upcoming = live
            .filter { ($0.dueDate ?? startOfToday) >= startOfToday }
            .prefix(limit)
            .map(item)

        let openCounts = tasks.reduce(into: [String: Int]()) { counts, task in
            guard !task.isDeleted, !task.completed else { return }
            counts[task.boardID, default: 0] += 1
        }

        let boardSummaries = visibleBoards
            .filter { $0.kind == .week || $0.kind == .list }
            .map { TaskifyWidgetBoard(id: $0.id, name: $0.name, openTaskCount: openCounts[$0.id] ?? 0) }

        return TaskifyWidgetData(
            today: Array(today),
            upcoming: Array(upcoming),
            boards: boardSummaries,
            generatedAt: now
        )
    }
}

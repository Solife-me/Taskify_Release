import Foundation

/// What kind of thing a row is. Only tasks can be completed from a widget or counted as work due
/// today; the rest are context.
public enum TaskifyWidgetItemKind: String, Codable, Equatable, Sendable {
    case task
    case event
    case calendar
    case reminder

    public var symbolName: String {
        switch self {
        case .task: "circle"
        case .event: "calendar"
        case .calendar: "calendar.badge.clock"
        case .reminder: "bell"
        }
    }

    public var isCompletable: Bool { self == .task }
}

/// A single row as a widget shows it: enough to render and act on, and nothing else.
public struct TaskifyWidgetTask: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let boardID: String
    public let boardName: String
    public let dueDate: Date?
    public var kind: TaskifyWidgetItemKind

    public init(
        id: String,
        title: String,
        boardID: String,
        boardName: String,
        dueDate: Date?,
        kind: TaskifyWidgetItemKind = .task
    ) {
        self.id = id
        self.title = title
        self.boardID = boardID
        self.boardName = boardName
        self.dueDate = dueDate
        self.kind = kind
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
        // Taskify events sit alongside tasks here because Upcoming lists them together -- but they
        // are never counted as tasks due today, which is what `today` is for.
        let upcomingTasks = live
            .filter { ($0.dueDate ?? startOfToday) >= startOfToday }
            .map(item)

        let upcomingEvents = (taskifyEvents ?? [])
            .filter { event in
                guard !event.isDeleted, let start = event.startDate else { return false }
                return start >= startOfToday
            }
            .map { event in
                TaskifyWidgetTask(
                    id: event.id,
                    title: event.title,
                    boardID: event.boardID ?? "",
                    boardName: event.boardID.flatMap { boardNames[$0] } ?? "",
                    dueDate: event.startDate,
                    kind: .event
                )
            }

        let upcoming = (upcomingTasks + upcomingEvents)
            .sorted { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }
            .prefix(limit)

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

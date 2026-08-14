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
    /// The end of a calendar-style item. Tasks and reminders generally leave this empty.
    public let endDate: Date?
    /// Distinguishes a date-only item from one that happens to start at midnight.
    public let isAllDay: Bool
    public var kind: TaskifyWidgetItemKind

    public init(
        id: String,
        title: String,
        boardID: String,
        boardName: String,
        dueDate: Date?,
        endDate: Date? = nil,
        isAllDay: Bool = false,
        kind: TaskifyWidgetItemKind = .task
    ) {
        self.id = id
        self.title = title
        self.boardID = boardID
        self.boardName = boardName
        self.dueDate = dueDate
        self.endDate = endDate
        self.isAllDay = isAllDay
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

/// The portion of a board a configurable Board widget should show.
public enum TaskifyWidgetBoardScope: Equatable, Sendable {
    case all
    case today
    case column(String)
}

/// A filtered board snapshot for the configurable Board widget. `itemCount` describes the whole
/// selected scope, while `items` is capped to the number of rows the widget can render. The stored
/// property is still named `tasks` for source compatibility with the first Board-widget release;
/// it now carries both tasks and Taskify events.
public struct TaskifyBoardWidgetData: Equatable, Sendable {
    public let board: TaskifyWidgetBoard
    public let scopeName: String
    public let destinationColumnID: String?
    public let itemCount: Int
    public let tasks: [TaskifyWidgetTask]

    public var items: [TaskifyWidgetTask] { tasks }

    public init(
        board: TaskifyWidgetBoard,
        scopeName: String,
        destinationColumnID: String?,
        itemCount: Int? = nil,
        tasks: [TaskifyWidgetTask]
    ) {
        self.board = board
        self.scopeName = scopeName
        self.destinationColumnID = destinationColumnID
        self.itemCount = itemCount ?? tasks.count
        self.tasks = tasks
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

public extension Array where Element == TaskifyWidgetTask {
    /// Returns the next agenda rows a finite-size Upcoming widget can actually render.
    ///
    /// All-day items remain relevant for their whole date. Timed tasks disappear once their due
    /// time passes, while an event that has already started remains visible until its end. The
    /// result is chronological across every date -- it does not let "today" consume the widget by
    /// filtering future days out, nor does it artificially limit the result to one item per day.
    func upcomingWidgetItems(
        after now: Date,
        calendar: Calendar = .current,
        limit: Int
    ) -> [TaskifyWidgetTask] {
        guard limit > 0 else { return [] }
        let startOfToday = calendar.startOfDay(for: now)
        return filter { item in
            guard let start = item.dueDate else { return false }
            if item.isAllDay {
                return start >= startOfToday
            }
            if item.kind == .event || item.kind == .calendar,
               let end = item.endDate {
                return end > now
            }
            return start >= now
        }
        .enumerated()
        .sorted { lhs, rhs in
            let lhsDate = lhs.element.dueDate ?? .distantFuture
            let rhsDate = rhs.element.dueDate ?? .distantFuture
            return lhsDate == rhsDate ? lhs.offset < rhs.offset : lhsDate < rhsDate
        }
        .prefix(limit)
        .map(\.element)
    }
}

extension TaskifySnapshot {
    /// Builds the selected slice of a board without making WidgetKit understand the complete app
    /// model. Completed, deleted, hidden, and expired work never appears. An "All" scope includes
    /// the selected board's current and upcoming Taskify tasks/events; Today and column scopes
    /// retain their narrower meaning.
    public func boardWidgetData(
        boardID: String?,
        scope: TaskifyWidgetBoardScope,
        now: Date = Date(),
        calendar: Calendar = .current,
        limit: Int = 8
    ) -> TaskifyBoardWidgetData? {
        let supportedBoards = visibleBoards.filter { $0.kind == .week || $0.kind == .list }
        guard let board = boardID.flatMap({ id in supportedBoards.first { $0.id == id } })
                ?? supportedBoards.first else { return nil }

        let normalizedScope: TaskifyWidgetBoardScope
        let scopeName: String
        let destinationColumnID: String?
        switch (board.kind, scope) {
        case (.week, .all):
            normalizedScope = .all
            scopeName = "All"
            destinationColumnID = WeekdayColumn.containing(now, calendar: calendar).rawValue
        case (.week, _):
            normalizedScope = .today
            scopeName = "Today"
            destinationColumnID = WeekdayColumn.containing(now, calendar: calendar).rawValue
        case (.list, .column(let columnID)):
            if let column = board.columns.first(where: { $0.id == columnID }) {
                normalizedScope = .column(column.id)
                scopeName = column.name
                destinationColumnID = column.id
            } else {
                normalizedScope = .all
                scopeName = "All"
                destinationColumnID = board.columns.sorted(by: boardColumnOrder).first?.id
            }
        case (.list, _):
            normalizedScope = .all
            scopeName = "All"
            destinationColumnID = board.columns.sorted(by: boardColumnOrder).first?.id
        default:
            return nil
        }

        let liveTasks = tasks.filter { task in
            guard task.boardID == board.id,
                  !task.isDeleted,
                  !task.completed,
                  task.hiddenUntilDate.map({ $0 <= now }) ?? true else { return false }
            switch normalizedScope {
            case .all:
                return true
            case .today:
                guard task.dueDateEnabled, let dueDate = task.dueDate else { return false }
                return calendar.isDate(dueDate, inSameDayAs: now)
            case .column(let columnID):
                return task.columnID == columnID
            }
        }

        let sortedTasks = liveTasks.sorted { lhs, rhs in
            if board.kind == .week,
               case .all = normalizedScope,
               lhs.dueDate != rhs.dueDate {
                return (lhs.dueDate ?? .distantFuture) < (rhs.dueDate ?? .distantFuture)
            }
            if lhs.order != rhs.order { return lhs.order < rhs.order }
            return lhs.createdAt < rhs.createdAt
        }

        let startOfToday = calendar.startOfDay(for: now)
        let liveEvents = (taskifyEvents ?? []).filter { event in
            guard event.boardID == board.id,
                  !event.isDeleted,
                  let start = event.startDate else { return false }

            switch normalizedScope {
            case .today:
                return event.occurs(on: now, calendar: calendar)
            case .column(let columnID):
                guard event.columnID == columnID else { return false }
            case .all:
                break
            }

            if event.isAllDay {
                let lastDay = calendar.startOfDay(for: max(start, event.endDate ?? start))
                return lastDay >= startOfToday
            }
            return (event.endDate ?? start) >= now
        }
        .sorted { lhs, rhs in
            if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
            let lhsStart = lhs.startDate ?? .distantFuture
            let rhsStart = rhs.startDate ?? .distantFuture
            if lhsStart != rhsStart { return lhsStart < rhsStart }
            let lhsOrder = lhs.order ?? Int.max
            let rhsOrder = rhs.order ?? Int.max
            if lhsOrder != rhsOrder { return lhsOrder < rhsOrder }
            return lhs.id < rhs.id
        }

        let boardName = board.name
        let taskRows = sortedTasks.map { task in
            TaskifyWidgetTask(
                id: task.id,
                title: task.title,
                boardID: task.boardID,
                boardName: boardName,
                dueDate: task.dueDate,
                isAllDay: !task.dueTimeEnabled
            )
        }
        let eventRows = liveEvents.map { event in
            TaskifyWidgetTask(
                id: event.id,
                title: event.title,
                boardID: board.id,
                boardName: boardName,
                dueDate: event.startDate,
                endDate: event.endDate,
                isAllDay: event.isAllDay,
                kind: .event
            )
        }

        let combined: [TaskifyWidgetTask]
        if board.kind == .week, case .all = normalizedScope {
            combined = (taskRows + eventRows).enumerated().sorted { lhs, rhs in
                let lhsDate = lhs.element.dueDate ?? .distantFuture
                let rhsDate = rhs.element.dueDate ?? .distantFuture
                if lhsDate != rhsDate { return lhsDate < rhsDate }
                if lhs.element.kind != rhs.element.kind { return lhs.element.kind == .event }
                return lhs.offset < rhs.offset
            }.map(\.element)
        } else {
            // Board columns render Taskify events ahead of tasks, so the widget follows the same
            // familiar ordering rather than inventing a second board layout.
            combined = eventRows + taskRows
        }
        let rows = combined.prefix(max(0, limit))

        return TaskifyBoardWidgetData(
            board: TaskifyWidgetBoard(id: board.id, name: board.name, openTaskCount: liveTasks.count),
            scopeName: scopeName,
            destinationColumnID: destinationColumnID,
            itemCount: liveTasks.count + liveEvents.count,
            tasks: Array(rows)
        )
    }

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
                dueDate: task.dueDate,
                isAllDay: !task.dueTimeEnabled
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
                    endDate: event.endDate,
                    isAllDay: event.isAllDay,
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

private func boardColumnOrder(_ lhs: BoardColumn, _ rhs: BoardColumn) -> Bool {
    if lhs.order != rhs.order { return lhs.order < rhs.order }
    return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
}

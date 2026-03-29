import Foundation

public struct BoardTaskItem: Equatable, Identifiable {
    public let id: String
    public let title: String
    public let completed: Bool
    public let dueISO: String?
    public let createdAt: Int?
    public let columnId: String?
    // Rich metadata for card display & editing
    public var note: String?
    public var priority: Int?
    public var dueDateEnabled: Bool?
    public var dueTimeEnabled: Bool?
    public var dueTimeZone: String?
    public var subtasksJSON: String?
    public var recurrenceJSON: String?
    public var assigneesJSON: String?
    public var streak: Int?
    public var boardId: String?
    public var boardName: String?
    public var order: Int?

    public init(
        id: String,
        title: String,
        completed: Bool,
        dueISO: String? = nil,
        createdAt: Int? = nil,
        columnId: String? = nil,
        note: String? = nil,
        priority: Int? = nil,
        dueDateEnabled: Bool? = nil,
        dueTimeEnabled: Bool? = nil,
        dueTimeZone: String? = nil,
        subtasksJSON: String? = nil,
        recurrenceJSON: String? = nil,
        assigneesJSON: String? = nil,
        streak: Int? = nil,
        boardId: String? = nil,
        boardName: String? = nil,
        order: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.completed = completed
        self.dueISO = dueISO
        self.createdAt = createdAt
        self.columnId = columnId
        self.note = note
        self.priority = priority
        self.dueDateEnabled = dueDateEnabled
        self.dueTimeEnabled = dueTimeEnabled
        self.dueTimeZone = dueTimeZone
        self.subtasksJSON = subtasksJSON
        self.recurrenceJSON = recurrenceJSON
        self.assigneesJSON = assigneesJSON
        self.streak = streak
        self.boardId = boardId
        self.boardName = boardName
        self.order = order
    }

    /// Create from a SwiftData TaskifyTask model.
    public static func from(_ task: TaskifyTask) -> BoardTaskItem {
        BoardTaskItem(
            id: task.id,
            title: task.title,
            completed: task.completed,
            dueISO: task.dueISO,
            createdAt: task.createdAt,
            columnId: task.column,
            note: task.note,
            priority: task.priority,
            dueDateEnabled: task.dueDateEnabled,
            dueTimeEnabled: task.dueTimeEnabled,
            dueTimeZone: task.dueTimeZone,
            subtasksJSON: task.subtasksJSON,
            recurrenceJSON: task.recurrenceJSON,
            assigneesJSON: task.assigneesJSON,
            streak: task.streak,
            boardId: task.boardId,
            boardName: task.boardName
        )
    }
}

public enum BoardDetailState: Equatable {
    case loading
    case empty
    case ready
    case error(String)
}

public struct WeekBoardDay: Equatable, Identifiable {
    public let weekday: Int
    public let label: String
    public let date: Date
    public let isToday: Bool
    public let tasks: [BoardTaskItem]

    public var id: Int { weekday }

    public init(weekday: Int, label: String, date: Date, isToday: Bool, tasks: [BoardTaskItem]) {
        self.weekday = weekday
        self.label = label
        self.date = date
        self.isToday = isToday
        self.tasks = tasks
    }
}

@MainActor
public final class BoardDetailViewModel: ObservableObject {
    @Published public private(set) var state: BoardDetailState = .empty
    @Published public private(set) var selectedBoardId: String?
    @Published public private(set) var visibleTasks: [BoardTaskItem] = []
    @Published public var sortMode: TaskSortMode = .manual
    @Published public var sortAscending: Bool = true

    private var tasksByBoard: [String: [BoardTaskItem]] = [:]

    public init() {}

    public func setSelectedBoard(id: String?) {
        selectedBoardId = id
        guard let id else {
            visibleTasks = []
            state = .empty
            return
        }
        let tasks = tasksByBoard[id] ?? []
        visibleTasks = sortTasks(tasks)
        state = tasks.isEmpty ? .empty : .ready
    }

    public func setTasks(for boardId: String, tasks: [BoardTaskItem]) {
        tasksByBoard[boardId] = tasks
        guard boardId == selectedBoardId else { return }
        visibleTasks = sortTasks(tasks)
        state = tasks.isEmpty ? .empty : .ready
    }

    public func setLoading() {
        state = .loading
    }

    public func setError(_ message: String) {
        state = .error(message)
    }

    @discardableResult
    public func clearCompletedForSelectedBoard() -> Int {
        guard let id = selectedBoardId else { return 0 }
        let existing = tasksByBoard[id] ?? []
        let filtered = existing.filter { !$0.completed }
        let removed = max(0, existing.count - filtered.count)
        tasksByBoard[id] = filtered
        visibleTasks = filtered
        state = filtered.isEmpty ? .empty : .ready
        return removed
    }

    public func upcomingTasks() -> [BoardTaskItem] {
        visibleTasks.filter { !$0.completed && $0.dueISO != nil }
    }

    public func weekBoardDays(
        weekStart: Int,
        includeCompleted: Bool,
        referenceDate: Date = Date()
    ) -> [WeekBoardDay] {
        let normalizedWeekStart = Self.normalizedWeekStart(weekStart)
        let orderedWeekdays = (0..<7).map { (normalizedWeekStart + $0) % 7 }
        let todayWeekday = Self.localWeekday(for: referenceDate)
        var tasksByWeekday = Dictionary(uniqueKeysWithValues: orderedWeekdays.map { ($0, [BoardTaskItem]()) })

        for task in visibleTasks {
            if !includeCompleted && task.completed {
                continue
            }

            guard task.dueDateEnabled != false,
                  let weekday = Self.weekday(from: task.dueISO, timeZoneId: task.dueTimeZone) else {
                continue
            }

            tasksByWeekday[weekday, default: []].append(task)
        }

        return orderedWeekdays.map { weekday in
            let date = Self.dateForWeekday(weekday, base: referenceDate, weekStart: normalizedWeekStart)
            return WeekBoardDay(
                weekday: weekday,
                label: Self.shortWeekdayLabel(for: weekday),
                date: date,
                isToday: weekday == todayWeekday,
                tasks: tasksByWeekday[weekday] ?? []
            )
        }
    }

    public static func isoForWeekday(
        _ target: Int,
        base: Date = Date(),
        weekStart: Int = 0
    ) -> String {
        let normalizedTarget = ((target % 7) + 7) % 7
        let normalizedWeekStart = normalizedWeekStart(weekStart)
        let anchor = startOfWeekLocal(base, weekStart: normalizedWeekStart)
        let anchorWeekday = localWeekday(for: anchor)
        let offset = ((normalizedTarget - anchorWeekday) % 7 + 7) % 7
        let date = Calendar.current.date(byAdding: .day, value: offset, to: anchor) ?? anchor
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Calendar.current.startOfDay(for: date))
    }

    public var emptyMessage: String {
        "No tasks yet for this board."
    }

    // MARK: - Sorting

    /// Apply sort mode and direction, updating visible tasks.
    public func applySort(mode: TaskSortMode, ascending: Bool) {
        sortMode = mode
        sortAscending = ascending
        resortVisibleTasks()
    }

    private func resortVisibleTasks() {
        guard let id = selectedBoardId, let tasks = tasksByBoard[id] else { return }
        visibleTasks = sortTasks(tasks)
    }

    private func sortTasks(_ tasks: [BoardTaskItem]) -> [BoardTaskItem] {
        guard sortMode != .manual else { return tasks }

        let sorted = tasks.sorted { a, b in
            let result: Bool
            switch sortMode {
            case .manual:
                return false
            case .dueDate:
                result = compareDueDates(a.dueISO, b.dueISO)
            case .priority:
                let pA = a.priority ?? 0
                let pB = b.priority ?? 0
                result = pA > pB  // Higher priority first by default
            case .createdAt:
                result = (a.order ?? 0) > (b.order ?? 0)
            case .alphabetical:
                result = a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
            return sortAscending ? result : !result
        }
        return sorted
    }

    private func compareDueDates(_ a: String?, _ b: String?) -> Bool {
        let dateA = parseISO(a)
        let dateB = parseISO(b)
        switch (dateA, dateB) {
        case (.some(let da), .some(let db)): return da < db
        case (.some, .none): return true   // items with dates before items without
        case (.none, .some): return false
        case (.none, .none): return false
        }
    }

    private func parseISO(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    private static func shortWeekdayLabel(for weekday: Int) -> String {
        let labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return labels[((weekday % 7) + 7) % 7]
    }

    private static func normalizedWeekStart(_ weekStart: Int) -> Int {
        let normalized = ((weekStart % 7) + 7) % 7
        switch normalized {
        case 1, 6:
            return normalized
        default:
            return 0
        }
    }

    private static func startOfWeekLocal(_ date: Date, weekStart: Int) -> Date {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: date)
        let current = localWeekday(for: startOfDay)
        var diff = current - weekStart
        if diff < 0 {
            diff += 7
        }
        return calendar.date(byAdding: .day, value: -diff, to: startOfDay) ?? startOfDay
    }

    private static func dateForWeekday(_ weekday: Int, base: Date, weekStart: Int) -> Date {
        let anchor = startOfWeekLocal(base, weekStart: weekStart)
        let anchorWeekday = localWeekday(for: anchor)
        let offset = ((weekday - anchorWeekday) % 7 + 7) % 7
        return Calendar.current.date(byAdding: .day, value: offset, to: anchor) ?? anchor
    }

    private static func localWeekday(for date: Date) -> Int {
        Calendar.current.component(.weekday, from: date) - 1
    }

    private static func weekday(from iso: String?, timeZoneId: String?) -> Int? {
        guard let iso,
              !iso.isEmpty,
              let date = parseISOStatic(iso) else {
            return nil
        }

        var calendar = Calendar.current
        if let timeZoneId,
           let timeZone = TimeZone(identifier: timeZoneId) {
            calendar.timeZone = timeZone
        }
        return calendar.component(.weekday, from: date) - 1
    }

    private static func parseISOStatic(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    // MARK: - CRUD operations

    /// Toggle completion on a task by ID.
    @discardableResult
    public func toggleComplete(taskId: String) -> Bool {
        guard let boardId = selectedBoardId,
              var tasks = tasksByBoard[boardId],
              let idx = tasks.firstIndex(where: { $0.id == taskId }) else { return false }
        let old = tasks[idx]
        tasks[idx] = BoardTaskItem(
            id: old.id, title: old.title, completed: !old.completed,
            dueISO: old.dueISO, createdAt: old.createdAt, columnId: old.columnId,
            note: old.note, priority: old.priority,
            dueDateEnabled: old.dueDateEnabled, dueTimeEnabled: old.dueTimeEnabled,
            dueTimeZone: old.dueTimeZone, subtasksJSON: old.subtasksJSON,
            recurrenceJSON: old.recurrenceJSON, assigneesJSON: old.assigneesJSON,
            streak: old.streak, boardId: old.boardId, boardName: old.boardName,
            order: old.order
        )
        tasksByBoard[boardId] = tasks
        visibleTasks = tasks
        return true
    }

    /// Add a new task to the top of the currently selected board.
    @discardableResult
    public func addTask(_ item: BoardTaskItem) -> Bool {
        guard let boardId = selectedBoardId else { return false }
        var tasks = tasksByBoard[boardId] ?? []
        tasks.insert(item, at: 0)
        tasksByBoard[boardId] = tasks
        visibleTasks = sortTasks(tasks)
        state = .ready
        return true
    }

    /// Add a new task to the bottom of the currently selected board.
    @discardableResult
    public func addTaskAtEnd(_ item: BoardTaskItem) -> Bool {
        guard let boardId = selectedBoardId else { return false }
        var tasks = tasksByBoard[boardId] ?? []
        tasks.append(item)
        tasksByBoard[boardId] = tasks
        visibleTasks = sortTasks(tasks)
        state = .ready
        return true
    }

    /// Update an existing task by replacing the item with matching ID.
    @discardableResult
    public func updateTask(_ item: BoardTaskItem) -> Bool {
        guard let boardId = selectedBoardId,
              var tasks = tasksByBoard[boardId],
              let idx = tasks.firstIndex(where: { $0.id == item.id }) else { return false }
        tasks[idx] = item
        tasksByBoard[boardId] = tasks
        visibleTasks = tasks
        return true
    }

    /// Delete a task by ID from the currently selected board.
    @discardableResult
    public func deleteTask(taskId: String) -> Bool {
        guard let boardId = selectedBoardId,
              var tasks = tasksByBoard[boardId] else { return false }
        tasks.removeAll { $0.id == taskId }
        tasksByBoard[boardId] = tasks
        visibleTasks = tasks
        state = tasks.isEmpty ? .empty : .ready
        return true
    }
}

@MainActor
public enum BoardDetailFixture {
    public static func empty(boardId: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setTasks(for: boardId, tasks: [])
        return vm
    }

    public static func loading(boardId: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setLoading()
        return vm
    }

    public static func error(boardId: String, message: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setError(message)
        return vm
    }

    public static func sample(boardId: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setTasks(for: boardId, tasks: [
            .init(id: "t1", title: "Draft roadmap", completed: false),
            .init(id: "t2", title: "Review PRs", completed: false),
            .init(id: "t3", title: "Ship TestFlight build", completed: true),
        ])
        return vm
    }
}

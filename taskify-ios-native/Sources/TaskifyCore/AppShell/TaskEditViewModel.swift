import Foundation

// MARK: - Recurrence helpers (mirrors taskify-core Recurrence union)

public enum RecurrenceType: String, CaseIterable, Identifiable {
    case none
    case daily
    case weekly
    case every
    case monthlyDay

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .none: return "Never"
        case .daily: return "Daily"
        case .weekly: return "Weekly"
        case .every: return "Custom interval"
        case .monthlyDay: return "Monthly"
        }
    }
}

public struct RecurrenceRule: Equatable {
    public var type: RecurrenceType = .none
    public var days: Set<Int> = []         // 0=Sun … 6=Sat (for weekly)
    public var interval: Int = 1           // for "every" type
    public var unit: String = "day"        // "hour"|"day"|"week" (for "every" type)
    public var monthDay: Int = 1           // for monthlyDay
    public var monthInterval: Int = 1      // for monthlyDay
    public var untilISO: String?

    public init() {}

    public var isActive: Bool { type != .none }

    public var displayLabel: String {
        switch type {
        case .none: return "Never"
        case .daily: return "Daily"
        case .weekly:
            let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            let selected = days.sorted().compactMap { $0 < 7 ? dayNames[$0] : nil }
            return selected.isEmpty ? "Weekly" : "Weekly (\(selected.joined(separator: ", ")))"
        case .every:
            return "Every \(interval) \(unit)\(interval > 1 ? "s" : "")"
        case .monthlyDay:
            return "Monthly (day \(monthDay))"
        }
    }

    // MARK: - JSON round-trip (matches PWA Recurrence shape)

    public func toJSON() -> [String: Any]? {
        guard type != .none else { return nil }
        var dict: [String: Any] = ["type": type.rawValue]
        if let until = untilISO { dict["untilISO"] = until }
        switch type {
        case .none: return nil
        case .daily: break
        case .weekly: dict["days"] = days.sorted()
        case .every:
            dict["n"] = interval
            dict["unit"] = unit
        case .monthlyDay:
            dict["day"] = monthDay
            if monthInterval > 1 { dict["interval"] = monthInterval }
        }
        return dict
    }

    public static func from(json: [String: Any]) -> RecurrenceRule {
        var rule = RecurrenceRule()
        guard let typeStr = json["type"] as? String,
              let type = RecurrenceType(rawValue: typeStr) else { return rule }
        rule.type = type
        rule.untilISO = json["untilISO"] as? String
        switch type {
        case .none: break
        case .daily: break
        case .weekly:
            if let arr = json["days"] as? [Int] { rule.days = Set(arr) }
        case .every:
            rule.interval = json["n"] as? Int ?? 1
            rule.unit = json["unit"] as? String ?? "day"
        case .monthlyDay:
            rule.monthDay = json["day"] as? Int ?? 1
            rule.monthInterval = json["interval"] as? Int ?? 1
        }
        return rule
    }

    public static func from(jsonString: String?) -> RecurrenceRule {
        guard let str = jsonString,
              let data = str.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return RecurrenceRule() }
        return from(json: obj)
    }
}

// MARK: - Editable subtask

public struct EditableSubtask: Identifiable, Equatable {
    public var id: String
    public var title: String
    public var completed: Bool

    public init(id: String = UUID().uuidString, title: String = "", completed: Bool = false) {
        self.id = id
        self.title = title
        self.completed = completed
    }
}

// MARK: - Priority

public enum TaskPriority: Int, CaseIterable, Identifiable {
    case none = 0
    case low = 1
    case medium = 2
    case high = 3

    public var id: Int { rawValue }

    public var label: String {
        switch self {
        case .none: return "None"
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        }
    }

    public var marks: String {
        switch self {
        case .none: return ""
        case .low: return "!"
        case .medium: return "!!"
        case .high: return "!!!"
        }
    }

    public var symbolName: String {
        switch self {
        case .none: return "minus"
        case .low: return "exclamationmark"
        case .medium: return "exclamationmark.2"
        case .high: return "exclamationmark.3"
        }
    }
}

// MARK: - Board/column target

public struct TaskLocation: Equatable {
    public var boardId: String
    public var boardName: String
    public var columnId: String?
    public var columnName: String?

    public init(boardId: String, boardName: String, columnId: String? = nil, columnName: String? = nil) {
        self.boardId = boardId
        self.boardName = boardName
        self.columnId = columnId
        self.columnName = columnName
    }
}

// MARK: - TaskEditViewModel

@MainActor
public final class TaskEditViewModel: ObservableObject {

    public enum Mode: Equatable {
        case create
        case edit(taskId: String)
    }

    // Identity
    public let mode: Mode
    public private(set) var originalTaskId: String?

    // Fields
    @Published public var title: String = ""
    @Published public var note: String = ""
    @Published public var priority: TaskPriority = .none

    // Date & Time
    @Published public var dueDateEnabled: Bool = false
    @Published public var dueDate: Date = Date()
    @Published public var dueTimeEnabled: Bool = false
    @Published public var dueTime: Date = Date()
    @Published public var dueTimeZone: String = TimeZone.current.identifier

    // Recurrence
    @Published public var recurrence: RecurrenceRule = RecurrenceRule()

    // Subtasks
    @Published public var subtasks: [EditableSubtask] = []

    // Location
    @Published public var location: TaskLocation

    // State
    @Published public var isSaving: Bool = false
    @Published public var saveError: String?

    // Available boards/columns for location picker
    @Published public var availableBoards: [TaskLocation] = []
    @Published public var availableColumns: [BoardColumn] = []

    // Callbacks
    public var onSave: ((TaskEditViewModel) -> Void)?
    public var onDelete: ((String) -> Void)?

    public init(mode: Mode, location: TaskLocation) {
        self.mode = mode
        self.location = location
    }

    // MARK: - Populate from existing task

    public func populate(from task: BoardTaskItem, subtasksJSON: String? = nil, recurrenceJSON: String? = nil, noteText: String? = nil, priorityInt: Int? = nil, dueDateEnabledFlag: Bool? = nil, dueTimeEnabledFlag: Bool? = nil, dueTimeZoneStr: String? = nil) {
        originalTaskId = task.id
        title = task.title

        if let n = noteText { note = n }
        if let p = priorityInt, let tp = TaskPriority(rawValue: p) { priority = tp }

        if let enabled = dueDateEnabledFlag { dueDateEnabled = enabled }
        if let enabled = dueTimeEnabledFlag { dueTimeEnabled = enabled }
        if let tz = dueTimeZoneStr { dueTimeZone = tz }

        // Parse due date from ISO
        if let iso = task.dueISO, !iso.isEmpty {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) {
                dueDate = date
                dueTime = date
                if !dueDateEnabled { dueDateEnabled = true }
            }
        }

        // Parse subtasks
        if let json = subtasksJSON, let data = json.data(using: .utf8),
           let arr = try? JSONDecoder().decode([Subtask].self, from: data) {
            subtasks = arr.map { EditableSubtask(id: $0.id, title: $0.title, completed: $0.completed) }
        }

        // Parse recurrence
        recurrence = RecurrenceRule.from(jsonString: recurrenceJSON)
    }

    // MARK: - Subtask operations

    public func addSubtask(title: String) {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        subtasks.append(EditableSubtask(title: title))
    }

    public func removeSubtask(id: String) {
        subtasks.removeAll { $0.id == id }
    }

    public func toggleSubtask(id: String) {
        guard let idx = subtasks.firstIndex(where: { $0.id == id }) else { return }
        subtasks[idx].completed.toggle()
    }

    public func moveSubtask(fromOffsets: IndexSet, toOffset: Int) {
        let moving = fromOffsets.map { subtasks[$0] }
        subtasks.removeAll { item in fromOffsets.contains(subtasks.firstIndex(where: { $0.id == item.id }) ?? -1) }
        let insertAt = min(toOffset, subtasks.count)
        subtasks.insert(contentsOf: moving, at: insertAt)
    }

    // MARK: - Build output

    public var isValid: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Builds the ISO date string from the date/time pickers.
    public var computedDueISO: String? {
        guard dueDateEnabled else { return nil }
        let cal = Calendar.current
        var components = cal.dateComponents([.year, .month, .day], from: dueDate)
        if dueTimeEnabled {
            let timeComponents = cal.dateComponents([.hour, .minute], from: dueTime)
            components.hour = timeComponents.hour
            components.minute = timeComponents.minute
        } else {
            components.hour = 0
            components.minute = 0
        }
        components.second = 0
        if let tz = TimeZone(identifier: dueTimeZone) {
            components.timeZone = tz
        }
        guard let date = cal.date(from: components) else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    public var subtasksJSONString: String? {
        guard !subtasks.isEmpty else { return nil }
        let arr = subtasks.map { ["id": $0.id, "title": $0.title, "completed": $0.completed] as [String: Any] }
        guard let data = try? JSONSerialization.data(withJSONObject: arr) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public var recurrenceJSONString: String? {
        guard let dict = recurrence.toJSON(),
              let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save() {
        guard isValid else { return }
        isSaving = true
        onSave?(self)
        isSaving = false
    }

    public func requestDelete() {
        guard case .edit(let taskId) = mode else { return }
        onDelete?(taskId)
    }

    // MARK: - Convenience: create pre-populated for editing

    public static func forEdit(task: BoardTaskItem, location: TaskLocation) -> TaskEditViewModel {
        let vm = TaskEditViewModel(mode: .edit(taskId: task.id), location: location)
        vm.populate(from: task)
        return vm
    }

    public static func forCreate(location: TaskLocation) -> TaskEditViewModel {
        TaskEditViewModel(mode: .create, location: location)
    }
}

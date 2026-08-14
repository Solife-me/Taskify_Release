import Foundation

public enum TaskPayloadValue: Codable, Hashable, Sendable {
    case string(String)
    case integer(Int64)
    case number(Double)
    case boolean(Bool)
    case object([String: TaskPayloadValue])
    case array([TaskPayloadValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: TaskPayloadValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([TaskPayloadValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value in a Taskify task payload."
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .integer(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .boolean(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

public enum TaskPriority: Int, Codable, CaseIterable, Sendable {
    case low = 1
    case medium = 2
    case high = 3
}

public struct TaskSubtask: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var completed: Bool

    public init(
        id: String = UUID().uuidString,
        title: String,
        completed: Bool = false
    ) {
        self.id = id
        self.title = title
        self.completed = completed
    }
}

public struct TaskItem: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var boardID: String
    public var title: String
    public var note: String
    public var dueDate: Date?
    public var dueDateEnabled: Bool
    public var dueTimeEnabled: Bool
    public var dueTimeZone: String?
    public var priority: TaskPriority?
    public var images: [String]?
    public var documents: [TaskDocument]?
    public var subtasks: [TaskSubtask]?
    public var recurrence: TaskRecurrence?
    public var seriesID: String?
    public var scriptureMemoryID: String?
    public var scriptureMemoryStage: Int?
    public var scriptureMemoryPreviousReviewISO: String?
    public var scriptureMemoryScheduledAtISO: String?
    public var reminders: [TaskReminder]?
    public var reminderTime: String?
    public var hiddenUntilDate: Date?
    public var createdAt: Date
    public var order: Int
    public var columnID: String?
    public var completed: Bool
    public var completedAt: Date?
    public var createdBy: String?
    public var lastEditedBy: String?
    public var nostrUpdatedAt: Int?
    public var deleted: Bool?
    public var preservedSyncFields: [String: TaskPayloadValue]?
    public var streak: Int?
    public var longestStreak: Int?

    public init(
        id: String = UUID().uuidString,
        boardID: String,
        title: String,
        note: String = "",
        dueDate: Date? = nil,
        dueDateEnabled: Bool = false,
        dueTimeEnabled: Bool = false,
        dueTimeZone: String? = nil,
        priority: TaskPriority? = nil,
        images: [String]? = nil,
        documents: [TaskDocument]? = nil,
        subtasks: [TaskSubtask]? = nil,
        recurrence: TaskRecurrence? = nil,
        seriesID: String? = nil,
        scriptureMemoryID: String? = nil,
        scriptureMemoryStage: Int? = nil,
        scriptureMemoryPreviousReviewISO: String? = nil,
        scriptureMemoryScheduledAtISO: String? = nil,
        reminders: [TaskReminder]? = nil,
        reminderTime: String? = nil,
        hiddenUntilDate: Date? = nil,
        createdAt: Date = Date(),
        order: Int = 0,
        columnID: String? = nil,
        completed: Bool = false,
        completedAt: Date? = nil,
        createdBy: String? = nil,
        lastEditedBy: String? = nil,
        nostrUpdatedAt: Int? = nil,
        deleted: Bool? = nil,
        preservedSyncFields: [String: TaskPayloadValue]? = nil,
        streak: Int? = nil,
        longestStreak: Int? = nil
    ) {
        self.id = id
        self.boardID = boardID
        self.title = title
        self.note = note
        self.dueDate = dueDate
        self.dueDateEnabled = dueDateEnabled
        self.dueTimeEnabled = dueTimeEnabled
        self.dueTimeZone = dueTimeZone
        self.priority = priority
        self.images = images
        self.documents = documents
        self.subtasks = subtasks
        self.recurrence = recurrence
        self.seriesID = seriesID
        self.scriptureMemoryID = scriptureMemoryID
        self.scriptureMemoryStage = scriptureMemoryStage
        self.scriptureMemoryPreviousReviewISO = scriptureMemoryPreviousReviewISO
        self.scriptureMemoryScheduledAtISO = scriptureMemoryScheduledAtISO
        self.reminders = reminders
        self.reminderTime = reminderTime
        self.hiddenUntilDate = hiddenUntilDate
        self.createdAt = createdAt
        self.order = order
        self.columnID = columnID
        self.completed = completed
        self.completedAt = completedAt
        self.createdBy = createdBy
        self.lastEditedBy = lastEditedBy
        self.nostrUpdatedAt = nostrUpdatedAt
        self.deleted = deleted
        self.preservedSyncFields = preservedSyncFields
        self.streak = streak
        self.longestStreak = longestStreak
    }


    public var isDeleted: Bool { deleted == true }
}

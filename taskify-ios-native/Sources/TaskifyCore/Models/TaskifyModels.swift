import Foundation
import SwiftData

// MARK: - Task Types

public enum TaskPriority: Int, Codable {
    case low = 1
    case medium = 2
    case high = 3
}

public enum RecurrenceType: String, Codable {
    case none
    case daily
    case weekly
    case every
    case monthlyDay
}

public struct RecurrenceRule: Codable {
    public let type: RecurrenceType
    public let unit: String? // "day" or "week" or "hour"
    public let n: Int?
    public let days: [Int]? // Days of week for weekly (0-6, where 0 is Sunday)
    public let day: Int? // Day of month (1-28)
    public let interval: Int?
    public let untilISO: String?

    public init(
        type: RecurrenceType,
        unit: String? = nil,
        n: Int? = nil,
        days: [Int]? = nil,
        day: Int? = nil,
        interval: Int? = nil,
        untilISO: String? = nil
    ) {
        self.type = type
        self.unit = unit
        self.n = n
        self.days = days
        self.day = day
        self.interval = interval
        self.untilISO = untilISO
    }
}

public struct Bounty: Codable {
    public let owner: String // hex
    public let sender: String // hex
    public let receiver: String // hex
    public let token: String
    public let enc: String?
    public let state: String // "locked" | "unlocked" | "claimed" | "revoked"
    public let lock: String? // "none" | "p2pk" | "unknown"

    public init(
        owner: String,
        sender: String,
        receiver: String,
        token: String,
        enc: String? = nil,
        state: String = "locked",
        lock: String? = "unknown"
    ) {
        self.owner = owner
        self.sender = sender
        self.receiver = receiver
        self.token = token
        self.enc = enc
        self.state = state
        self.lock = lock
    }
}

public struct Task: Identifiable, Codable, Hashable {
    public let id: String
    public let boardId: String
    public let title: String
    public let note: String?
    public let dueISO: String
    public let dueDateEnabled: Bool?
    public let dueTimeEnabled: Bool?
    public let dueTimeZone: String?
    public let priority: TaskPriority?
    public let createdAt: Int
    public let order: Int
    public let column: String?
    public let completed: Bool
    public let completedAt: String?
    public let hiddenUntilISO: String?
    public let recurrence: RecurrenceRule?
    public let seriesId: String?
    public let streak: Int?
    public let longestStreak: Int?
    public let bounty: Bounty?
    public let bountyDeletedAt: String?
    public let bountyLists: [String]?
    public let reminders: [String]?
    public let reminderTime: String?

    public init(
        id: String,
        boardId: String,
        title: String,
        note: String? = nil,
        dueISO: String = "",
        dueDateEnabled: Bool? = nil,
        dueTimeEnabled: Bool? = nil,
        dueTimeZone: String? = nil,
        priority: TaskPriority? = nil,
        createdAt: Int = Int(Date().timeIntervalSince1970),
        order: Int = 0,
        column: String? = nil,
        completed: Bool = false,
        completedAt: String? = nil,
        hiddenUntilISO: String? = nil,
        recurrence: RecurrenceRule? = nil,
        seriesId: String? = nil,
        streak: Int? = nil,
        longestStreak: Int? = nil,
        bounty: Bounty? = nil,
        bountyDeletedAt: String? = nil,
        bountyLists: [String]? = nil,
        reminders: [String]? = nil,
        reminderTime: String? = nil
    ) {
        self.id = id
        self.boardId = boardId
        self.title = title
        self.note = note
        self.dueISO = dueISO
        self.dueDateEnabled = dueDateEnabled
        self.dueTimeEnabled = dueTimeEnabled
        self.dueTimeZone = dueTimeZone
        self.priority = priority
        self.createdAt = createdAt
        self.order = order
        self.column = column
        self.completed = completed
        self.completedAt = completedAt
        self.hiddenUntilISO = hiddenUntilISO
        self.recurrence = recurrence
        self.seriesId = seriesId
        self.streak = streak
        self.longestStreak = longestStreak
        self.bounty = bounty
        self.bountyDeletedAt = bountyDeletedAt
        self.bountyLists = bountyLists
        self.reminders = reminders
        self.reminderTime = reminderTime
    }
}
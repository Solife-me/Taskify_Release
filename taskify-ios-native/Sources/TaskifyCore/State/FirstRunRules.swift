import Foundation

/// Whether to ask the user to save their key (C9-5), ported from the PWA's
/// `onboarding/firstRunRules.ts`: only for a key "Start using Taskify" made on this device, once
/// the user has something to lose (three tasks, or a day), until they save it; "Not now" waits
/// three days.
public struct KeyBackupState: Codable, Equatable, Sendable {
    public static let taskThreshold = 3
    public static let ageThreshold: TimeInterval = 24 * 3600
    public static let snoozeInterval: TimeInterval = 3 * 24 * 3600

    /// When "Start using Taskify" made the key here. Nil for a key the user brought.
    public var createdHereAt: Date?
    /// When the user copied the key.
    public var savedAt: Date?
    public var snoozedUntil: Date?

    public init(createdHereAt: Date? = nil, savedAt: Date? = nil, snoozedUntil: Date? = nil) {
        self.createdHereAt = createdHereAt
        self.savedAt = savedAt
        self.snoozedUntil = snoozedUntil
    }

    /// Made here and not yet copied: Settings shows it as an unsaved key.
    public var isUnsaved: Bool { createdHereAt != nil && savedAt == nil }

    public func isPromptDue(now: Date, taskCount: Int) -> Bool {
        guard isUnsaved, let createdHereAt else { return false }
        if let snoozedUntil, now < snoozedUntil { return false }
        return taskCount >= Self.taskThreshold || now.timeIntervalSince(createdHereAt) >= Self.ageThreshold
    }

    public mutating func snooze(now: Date) {
        snoozedUntil = now.addingTimeInterval(Self.snoozeInterval)
    }
}

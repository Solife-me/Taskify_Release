import Foundation

public enum TaskRecurrenceUnit: String, Codable, CaseIterable, Sendable {
    case hour
    case day
    case week
}

public enum TaskRecurrence: Hashable, Sendable {
    case none(until: Date? = nil)
    case daily(until: Date? = nil)
    case weekly(days: [Int], until: Date? = nil)
    case every(Int, TaskRecurrenceUnit, until: Date? = nil)
    case monthlyDay(day: Int, interval: Int? = nil, until: Date? = nil)

    public var untilDate: Date? {
        switch self {
        case .none(let until), .daily(let until), .weekly(_, let until),
             .every(_, _, let until), .monthlyDay(_, _, let until):
            until
        }
    }

    public var isActive: Bool {
        switch self {
        case .none:
            false
        case .weekly(let days, _):
            days.contains { (0...6).contains($0) }
        case .daily, .every, .monthlyDay:
            true
        }
    }

    public var revealsOnDueDate: Bool {
        switch self {
        case .daily, .weekly:
            true
        case .every(_, let unit, _):
            unit == .day || unit == .week
        case .none, .monthlyDay:
            false
        }
    }

    public func withUntilDate(_ date: Date?) -> TaskRecurrence {
        switch self {
        case .none: .none(until: date)
        case .daily: .daily(until: date)
        case .weekly(let days, _): .weekly(days: days, until: date)
        case .every(let count, let unit, _): .every(count, unit, until: date)
        case .monthlyDay(let day, let interval, _): .monthlyDay(day: day, interval: interval, until: date)
        }
    }

    public func nextOccurrence(
        after current: Date,
        dueTimeEnabled: Bool,
        timeZoneIdentifier: String?,
        calendar baseCalendar: Calendar = .current
    ) -> Date? {
        guard isActive else { return nil }
        let timeZone = timeZoneIdentifier.flatMap(TimeZone.init(identifier:)) ?? baseCalendar.timeZone
        var calendar = baseCalendar
        calendar.timeZone = timeZone

        let next: Date?
        switch self {
        case .none:
            next = nil
        case .daily:
            next = calendar.date(byAdding: .day, value: 1, to: current)
        case .weekly(let days, _):
            let validDays = Set(days.filter { (0...6).contains($0) })
            next = (1...28).lazy.compactMap { offset in
                calendar.date(byAdding: .day, value: offset, to: current)
            }.first { candidate in
                validDays.contains(calendar.component(.weekday, from: candidate) - 1)
            }
        case .every(let rawCount, let unit, _):
            let count = max(1, rawCount)
            switch unit {
            case .hour:
                next = current.addingTimeInterval(TimeInterval(count * 3_600))
            case .day:
                next = calendar.date(byAdding: .day, value: count, to: current)
            case .week:
                next = calendar.date(byAdding: .day, value: count * 7, to: current)
            }
        case .monthlyDay(let rawDay, let rawInterval, _):
            let interval = max(1, rawInterval ?? 1)
            guard let targetMonth = calendar.date(byAdding: .month, value: interval, to: current) else {
                return nil
            }
            var components = calendar.dateComponents([.year, .month], from: targetMonth)
            components.day = min(max(rawDay, 1), 28)
            if dueTimeEnabled {
                let time = calendar.dateComponents([.hour, .minute, .second], from: current)
                components.hour = time.hour
                components.minute = time.minute
                components.second = time.second
            }
            next = calendar.date(from: components)
        }

        guard let next else { return nil }
        if !dueTimeEnabled, case .every(_, .hour, _) = self {
            return isWithinLimit(next, calendar: calendar) ? next : nil
        }
        let normalized = dueTimeEnabled ? next : calendar.startOfDay(for: next)
        return isWithinLimit(normalized, calendar: calendar) ? normalized : nil
    }

    private func isWithinLimit(_ date: Date, calendar: Calendar) -> Bool {
        guard let untilDate else { return true }
        return calendar.startOfDay(for: date) <= calendar.startOfDay(for: untilDate)
    }
}

extension TaskRecurrence: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case days
        case n
        case unit
        case day
        case interval
        case untilISO
    }

    private enum Kind: String, Codable {
        case none
        case daily
        case weekly
        case every
        case monthlyDay
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decodeIfPresent(Kind.self, forKey: .type) ?? .none
        let until = Self.parseISO(try container.decodeIfPresent(String.self, forKey: .untilISO))
        switch kind {
        case .none:
            self = .none(until: until)
        case .daily:
            self = .daily(until: until)
        case .weekly:
            self = .weekly(
                days: try container.decodeIfPresent([Int].self, forKey: .days) ?? [],
                until: until
            )
        case .every:
            self = .every(
                max(1, try container.decodeIfPresent(Int.self, forKey: .n) ?? 1),
                try container.decodeIfPresent(TaskRecurrenceUnit.self, forKey: .unit) ?? .day,
                until: until
            )
        case .monthlyDay:
            self = .monthlyDay(
                day: min(max(try container.decodeIfPresent(Int.self, forKey: .day) ?? 1, 1), 28),
                interval: try container.decodeIfPresent(Int.self, forKey: .interval),
                until: until
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .none:
            try container.encode(Kind.none, forKey: .type)
        case .daily:
            try container.encode(Kind.daily, forKey: .type)
        case .weekly(let days, _):
            try container.encode(Kind.weekly, forKey: .type)
            try container.encode(Array(Set(days.filter { (0...6).contains($0) })).sorted(), forKey: .days)
        case .every(let count, let unit, _):
            try container.encode(Kind.every, forKey: .type)
            try container.encode(max(1, count), forKey: .n)
            try container.encode(unit, forKey: .unit)
        case .monthlyDay(let day, let interval, _):
            try container.encode(Kind.monthlyDay, forKey: .type)
            try container.encode(min(max(day, 1), 28), forKey: .day)
            if let interval { try container.encode(max(1, interval), forKey: .interval) }
        }
        if let untilDate {
            try container.encode(Self.formatISO(untilDate), forKey: .untilISO)
        }
    }

    private static func formatISO(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    private static func parseISO(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }
}

public struct TaskReminder: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
    public let rawValue: String

    public var id: String { rawValue }

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(minutesBefore: Int, dateOnly: Bool = false) {
        if minutesBefore == 0 {
            rawValue = dateOnly ? "0d" : "0h"
            return
        }
        switch minutesBefore {
        case 5: rawValue = "5m"
        case 15: rawValue = "15m"
        case 30: rawValue = "30m"
        case 60: rawValue = "1h"
        case 1_440: rawValue = "1d"
        case 10_080: rawValue = "1w"
        default: rawValue = "custom-\(minutesBefore)"
        }
    }

    public var minutesBefore: Int? {
        switch rawValue {
        case "0h", "0d": return 0
        case "5m": return 5
        case "15m": return 15
        case "30m": return 30
        case "1h": return 60
        case "1d": return 1_440
        case "1w": return 10_080
        default:
            guard rawValue.hasPrefix("custom-"),
                  let value = Int(rawValue.dropFirst("custom-".count)),
                  abs(value) <= 99_999_999 else { return nil }
            return value
        }
    }

    public var label: String {
        guard let minutesBefore else { return "Reminder" }
        if minutesBefore == 0 { return rawValue == "0h" ? "At due time" : "On the day" }
        let absolute = abs(minutesBefore)
        let direction = minutesBefore < 0 ? "after" : "before"
        if absolute % 1_440 == 0 {
            let days = absolute / 1_440
            return "\(days) day\(days == 1 ? "" : "s") \(direction)"
        }
        if absolute % 60 == 0 {
            let hours = absolute / 60
            return "\(hours) hour\(hours == 1 ? "" : "s") \(direction)"
        }
        return "\(absolute) minute\(absolute == 1 ? "" : "s") \(direction)"
    }

    public var eventLabel: String {
        switch rawValue {
        case "0h": "At start time"
        case "0d": "On the start date"
        default: label
        }
    }

    public static let timedPresets: [TaskReminder] = [
        TaskReminder(rawValue: "0h"),
        TaskReminder(rawValue: "5m"),
        TaskReminder(rawValue: "15m"),
        TaskReminder(rawValue: "30m"),
        TaskReminder(rawValue: "1h"),
        TaskReminder(rawValue: "1d"),
    ]

    public static let datePresets: [TaskReminder] = [
        TaskReminder(rawValue: "1w"),
        TaskReminder(rawValue: "1d"),
        TaskReminder(rawValue: "0d"),
    ]

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            self.init(rawValue: string)
        } else if let minutes = try? container.decode(Int.self) {
            self.init(minutesBefore: minutes, dateOnly: true)
        } else {
            self.init(rawValue: "")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public extension TaskItem {
    func reminderAnchor(calendar baseCalendar: Calendar = .current) -> Date? {
        guard dueDateEnabled, let dueDate else { return nil }
        if dueTimeEnabled { return dueDate }

        var calendar = baseCalendar
        if let dueTimeZone, let timeZone = TimeZone(identifier: dueTimeZone) {
            calendar.timeZone = timeZone
        }
        let parts = (reminderTime ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) }.map { min(max($0, 0), 23) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) }.map { min(max($0, 0), 59) } ?? 0
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: dueDate)
    }

    func reminderFireDates(calendar: Calendar = .current) -> [(TaskReminder, Date)] {
        guard let anchor = reminderAnchor(calendar: calendar) else { return [] }
        var seenMinutes = Set<Int>()
        return (reminders ?? []).compactMap { reminder in
            guard let minutes = reminder.minutesBefore else { return nil }
            guard seenMinutes.insert(minutes).inserted else { return nil }
            return (reminder, anchor.addingTimeInterval(TimeInterval(-minutes * 60)))
        }
    }
}

public extension TaskifyEvent {
    func reminderAnchor(calendar baseCalendar: Calendar = .current) -> Date? {
        guard let startDate else { return nil }
        if !isAllDay { return startDate }

        let calendar = baseCalendar
        let parts = (reminderTime ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) }.map { min(max($0, 0), 23) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) }.map { min(max($0, 0), 59) } ?? 0
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: startDate)
    }

    func reminderFireDates(calendar: Calendar = .current) -> [(TaskReminder, Date)] {
        guard let anchor = reminderAnchor(calendar: calendar) else { return [] }
        var seenMinutes = Set<Int>()
        return (reminders ?? []).compactMap { reminder in
            guard let minutes = reminder.minutesBefore, seenMinutes.insert(minutes).inserted else { return nil }
            return (reminder, anchor.addingTimeInterval(TimeInterval(-minutes * 60)))
        }
    }
}

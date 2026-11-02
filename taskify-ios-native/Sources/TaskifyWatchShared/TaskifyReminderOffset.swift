import Foundation

/// The reminder vocabulary stored in a task's `reminders` array: "0h" (at the due time), "0d" (on
/// the due date, at the task's reminder time), the presets "5m", "15m", "30m", "1h", "1d", "1w",
/// and "custom-N" for any other number of minutes before the due time.
///
/// It lives here rather than in TaskifyCore so the Watch, which links only this module, writes
/// exactly the strings the iPhone, Mac and PWA read. `TaskReminder` in TaskifyCore delegates to it.
public enum TaskifyReminderOffset {
    public static func rawValue(minutesBefore: Int, dateOnly: Bool) -> String {
        switch minutesBefore {
        case 0: dateOnly ? "0d" : "0h"
        case 5: "5m"
        case 15: "15m"
        case 30: "30m"
        case 60: "1h"
        case 1_440: "1d"
        case 10_080: "1w"
        default: "custom-\(minutesBefore)"
        }
    }

    public static func minutesBefore(rawValue: String) -> Int? {
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

    public static func label(rawValue: String) -> String {
        guard let minutesBefore = minutesBefore(rawValue: rawValue) else { return "Reminder" }
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

    /// The choices offered for a task with a due time, in the order the editors show them.
    public static let timedPresetRawValues = ["0h", "5m", "15m", "30m", "1h", "1d"]
    /// The choices offered for a task due on a date with no time.
    public static let datePresetRawValues = ["1w", "1d", "0d"]

    /// Rewrites raw values for a task that is (or is no longer) timed: "0h" and "0d" swap, and
    /// duplicates and unreadable values are dropped. Sorted soonest-to-due first, the order the
    /// iPhone saves them in.
    public static func normalized(_ rawValues: [String], dateOnly: Bool) -> [String] {
        var seen = Set<Int>()
        return rawValues
            .compactMap { minutesBefore(rawValue: $0) }
            .filter { seen.insert($0).inserted }
            .sorted()
            .map { rawValue(minutesBefore: $0, dateOnly: dateOnly) }
    }

    /// Reads a stored `reminders` array, which older payloads may hold as plain minute counts.
    public static func rawValues(fromPayloadValue value: Any?) -> [String] {
        guard let values = value as? [Any] else { return [] }
        return values.compactMap { element in
            if let string = element as? String { return string }
            if let minutes = element as? Int { return rawValue(minutesBefore: minutes, dateOnly: true) }
            return nil
        }
    }
}

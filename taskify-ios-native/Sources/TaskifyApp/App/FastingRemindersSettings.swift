import Foundation
import TaskifyCore

/// Local device settings for the Fasting Reminders feature, matching the PWA's
/// `fastingRemindersEnabled` / `fastingRemindersMode` / `fastingRemindersPerMonth` /
/// `fastingRemindersWeekday` / `fastingRemindersRandomSeed` settings fields.
enum FastingRemindersSettings {
    private static let enabledKey = "taskify.fastingReminders.enabled"
    private static let modeKey = "taskify.fastingReminders.mode"
    private static let perMonthKey = "taskify.fastingReminders.perMonth"
    private static let weekdayKey = "taskify.fastingReminders.weekday"
    private static let seedKey = "taskify.fastingReminders.seed"

    static var enabled: Bool {
        UserDefaults.standard.bool(forKey: enabledKey)
    }

    static var mode: FastingRemindersMode {
        UserDefaults.standard.string(forKey: modeKey) == "random" ? .random : .weekday
    }

    static var perMonth: Int {
        let stored = UserDefaults.standard.integer(forKey: perMonthKey)
        return stored > 0 ? stored : 4
    }

    /// 0 = Sunday ... 6 = Saturday, matching JS `Date.getDay()`.
    static var weekday: Int {
        guard let stored = UserDefaults.standard.object(forKey: weekdayKey) as? Int,
              stored >= 0, stored <= 6 else {
            return 1
        }
        return stored
    }

    static var seed: String {
        if let existing = UserDefaults.standard.string(forKey: seedKey), !existing.isEmpty {
            return existing
        }
        let generated = UUID().uuidString
        UserDefaults.standard.set(generated, forKey: seedKey)
        return generated
    }

    static func save(enabled: Bool, mode: FastingRemindersMode, perMonth: Int, weekday: Int) {
        let maxPerMonth = mode == .random ? 31 : 5
        UserDefaults.standard.set(enabled, forKey: enabledKey)
        UserDefaults.standard.set(mode == .random ? "random" : "weekday", forKey: modeKey)
        UserDefaults.standard.set(min(maxPerMonth, max(1, perMonth)), forKey: perMonthKey)
        UserDefaults.standard.set(min(6, max(0, weekday)), forKey: weekdayKey)
    }
}

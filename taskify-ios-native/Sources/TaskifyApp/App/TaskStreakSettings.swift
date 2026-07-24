import Foundation

/// Local device setting for whether completing a frequent recurring task (daily/weekly, or every
/// N days/weeks) increments a visible streak count, matching the PWA's `streaksEnabled` setting.
enum TaskStreakSettings {
    private static let enabledKey = "taskify.streaksEnabled"

    /// Defaults to on, matching the PWA.
    static var enabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    static func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: enabledKey)
    }
}

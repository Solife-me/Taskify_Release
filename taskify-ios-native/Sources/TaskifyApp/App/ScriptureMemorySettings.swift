import Foundation
import TaskifyCore

/// Local device settings for the Scripture Memory feature, matching the PWA's
/// `scriptureMemoryEnabled` / `scriptureMemoryBoardId` / `scriptureMemoryFrequency` settings.
/// The entries themselves (`ScriptureMemoryState`) are stored separately by `AppModel`.
enum ScriptureMemorySettings {
    private static let enabledKey = "taskify.scriptureMemory.enabled"
    private static let boardIDKey = "taskify.scriptureMemory.boardID"
    private static let frequencyKey = "taskify.scriptureMemory.frequency"
    private static let sortKey = "taskify.scriptureMemory.sort"

    static var enabled: Bool {
        UserDefaults.standard.bool(forKey: enabledKey)
    }

    static var boardID: String? {
        UserDefaults.standard.string(forKey: boardIDKey)
    }

    static var frequency: ScriptureMemoryFrequency {
        UserDefaults.standard.string(forKey: frequencyKey).flatMap(ScriptureMemoryFrequency.init(rawValue:)) ?? .daily
    }

    /// Defaults to needs-review, matching the PWA.
    static var sort: ScriptureMemorySort {
        UserDefaults.standard.string(forKey: sortKey).flatMap(ScriptureMemorySort.init(rawValue:)) ?? .needsReview
    }

    static func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: enabledKey)
    }

    static func setBoardID(_ boardID: String?) {
        UserDefaults.standard.set(boardID, forKey: boardIDKey)
    }

    static func setFrequency(_ frequency: ScriptureMemoryFrequency) {
        UserDefaults.standard.set(frequency.rawValue, forKey: frequencyKey)
    }

    static func setSort(_ sort: ScriptureMemorySort) {
        UserDefaults.standard.set(sort.rawValue, forKey: sortKey)
    }
}

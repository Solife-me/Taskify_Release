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

    /// The PWA's field names, as carried in the encrypted account sync.
    static let enabledPWAKey = "scriptureMemoryEnabled"
    static let boardIDPWAKey = "scriptureMemoryBoardId"
    static let frequencyPWAKey = "scriptureMemoryFrequency"

    static var enabled: Bool { enabled(defaults: .standard) }
    static func enabled(defaults: UserDefaults) -> Bool { defaults.bool(forKey: enabledKey) }

    static var boardID: String? { boardID(defaults: .standard) }
    static func boardID(defaults: UserDefaults) -> String? { defaults.string(forKey: boardIDKey) }

    static var frequency: ScriptureMemoryFrequency { frequency(defaults: .standard) }
    static func frequency(defaults: UserDefaults) -> ScriptureMemoryFrequency {
        defaults.string(forKey: frequencyKey).flatMap(ScriptureMemoryFrequency.init(rawValue:)) ?? .daily
    }

    /// Defaults to needs-review, matching the PWA.
    static var sort: ScriptureMemorySort { sort(defaults: .standard) }
    static func sort(defaults: UserDefaults) -> ScriptureMemorySort {
        defaults.string(forKey: sortKey).flatMap(ScriptureMemorySort.init(rawValue:)) ?? .needsReview
    }

    static func setEnabled(_ enabled: Bool, defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: enabledKey)
    }

    static func setBoardID(_ boardID: String?, defaults: UserDefaults = .standard) {
        defaults.set(boardID, forKey: boardIDKey)
    }

    static func setFrequency(_ frequency: ScriptureMemoryFrequency, defaults: UserDefaults = .standard) {
        defaults.set(frequency.rawValue, forKey: frequencyKey)
    }

    static func setSort(_ sort: ScriptureMemorySort, defaults: UserDefaults = .standard) {
        defaults.set(sort.rawValue, forKey: sortKey)
    }
}

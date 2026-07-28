import Foundation
import TaskifyCore

/// Local device setting for where a quick-added task lands within its column, matching the
/// PWA's `newTaskPosition` setting.
enum TaskOrderingSettings {
    private static let positionKey = "taskify.newTaskPosition"

    /// Defaults to top, matching the PWA.
    static var position: NewTaskPosition {
        UserDefaults.standard.string(forKey: positionKey).flatMap(NewTaskPosition.init(rawValue:)) ?? .top
    }

    static func setPosition(_ position: NewTaskPosition) {
        UserDefaults.standard.set(position.rawValue, forKey: positionKey)
    }
}

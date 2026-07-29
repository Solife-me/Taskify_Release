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

/// Local presentation preferences shared by Settings and the native board/task cards. These
/// mirror the PWA's `completedTab` and `hideCompletedSubtasks` settings while remaining
/// device-specific appearance choices rather than synced board/task data.
enum TaskPresentationSettings {
    static let completedTabKey = "taskify.view.completedTab"
    static let hideCompletedSubtasksKey = "taskify.view.hideCompletedSubtasks"

    static let completedTabDefault = true
    static let hideCompletedSubtasksDefault = false
}

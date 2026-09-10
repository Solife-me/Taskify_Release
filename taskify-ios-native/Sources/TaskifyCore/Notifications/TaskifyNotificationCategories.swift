#if canImport(UserNotifications)
import Foundation
import UserNotifications

/// The actionable notification categories Taskify registers with the system.
///
/// `setNotificationCategories` replaces the whole registered set, so the app and the Notification
/// Service Extension share this one definition: neither can register its own category without
/// also carrying the other's.
public enum TaskifyNotificationCategories {
    public static var all: Set<UNNotificationCategory> {
        [taskCategory, directMessageCategory]
    }

    static var taskCategory: UNNotificationCategory {
        let complete = UNNotificationAction(
            identifier: TaskifyNotificationContract.completeTaskActionIdentifier,
            title: "Mark Complete",
            options: []
        )
        return UNNotificationCategory(
            identifier: TaskifyNotificationContract.taskCategoryIdentifier,
            actions: [complete],
            intentIdentifiers: [],
            options: []
        )
    }

    /// Lets a decrypted message preview be answered from the expanded notification. Without the
    /// `.foreground` option iOS delivers the typed text to Taskify in the background, and without
    /// `.authenticationRequired` the reply can be sent from the Lock Screen.
    static var directMessageCategory: UNNotificationCategory {
        let reply = UNTextInputNotificationAction(
            identifier: TaskifyNotificationContract.replyDirectMessageActionIdentifier,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Message"
        )
        return UNNotificationCategory(
            identifier: TaskifyNotificationContract.directMessageCategoryIdentifier,
            actions: [reply],
            intentIdentifiers: [],
            options: []
        )
    }

    /// Registers the categories only when the system's set differs, then waits briefly until the
    /// system reports the new set.
    ///
    /// Apple documents calling `setNotificationCategories` once at launch. Every DM push also
    /// launches Taskify in the background, so registering unconditionally would replace the set
    /// while the extension's rewritten notification is being presented. The wait lets the extension
    /// attach a category that is actually registered, which matters on the first notification
    /// after an install or update, before the app itself has run.
    public static func registerIfNeeded(
        center: UNUserNotificationCenter = .current(),
        confirmationTimeout: Duration = .seconds(1)
    ) async {
        let desired = all
        let expected = signature(desired)
        guard signature(await center.notificationCategories()) != expected else { return }
        center.setNotificationCategories(desired)
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: confirmationTimeout)
        while clock.now < deadline,
              !Task.isCancelled,
              signature(await center.notificationCategories()) != expected {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// A content comparison for category sets. Registering is skipped only when every category,
    /// action, title, and option already matches.
    static func signature(_ categories: Set<UNNotificationCategory>) -> [String] {
        categories.map { category in
            let actions = category.actions.map { action in
                var parts = [action.identifier, action.title, String(action.options.rawValue)]
                if let input = action as? UNTextInputNotificationAction {
                    parts += [input.textInputButtonTitle, input.textInputPlaceholder]
                }
                return parts.joined(separator: "\u{1F}")
            }
            return ([category.identifier, String(category.options.rawValue)]
                + category.intentIdentifiers
                + actions).joined(separator: "\u{1E}")
        }
        .sorted()
    }
}
#endif

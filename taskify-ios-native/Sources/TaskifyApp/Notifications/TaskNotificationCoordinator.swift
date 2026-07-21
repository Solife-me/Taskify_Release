import Foundation
import TaskifyCore
import UserNotifications

actor TaskNotificationCoordinator {
    private static let identifierPrefix = "taskify.task."
    private let center: UNUserNotificationCenter
    private let presentationDelegate = NotificationPresentationDelegate()

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        center.delegate = presentationDelegate
    }

    func reschedule(
        tasks: [TaskItem],
        requestPermission: Bool,
        now: Date = Date()
    ) async -> String {
        var settings = await center.notificationSettings()
        if requestPermission, settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
            settings = await center.notificationSettings()
        }

        let pending = await center.pendingNotificationRequests()
        let existingIDs = pending
            .map(\.identifier)
            .filter { $0.hasPrefix(Self.identifierPrefix) }
        if !existingIDs.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: existingIDs)
        }

        guard Self.canSchedule(settings.authorizationStatus) else {
            return Self.label(for: settings.authorizationStatus)
        }

        let upcoming = tasks
            .filter { !$0.isDeleted && !$0.completed }
            .flatMap { task in
                task.reminderFireDates().compactMap { reminder, fireDate -> ScheduledReminder? in
                    guard fireDate > now.addingTimeInterval(1) else { return nil }
                    return ScheduledReminder(task: task, reminder: reminder, fireDate: fireDate)
                }
            }
            .sorted { $0.fireDate < $1.fireDate }
            .prefix(60)

        for scheduled in upcoming {
            guard !Task.isCancelled else { break }
            let content = UNMutableNotificationContent()
            content.title = scheduled.task.title
            content.body = scheduled.reminder.label
            content.sound = .default
            content.userInfo = [
                "taskID": scheduled.task.id,
                "boardID": scheduled.task.boardID,
            ]

            var components = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second],
                from: scheduled.fireDate
            )
            components.timeZone = Calendar.current.timeZone
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let identifier = Self.identifierPrefix
                + scheduled.task.id
                + "."
                + scheduled.reminder.rawValue
            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }
        return Self.label(for: settings.authorizationStatus)
    }

    private static func canSchedule(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: true
        case .notDetermined, .denied: false
        @unknown default: false
        }
    }

    private static func label(for status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: "Not requested"
        case .denied: "Disabled in iOS Settings"
        case .authorized: "Enabled"
        case .provisional: "Delivered quietly"
        case .ephemeral: "Temporarily enabled"
        @unknown default: "Unavailable"
        }
    }
}

private struct ScheduledReminder {
    let task: TaskItem
    let reminder: TaskReminder
    let fireDate: Date
}

private final class NotificationPresentationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

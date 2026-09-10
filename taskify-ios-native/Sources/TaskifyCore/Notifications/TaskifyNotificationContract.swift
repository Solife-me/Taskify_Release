import Foundation

/// Stable identifiers shared by Taskify's notification scheduler and response handler.
///
/// Keeping the parsing here makes notification actions deterministic and testable without asking
/// the app target's `UNUserNotificationCenterDelegate` to infer anything from display text.
public enum TaskifyNotificationContract {
    public static let taskCategoryIdentifier = "me.solife.taskify.notification.task"
    public static let completeTaskActionIdentifier = "me.solife.taskify.notification.complete-task"
    public static let taskIDKey = "taskID"
    public static let boardIDKey = "boardID"
    public static let destinationKey = "taskifyDestination"
    public static let directMessageCategoryIdentifier = "me.solife.taskify.notification.direct-message"
    public static let replyDirectMessageActionIdentifier = "me.solife.taskify.notification.reply-direct-message"
    /// Added by the Notification Service Extension after decryption. Like the destination, these
    /// stay on the device and are never sent through APNs or the push relay.
    public static let conversationIDKey = "taskifyConversationID"
    public static let conversationKindKey = "taskifyConversationKind"

    public enum Destination: String, Equatable, Sendable {
        case chat
        case wallet
    }

    /// Where an inline notification reply is sent. A group ID is a 64-character hash just like a
    /// public key, so the kind travels with the ID instead of being guessed from its value.
    public struct ReplyTarget: Equatable, Sendable {
        public let conversationID: String
        public let isGroup: Bool

        public init(conversationID: String, isGroup: Bool) {
            self.conversationID = conversationID.lowercased()
            self.isGroup = isGroup
        }

        public var userInfo: [String: String] {
            [
                TaskifyNotificationContract.conversationIDKey: conversationID,
                TaskifyNotificationContract.conversationKindKey: isGroup ? "group" : "direct",
            ]
        }
    }

    public enum Action: Equatable, Sendable {
        case completeTask(taskID: String)
        case reply(to: ReplyTarget, text: String)
    }

    /// `responseText` is the text the user typed into a text-input action, when there is one.
    public static func action(
        for identifier: String,
        userInfo: [String: String],
        responseText: String? = nil
    ) -> Action? {
        switch identifier {
        case completeTaskActionIdentifier:
            guard let taskID = userInfo[taskIDKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !taskID.isEmpty else { return nil }
            return .completeTask(taskID: taskID)
        case replyDirectMessageActionIdentifier:
            guard let conversationID = userInfo[conversationIDKey]?
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                  (try? Data(hex: conversationID))?.count == 32,
                  let kind = userInfo[conversationKindKey], kind == "group" || kind == "direct",
                  let text = responseText?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else { return nil }
            return .reply(
                to: ReplyTarget(conversationID: conversationID, isGroup: kind == "group"),
                text: text
            )
        default:
            return nil
        }
    }

    public static func destination(userInfo: [String: String]) -> Destination? {
        guard let value = userInfo[destinationKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return Destination(rawValue: value)
    }
}

/// Pure, platform-neutral rules for Taskify's device-local urgent alarms.
///
/// Alarm authorization and scheduling live in the iOS app target. Keeping identity and eligibility
/// rules in Core lets the scheduler, editor, and tests agree without publishing an Apple-specific
/// preference in the shared Nostr task payload.
public enum TaskifyUrgentAlarmContract {
    /// Chooses the first useful wall-clock time for a newly enabled urgent alarm.
    ///
    /// A future selected day starts at 9:00 AM in the requested time zone. For today (or a
    /// stale date in the past), 9:00 AM is used while it is still ahead; otherwise the alarm
    /// advances to the next whole hour. Calendar arithmetic keeps midnight and daylight-saving
    /// transitions valid for the selected zone.
    public static func defaultDueDate(
        for selectedDate: Date,
        now: Date = Date(),
        calendar baseCalendar: Calendar = .current,
        timeZone: TimeZone = .current
    ) -> Date {
        var calendar = baseCalendar
        calendar.timeZone = timeZone

        let today = calendar.startOfDay(for: now)
        let requestedDay = calendar.startOfDay(for: selectedDate)
        let effectiveDay = requestedDay < today ? today : requestedDay
        let nineAM = calendar.date(
            bySettingHour: 9,
            minute: 0,
            second: 0,
            of: effectiveDay
        ) ?? effectiveDay

        if effectiveDay > today || now < nineAM {
            return nineAM
        }

        let startOfCurrentHour = calendar.dateInterval(of: .hour, for: now)?.start ?? now
        return calendar.date(byAdding: .hour, value: 1, to: startOfCurrentHour)
            ?? now.addingTimeInterval(3_600)
    }

    public static func preferenceKey(for task: TaskItem) -> String {
        if task.recurrence?.isActive == true,
           let seriesID = task.seriesID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !seriesID.isEmpty {
            return "series:" + seriesID
        }
        return "task:" + task.id
    }

    public static func isEligible(_ task: TaskItem, now: Date = Date()) -> Bool {
        guard !task.isDeleted,
              !task.completed,
              task.dueDateEnabled,
              task.dueTimeEnabled,
              let dueDate = task.dueDate else { return false }
        return dueDate > now.addingTimeInterval(1)
    }
}

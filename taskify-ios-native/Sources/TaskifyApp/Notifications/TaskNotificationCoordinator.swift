import Foundation
import TaskifyCore
import UserNotifications
#if canImport(AlarmKit)
import AlarmKit
import CryptoKit
import SwiftUI
#endif

enum TaskUrgentAlarmPreferences {
    private static let enabledKeysDefaultsKey = "taskify.notifications.urgentAlarmKeys"
    private static let lock = NSLock()

    static func isEnabled(for task: TaskItem, defaults: UserDefaults = .standard) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return Set(defaults.stringArray(forKey: enabledKeysDefaultsKey) ?? [])
            .contains(TaskifyUrgentAlarmContract.preferenceKey(for: task))
    }

    static func setEnabled(
        _ enabled: Bool,
        for task: TaskItem,
        defaults: UserDefaults = .standard
    ) {
        lock.lock()
        defer { lock.unlock() }
        var keys = Set(defaults.stringArray(forKey: enabledKeysDefaultsKey) ?? [])
        let preferenceKey = TaskifyUrgentAlarmContract.preferenceKey(for: task)
        if enabled {
            keys.insert(preferenceKey)
            if preferenceKey.hasPrefix("series:") {
                keys.remove("task:" + task.id)
            }
        } else {
            keys.remove(preferenceKey)
            keys.remove("task:" + task.id)
        }
        defaults.set(keys.sorted(), forKey: enabledKeysDefaultsKey)
    }
}

actor TaskNotificationCoordinator {
    private static let taskIdentifierPrefix = "taskify.task."
    private static let eventIdentifierPrefix = "taskify.event."
    private static let managedAlarmIDsDefaultsKey = "taskify.notifications.managedAlarmIDs"
    private let center: UNUserNotificationCenter
    private let defaults: UserDefaults
    private let presentationDelegate = NotificationPresentationDelegate()

    init(
        center: UNUserNotificationCenter = .current(),
        defaults: UserDefaults = .standard
    ) {
        self.center = center
        self.defaults = defaults
        center.delegate = presentationDelegate
        center.setNotificationCategories([Self.taskCategory])
    }

    private static var taskCategory: UNNotificationCategory {
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

    func reschedule(
        tasks: [TaskItem],
        events: [TaskifyEvent] = [],
        requestPermission: Bool,
        now: Date = Date()
    ) async -> String {
        var settings = await center.notificationSettings()
        if requestPermission, settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
            settings = await center.notificationSettings()
        }

        let alarmedTaskIDs = await rescheduleUrgentAlarms(
            tasks: tasks,
            requestPermission: requestPermission,
            now: now
        )

        let pending = await center.pendingNotificationRequests()
        let existingIDs = pending
            .map(\.identifier)
            .filter {
                $0.hasPrefix(Self.taskIdentifierPrefix)
                    || $0.hasPrefix(Self.eventIdentifierPrefix)
            }
        if !existingIDs.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: existingIDs)
        }

        guard Self.canSchedule(settings.authorizationStatus) else {
            return Self.label(for: settings.authorizationStatus)
        }

        let taskReminders = tasks
            .filter { !$0.isDeleted && !$0.completed }
            .flatMap { task in
                task.reminderFireDates().compactMap { reminder, fireDate -> ScheduledReminder? in
                    guard fireDate > now.addingTimeInterval(1) else { return nil }
                    // A successfully scheduled urgent alarm replaces only the ordinary
                    // notification at the exact due time. Earlier reminder notifications remain.
                    guard !(alarmedTaskIDs.contains(task.id) && reminder.minutesBefore == 0) else {
                        return nil
                    }
                    return ScheduledReminder(
                        identifier: Self.taskIdentifierPrefix + task.id + "." + reminder.rawValue,
                        title: task.title,
                        body: reminder.label,
                        userInfo: [
                            TaskifyNotificationContract.taskIDKey: task.id,
                            TaskifyNotificationContract.boardIDKey: task.boardID,
                        ],
                        categoryIdentifier: TaskifyNotificationContract.taskCategoryIdentifier,
                        fireDate: fireDate
                    )
                }
            }
        let urgentFallbacks = tasks.compactMap { task -> ScheduledReminder? in
            guard TaskUrgentAlarmPreferences.isEnabled(for: task, defaults: defaults),
                  TaskifyUrgentAlarmContract.isEligible(task, now: now),
                  !alarmedTaskIDs.contains(task.id),
                  !(task.reminders ?? []).contains(where: { $0.minutesBefore == 0 }),
                  let dueDate = task.dueDate else { return nil }
            return ScheduledReminder(
                identifier: Self.taskIdentifierPrefix + task.id + ".urgent-fallback",
                title: task.title,
                body: "Urgent task due now",
                userInfo: [
                    TaskifyNotificationContract.taskIDKey: task.id,
                    TaskifyNotificationContract.boardIDKey: task.boardID,
                ],
                categoryIdentifier: TaskifyNotificationContract.taskCategoryIdentifier,
                fireDate: dueDate
            )
        }
        let eventReminders = events
            .filter { !$0.isDeleted }
            .flatMap { event in
                event.reminderFireDates().compactMap { reminder, fireDate -> ScheduledReminder? in
                    guard fireDate > now.addingTimeInterval(1) else { return nil }
                    var userInfo = ["eventID": event.id]
                    if let boardID = event.boardID { userInfo["boardID"] = boardID }
                    return ScheduledReminder(
                        identifier: Self.eventIdentifierPrefix + event.id + "." + reminder.rawValue,
                        title: event.title,
                        body: reminder.eventLabel,
                        userInfo: userInfo,
                        categoryIdentifier: nil,
                        fireDate: fireDate
                    )
                }
            }
        let upcoming = (taskReminders + urgentFallbacks + eventReminders)
            .sorted { $0.fireDate < $1.fireDate }
            .prefix(60)

        for scheduled in upcoming {
            guard !Task.isCancelled else { break }
            let content = UNMutableNotificationContent()
            content.title = scheduled.title
            content.body = scheduled.body
            content.sound = .default
            content.userInfo = scheduled.userInfo
            if let categoryIdentifier = scheduled.categoryIdentifier {
                content.categoryIdentifier = categoryIdentifier
            }

            var components = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second],
                from: scheduled.fireDate
            )
            components.timeZone = Calendar.current.timeZone
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let request = UNNotificationRequest(
                identifier: scheduled.identifier,
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }
        return Self.label(for: settings.authorizationStatus)
    }

    func requestUrgentAlarmAuthorization() async -> Bool {
#if canImport(AlarmKit)
        guard #available(iOS 26.0, *) else { return false }
        let manager = AlarmManager.shared
        if manager.authorizationState == .authorized { return true }
        guard manager.authorizationState == .notDetermined else { return false }
        do {
            return try await manager.requestAuthorization() == .authorized
        } catch {
            return false
        }
#else
        return false
#endif
    }

    private func rescheduleUrgentAlarms(
        tasks: [TaskItem],
        requestPermission: Bool,
        now: Date
    ) async -> Set<String> {
#if canImport(AlarmKit)
        guard #available(iOS 26.0, *) else { return [] }

        let manager = AlarmManager.shared
        let trackedIDs = (defaults.stringArray(forKey: Self.managedAlarmIDsDefaultsKey) ?? [])
            .compactMap(UUID.init(uuidString:))
        for id in trackedIDs {
            try? manager.cancel(id: id)
        }
        defaults.removeObject(forKey: Self.managedAlarmIDsDefaultsKey)

        let urgentTasks = tasks
            .filter { task in
                TaskUrgentAlarmPreferences.isEnabled(for: task, defaults: defaults)
                    && TaskifyUrgentAlarmContract.isEligible(task, now: now)
            }
            .sorted { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }
        guard !urgentTasks.isEmpty else { return [] }

        var authorization = manager.authorizationState
        if requestPermission, authorization == .notDetermined {
            authorization = (try? await manager.requestAuthorization()) ?? .notDetermined
        }
        guard authorization == .authorized else { return [] }

        var scheduledAlarmIDs: [UUID] = []
        var scheduledTaskIDs = Set<String>()
        for task in urgentTasks {
            guard !Task.isCancelled, let dueDate = task.dueDate else { break }
            let id = Self.urgentAlarmID(for: task.id)
            do {
                let presentation = AlarmPresentation(
                    alert: Self.urgentAlarmAlert(title: task.title)
                )
                let attributes = AlarmAttributes(
                    presentation: presentation,
                    metadata: TaskifyUrgentAlarmMetadata(taskID: task.id, boardID: task.boardID),
                    tintColor: Color(red: 0.12, green: 0.57, blue: 1)
                )
                let configuration = AlarmManager.AlarmConfiguration.alarm(
                    schedule: .fixed(dueDate),
                    attributes: attributes
                )
                _ = try await manager.schedule(id: id, configuration: configuration)
                scheduledAlarmIDs.append(id)
                scheduledTaskIDs.insert(task.id)
            } catch {
                // Keep scheduling later alarms if one request hits a transient system limit.
                continue
            }
        }
        defaults.set(
            scheduledAlarmIDs.map(\.uuidString),
            forKey: Self.managedAlarmIDsDefaultsKey
        )
        return scheduledTaskIDs
#else
        return []
#endif
    }

#if canImport(AlarmKit)
    @available(iOS 26.0, *)
    private static func urgentAlarmAlert(title: String) -> AlarmPresentation.Alert {
        let localizedTitle = LocalizedStringResource(stringLiteral: title)
        if #available(iOS 26.1, *) {
            return AlarmPresentation.Alert(title: localizedTitle)
        }
        return AlarmPresentation.Alert(
            title: localizedTitle,
            stopButton: AlarmButton(
                text: "Stop",
                textColor: .white,
                systemImageName: "stop.fill"
            )
        )
    }

    private static func urgentAlarmID(for taskID: String) -> UUID {
        let digest = SHA256.hash(data: Data(("taskify.urgent." + taskID).utf8))
        var bytes = Array(digest.prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
#endif

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

#if canImport(AlarmKit)
@available(iOS 26.0, *)
private struct TaskifyUrgentAlarmMetadata: AlarmMetadata {
    var taskID: String
    var boardID: String
}
#endif

private struct ScheduledReminder: Sendable {
    var identifier: String
    var title: String
    var body: String
    var userInfo: [String: String]
    var categoryIdentifier: String?
    var fireDate: Date
}

actor WalletPaymentNotificationCoordinator {
    private static let identifierPrefix = "taskify.wallet.lightning."
    private static let ecashIdentifierPrefix = "taskify.wallet.ecash."
    private static let cashuRequestIdentifierPrefix = "taskify.wallet.cashu-request."
    /// The wallet's recovery pipelines can re-surface a payment that was already fully received in
    /// a past session — e.g. a durable delivery queue whose entry didn't get cleared before the app
    /// was interrupted, or the same payment matching more than one recovery pipeline. Those
    /// pipelines still legitimately return a "receipt" for it (the alternative is silently losing
    /// track of genuinely-interrupted payments), so the dedup belongs here, at the point a
    /// notification is about to be shown to the user: each of the three notification-worthy
    /// identifiers below is durably remembered once shown, and never shown again, regardless of how
    /// many more times the underlying recovery logic re-reports the same payment.
    private static let deliveredIdentifiersKey = "taskify.wallet.notifiedPaymentIdentifiers"
    private static let maximumTrackedIdentifiers = 500
    private let center: UNUserNotificationCenter
    private let defaults: UserDefaults

    init(center: UNUserNotificationCenter = .current(), defaults: UserDefaults = .standard) {
        self.center = center
        self.defaults = defaults
    }

    func requestAuthorizationIfNeeded() async {
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }

    func notifyPayments(_ quotes: [CashuLightningReceiveQuote]) async {
        guard !quotes.isEmpty else { return }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .notDetermined, .denied:
            return
        @unknown default:
            return
        }

        for quote in quotes {
            let identifier = Self.identifierPrefix + quote.id
            guard !hasAlreadyNotified(identifier) else { continue }
            let amount = quote.issuedAmount > 0 ? quote.issuedAmount : quote.amount
            let content = UNMutableNotificationContent()
            content.title = "Lightning payment received"
            content.body = "\(amount.formatted()) sats were added to your Taskify wallet."
            content.sound = .default
            content.userInfo = [
                "lightningQuoteID": quote.id,
                "mintURL": quote.mintURL,
                "amount": amount,
            ]
            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: nil
            )
            try? await center.add(request)
            markNotified(identifier)
        }
    }

    func notifyEcashReceipts(_ receipts: [CashuRecoveredReceive]) async {
        guard !receipts.isEmpty else { return }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .notDetermined, .denied:
            return
        @unknown default:
            return
        }

        for receipt in receipts {
            let identifier = Self.ecashIdentifierPrefix + receipt.pending.id
            guard !hasAlreadyNotified(identifier) else { continue }
            let content = UNMutableNotificationContent()
            content.title = "Ecash received"
            content.body = "\(receipt.receivedAmount.formatted()) sats were added to your Taskify wallet."
            content.sound = .default
            content.userInfo = [
                "pendingReceiveID": receipt.pending.id,
                "mintURL": receipt.pending.mintURL,
                "amount": receipt.receivedAmount,
            ]
            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: nil
            )
            try? await center.add(request)
            markNotified(identifier)
        }
    }

    func notifyCashuRequestReceipts(_ receipts: [CashuPaymentRequestReceipt]) async {
        guard !receipts.isEmpty else { return }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .notDetermined, .denied:
            return
        @unknown default:
            return
        }

        for receipt in receipts {
            let identifier = Self.cashuRequestIdentifierPrefix + receipt.eventID
            guard !hasAlreadyNotified(identifier) else { continue }
            let content = UNMutableNotificationContent()
            content.title = "Cashu payment received"
            content.body = "\(receipt.amount.formatted()) sats were added to your Taskify wallet."
            content.sound = .default
            content.userInfo = [
                "cashuPaymentRequestID": receipt.requestID,
                "nostrEventID": receipt.eventID,
                "mintURL": receipt.mintURL,
                "amount": receipt.amount,
            ]
            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: nil
            )
            try? await center.add(request)
            markNotified(identifier)
        }
    }

    private func hasAlreadyNotified(_ identifier: String) -> Bool {
        deliveredIdentifiers().contains(identifier)
    }

    private func markNotified(_ identifier: String) {
        var identifiers = deliveredIdentifiers()
        identifiers.append(identifier)
        if identifiers.count > Self.maximumTrackedIdentifiers {
            identifiers.removeFirst(identifiers.count - Self.maximumTrackedIdentifiers)
        }
        defaults.set(identifiers, forKey: Self.deliveredIdentifiersKey)
    }

    private func deliveredIdentifiers() -> [String] {
        defaults.stringArray(forKey: Self.deliveredIdentifiersKey) ?? []
    }
}

private final class NotificationPresentationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo.reduce(
            into: [String: String]()
        ) { result, pair in
            guard let key = pair.key as? String, let value = pair.value as? String else { return }
            result[key] = value
        }
        guard let action = TaskifyNotificationContract.action(
            for: response.actionIdentifier,
            userInfo: userInfo
        ) else {
            completionHandler()
            return
        }

        Task { @MainActor in
            await TaskNotificationActionRouter.shared.handle(action)
            completionHandler()
        }
    }
}

/// Bridges a notification response delivered by iOS to the already-running model. The fallback
/// queue covers the very short launch interval before SwiftUI has registered the model.
@MainActor
final class TaskNotificationActionRouter {
    static let shared = TaskNotificationActionRouter()

    private weak var model: AppModel?
    private var pendingActions: [TaskifyNotificationContract.Action] = []

    private init() {}

    func register(model: AppModel) {
        self.model = model
        guard !pendingActions.isEmpty else { return }
        let actions = pendingActions
        pendingActions.removeAll()
        Task {
            for action in actions {
                await handle(action)
            }
        }
    }

    func handle(_ action: TaskifyNotificationContract.Action) async {
        guard let model else {
            if !pendingActions.contains(action) {
                pendingActions.append(action)
            }
            return
        }

        switch action {
        case .completeTask(let taskID):
            await model.completeTaskFromNotification(taskID)
        }
    }
}

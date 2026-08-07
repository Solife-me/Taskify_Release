import Foundation
import TaskifyCore
import UserNotifications

actor TaskNotificationCoordinator {
    private static let taskIdentifierPrefix = "taskify.task."
    private static let eventIdentifierPrefix = "taskify.event."
    private let center: UNUserNotificationCenter
    private let presentationDelegate = NotificationPresentationDelegate()

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        center.delegate = presentationDelegate
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
                    return ScheduledReminder(
                        identifier: Self.taskIdentifierPrefix + task.id + "." + reminder.rawValue,
                        title: task.title,
                        body: reminder.label,
                        userInfo: ["taskID": task.id, "boardID": task.boardID],
                        fireDate: fireDate
                    )
                }
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
                        fireDate: fireDate
                    )
                }
            }
        let upcoming = (taskReminders + eventReminders)
            .sorted { $0.fireDate < $1.fireDate }
            .prefix(60)

        for scheduled in upcoming {
            guard !Task.isCancelled else { break }
            let content = UNMutableNotificationContent()
            content.title = scheduled.title
            content.body = scheduled.body
            content.sound = .default
            content.userInfo = scheduled.userInfo

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

private struct ScheduledReminder: Sendable {
    var identifier: String
    var title: String
    var body: String
    var userInfo: [String: String]
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
}

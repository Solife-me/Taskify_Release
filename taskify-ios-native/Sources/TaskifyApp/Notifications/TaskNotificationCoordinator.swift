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

actor WalletPaymentNotificationCoordinator {
    private static let identifierPrefix = "taskify.wallet.lightning."
    private static let ecashIdentifierPrefix = "taskify.wallet.ecash."
    private static let cashuRequestIdentifierPrefix = "taskify.wallet.cashu-request."
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
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
                identifier: Self.identifierPrefix + quote.id,
                content: content,
                trigger: nil
            )
            try? await center.add(request)
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
                identifier: Self.ecashIdentifierPrefix + receipt.pending.id,
                content: content,
                trigger: nil
            )
            try? await center.add(request)
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
                identifier: Self.cashuRequestIdentifierPrefix + receipt.eventID,
                content: content,
                trigger: nil
            )
            try? await center.add(request)
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

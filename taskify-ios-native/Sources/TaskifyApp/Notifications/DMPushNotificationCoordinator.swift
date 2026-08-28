import Foundation
import TaskifyCore
import UIKit
import UserNotifications

enum TaskifyDMPushSettings {
    static let defaultRelayURL = "wss://push.solife.me"
    static let defaultServerURL = "https://push.solife.me"
    private static let enabledKey = "taskify.dmPush.enabled"
    private static let selectionKey = DMPushNotificationSharedSettings.selectionKey
    private static let relayURLKey = "taskify.dmPush.relayURL"
    private static let serverURLKey = "taskify.dmPush.serverURL"
    private static let installationIDKey = "taskify.dmPush.installationID"
    private static let deviceTokenKey = "taskify.dmPush.deviceToken"

    static var isEnabled: Bool { UserDefaults.standard.bool(forKey: enabledKey) }
    static var selection: DMPushNotificationSelection {
        let shared = DMPushNotificationSharedSettings.selection
        guard UserDefaults(suiteName: TaskifySharedContainer.appGroupID)?
            .object(forKey: selectionKey) == nil,
              let legacy = DMPushNotificationSelection(
                rawValue: UserDefaults.standard.string(forKey: selectionKey) ?? ""
              ) else { return shared }
        DMPushNotificationSharedSettings.saveSelection(legacy)
        return legacy
    }
    static var relayURL: String {
        UserDefaults.standard.string(forKey: relayURLKey) ?? defaultRelayURL
    }
    static var serverURL: String {
        UserDefaults.standard.string(forKey: serverURLKey) ?? defaultServerURL
    }
    static var installationID: String {
        if let existing = UserDefaults.standard.string(forKey: installationIDKey), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: installationIDKey)
        return created
    }
    static var deviceToken: String? { UserDefaults.standard.string(forKey: deviceTokenKey) }
    static func saveEnabled(
        selection: DMPushNotificationSelection,
        relayURL: String,
        serverURL: String,
        deviceToken: String
    ) {
        let defaults = UserDefaults.standard
        defaults.set(true, forKey: enabledKey)
        defaults.set(selection.rawValue, forKey: selectionKey)
        DMPushNotificationSharedSettings.saveSelection(selection)
        defaults.set(relayURL, forKey: relayURLKey)
        defaults.set(serverURL, forKey: serverURLKey)
        defaults.set(deviceToken, forKey: deviceTokenKey)
    }

    static func saveSelection(_ selection: DMPushNotificationSelection) {
        UserDefaults.standard.set(selection.rawValue, forKey: selectionKey)
        DMPushNotificationSharedSettings.saveSelection(selection)
    }

    static func saveDeviceToken(_ token: String) {
        UserDefaults.standard.set(token, forKey: deviceTokenKey)
    }

    static func clearEnabled() {
        let defaults = UserDefaults.standard
        defaults.set(false, forKey: enabledKey)
        defaults.removeObject(forKey: deviceTokenKey)
    }
}

enum TaskifyDMPushCoordinatorError: LocalizedError {
    case notificationsDenied
    case registrationReplaced
    case apnsRegistrationFailed(String)

    var errorDescription: String? {
        switch self {
        case .notificationsDenied:
            "Notifications are disabled in iOS Settings."
        case .registrationReplaced:
            "A newer push-registration request replaced this one."
        case .apnsRegistrationFailed(let message):
            "Apple push registration failed: \(message)"
        }
    }
}

@MainActor
final class TaskifyDMPushCoordinator {
    static let shared = TaskifyDMPushCoordinator()

    private weak var model: AppModel?
    private var tokenContinuation: CheckedContinuation<String, Error>?

    private init() {}

    func register(model: AppModel) {
        self.model = model
        guard TaskifyDMPushSettings.isEnabled else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func requestDeviceToken() async throws -> String {
        let center = UNUserNotificationCenter.current()
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            settings = await center.notificationSettings()
        }
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .notDetermined, .denied:
            throw TaskifyDMPushCoordinatorError.notificationsDenied
        @unknown default:
            throw TaskifyDMPushCoordinatorError.notificationsDenied
        }

        tokenContinuation?.resume(throwing: TaskifyDMPushCoordinatorError.registrationReplaced)
        return try await withCheckedThrowingContinuation { continuation in
            tokenContinuation = continuation
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        TaskifyDMPushSettings.saveDeviceToken(token)
        if let continuation = tokenContinuation {
            tokenContinuation = nil
            continuation.resume(returning: token)
            return
        }
        guard TaskifyDMPushSettings.isEnabled else { return }
        Task { await model?.refreshDMPushRegistration(deviceToken: token) }
    }

    func didFailRegistration(_ error: Error) {
        guard let continuation = tokenContinuation else { return }
        tokenContinuation = nil
        continuation.resume(
            throwing: TaskifyDMPushCoordinatorError.apnsRegistrationFailed(error.localizedDescription)
        )
    }

    func handleRemoteNotification(
        userInfo: [AnyHashable: Any],
        completion: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let taskify = userInfo["taskify"] as? [String: Any],
              let type = taskify["type"] as? String,
              type == "dm-wake" || type == "dm-preview",
              let model else {
            completion(.noData)
            return
        }
        Task {
            completion(await model.handleDMPushWake(notifyMessages: type == "dm-wake"))
        }
    }
}

final class TaskifyApplicationDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            TaskifyDMPushCoordinator.shared.didRegister(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            TaskifyDMPushCoordinator.shared.didFailRegistration(error)
        }
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            TaskifyDMPushCoordinator.shared.handleRemoteNotification(
                userInfo: userInfo,
                completion: completionHandler
            )
        }
    }
}

actor TaskifyDMPushLocalNotifier {
    static let shared = TaskifyDMPushLocalNotifier()

    func notifyNewMessage() async {
        let content = UNMutableNotificationContent()
        content.title = "New Message"
        content.sound = .default
        content.threadIdentifier = "taskify-direct-messages"
        content.userInfo = [
            TaskifyNotificationContract.destinationKey:
                TaskifyNotificationContract.Destination.chat.rawValue,
        ]
        let request = UNNotificationRequest(
            identifier: "taskify.dm-push.message.\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(request)
    }
}

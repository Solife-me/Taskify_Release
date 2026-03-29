import TaskifyCore

#if canImport(UserNotifications)
import UserNotifications
#endif

enum NotificationPermissionCoordinator {
    static var isSupported: Bool {
        #if canImport(UserNotifications)
        true
        #else
        false
        #endif
    }

    @MainActor
    static func refresh(settingsManager: SettingsManager) async -> NotificationPermissionState {
        #if canImport(UserNotifications)
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let permission = NotificationPermissionState(settings.authorizationStatus)
        var next = settingsManager.settings.pushNotifications
        next.platform = .ios
        next.permission = permission
        if permission != .granted {
            next.enabled = false
        }
        settingsManager.settings.pushNotifications = next
        return permission
        #else
        return .notDetermined
        #endif
    }

    @MainActor
    static func requestAuthorization(settingsManager: SettingsManager) async throws -> NotificationPermissionState {
        #if canImport(UserNotifications)
        _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        let permission = await refresh(settingsManager: settingsManager)
        if permission == .granted {
            var next = settingsManager.settings.pushNotifications
            next.enabled = true
            next.permission = permission
            settingsManager.settings.pushNotifications = next
        }
        settingsManager.saveNow()
        return permission
        #else
        throw NotificationPermissionError.unavailable
        #endif
    }
}

enum NotificationPermissionError: LocalizedError {
    case unavailable
    case denied

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Notification permissions are unavailable on this platform build."
        case .denied:
            return "Permission was not granted. You can enable notifications later in system settings."
        }
    }
}

#if canImport(UserNotifications)
extension NotificationPermissionState {
    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional, .ephemeral:
            self = .granted
        case .denied:
            self = .denied
        case .notDetermined:
            self = .notDetermined
        @unknown default:
            self = .notDetermined
        }
    }
}
#endif

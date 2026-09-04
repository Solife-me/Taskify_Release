import SwiftUI
import UserNotifications
import WatchKit
import OSLog

private let taskifyWatchChatRefreshIdentifier = "taskify.watch.chat.refresh"

@MainActor
final class TaskifyWatchApplicationDelegate: NSObject, WKApplicationDelegate {
    let model = TaskifyWatchAppModel()
    private var isRequestingNotificationAccess = false
    private var scheduledChatRefreshDate: Date? {
        get { UserDefaults.standard.object(forKey: "taskify.watch.chat.background-refresh-date") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "taskify.watch.chat.background-refresh-date") }
    }
    private static let logger = Logger(subsystem: "solife.me.Taskify.Native.watchkitapp", category: "ChatBackgroundSync")

    func applicationDidFinishLaunching() {
        activateChatPushIfNeeded()
    }

    func applicationDidBecomeActive() {
        model.restoreProtectedStateAfterUnlock()
        activateChatPushIfNeeded()
    }

    func applicationDidEnterBackground() {
        // A scheduled task can be ignored if its date passed while the app was foregrounded.
        if let date = scheduledChatRefreshDate, date <= Date() { scheduledChatRefreshDate = nil }
        scheduleChatRefreshIfNeeded()
        Task {
            await TaskifyWatchPhotoLoader.shared.clearMemory()
            await TaskifyWatchAvatarLoader.shared.clearMemory()
            TaskifyWatchMarkdownCache.shared.clear()
        }
    }

    func activateChatPushIfNeeded() {
        // Registration/enrollment can involve several requests. A cold background wake
        // reserves its execution window for the inbox, and retries registration on activation.
        guard model.isChatConfigured, WKApplication.shared().applicationState != .background else { return }

        // Register even if alert permission is declined: the generic remote alert also carries a
        // content-available refresh opportunity for untethered inbox delivery.
        WKApplication.shared().registerForRemoteNotifications()

        guard !isRequestingNotificationAccess else { return }
        isRequestingNotificationAccess = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.isRequestingNotificationAccess = false }
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
#if DEBUG
                // Permission prompts obscure the conversation during paired idle diagnostics.
                // This skips requesting access; it does not grant notification permission.
                if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_ONBOARDING"] == "skip" {
                    return
                }
#endif
                _ = try? await center.requestAuthorization(options: [.alert, .sound])
            }
        }
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        Task { @MainActor [weak self] in
            await self?.model.registerWatchPushToken(deviceToken)
        }
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: any Error) {
        // The app remains fully usable with foreground refresh and retries registration the next
        // time it becomes active. Avoid persisting APNs errors or device identifiers in logs.
        Self.logger.error("Watch push registration failed")
    }

    private func scheduleChatRefreshIfNeeded() {
        guard model.isChatConfigured else { return }
        // Only one refresh can be scheduled. Do not continually postpone an existing request
        // as pushes arrive; watchOS may already be delaying it for budget/battery reasons.
        guard scheduledChatRefreshDate == nil else { return }
        let preferredDate = Date().addingTimeInterval(30 * 60)
        scheduledChatRefreshDate = preferredDate
        WKApplication.shared().scheduleBackgroundRefresh(
            withPreferredDate: preferredDate, userInfo: taskifyWatchChatRefreshIdentifier as NSString
        ) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                self?.scheduledChatRefreshDate = nil
                Self.logger.error("Background chat refresh scheduling failed")
            }
        }
    }

    func handleScheduledChatRefresh() async {
        scheduledChatRefreshDate = nil
        defer { scheduleChatRefreshIfNeeded() }
        // Fallback refreshes only update the cache; they never replay historical alerts.
        _ = await model.handleChatPushWake()
    }

    func didReceiveRemoteNotification(
        _ userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (WKBackgroundFetchResult) -> Void
    ) {
        guard let taskify = userInfo["taskify"] as? [String: Any],
              let type = taskify["type"] as? String,
              type == "dm-wake" || type == "dm-preview" else {
            completionHandler(.noData)
            return
        }
        Task { @MainActor [weak self] in
            guard let self else {
                completionHandler(.failed)
                return
            }
            let result = await self.model.handleChatPushWake()
            self.scheduleChatRefreshIfNeeded()
            // Report the cache result promptly, before any optional legacy local alert work.
            completionHandler(result.receivedData ? .newData : result.failed ? .failed : .noData)
            // Current relay builds deliver dm-preview as a visible remote alert. Only synthesize a
            // local alert for legacy background-only dm-wake payloads during a rolling upgrade.
            if type == "dm-wake",
               result.shouldNotify,
               WKApplication.shared().applicationState != .active {
                let content = UNMutableNotificationContent()
                content.title = "New Message"
                content.body = "Open Taskify to view it."
                content.sound = .default
                content.threadIdentifier = "taskify-direct-messages"
                let request = UNNotificationRequest(
                    identifier: "taskify.watch.dm.\(UUID().uuidString)",
                    content: content,
                    trigger: nil
                )
                try? await UNUserNotificationCenter.current().add(request)
            }
        }
    }
}

@main
struct TaskifyWatchApp: App {
    @WKApplicationDelegateAdaptor private var applicationDelegate: TaskifyWatchApplicationDelegate

    var body: some Scene {
        WindowGroup {
            TaskifyWatchRootView()
                .environment(applicationDelegate.model)
                .preferredColorScheme(.dark)
                .task(id: "\(applicationDelegate.model.chatIdentityPublicKey ?? "unconfigured")|\(applicationDelegate.model.isChatConfigured)") {
                    applicationDelegate.activateChatPushIfNeeded()
                }
        }
        .backgroundTask(.appRefresh(taskifyWatchChatRefreshIdentifier)) {
            await applicationDelegate.handleScheduledChatRefresh()
        }
    }
}

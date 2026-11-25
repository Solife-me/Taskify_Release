import BackgroundTasks
import CoreSpotlight
import Foundation
import Security
import TaskifyCore
import UIKit
import UserNotifications
import WidgetKit
#if canImport(AlarmKit)
import AlarmKit
#endif

/// A pending reset is kept outside the data being erased. Running it before the workspace
/// starts keeps the old sync engine, wallet and store from writing data back during deletion.
@MainActor
enum TaskifyLocalReset {
    private static let files = FileManager.default

    private static var marker: URL {
        URL.libraryDirectory
            .appendingPathComponent("TaskifyLocalReset", isDirectory: true)
            .appendingPathComponent("pending")
    }

    static func request() throws {
        var directory = marker.deletingLastPathComponent()
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        try Data().write(to: marker, options: [.atomic, .noFileProtection])
    }

    static func finishIfRequested() throws {
        do {
            _ = try files.attributesOfItem(atPath: marker.path)
        } catch let error as CocoaError where isMissing(error) {
            return
        }

        // Match only Taskify's services, across both current and legacy Keychain access groups.
        // The native service contains the Nostr key, wallet seed and P2PK recipient keys.
        // iCloud recovery uses a different service so local deletion leaves the backup available.
        for service in ["solife.me.Taskify.Native", "solife.me.Taskify.nwc", "TaskifyShareIdentity"] {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
            ]
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
            }
        }

        if TaskifySharedContainer.isAvailable() {
            try removeItem(TaskifySharedContainer.storeDirectory())
        }
        if TaskifySharedContainer.groupDirectory(appGroupID: ShareTransferStore.groupID) != nil {
            let shareDirectory = try ShareTransferStore.root()
            try removeItem(shareDirectory.appendingPathComponent("account.json"))
            for job in ShareTransferStore.all() { TaskifyShareUploadSession.cancel(job) }
            try removeItem(shareDirectory)
        }

        for directory in [
            URL.applicationSupportDirectory, .cachesDirectory, .documentsDirectory, files.temporaryDirectory,
        ] {
            try removeContents(of: directory)
        }

        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: TaskifyBackgroundSyncCoordinator.refreshIdentifier)
        UIApplication.shared.unregisterForRemoteNotifications()
        let notifications = UNUserNotificationCenter.current()
        notifications.removeAllPendingNotificationRequests()
        notifications.removeAllDeliveredNotifications()
        notifications.setBadgeCount(0, withCompletionHandler: nil)
#if canImport(AlarmKit)
        if #available(iOS 26.0, *), AlarmManager.shared.authorizationState == .authorized {
            let manager = AlarmManager.shared
            for alarm in try manager.alarms { try manager.cancel(id: alarm.id) }
        }
#endif
        TaskifyShareSuggestions.clear()
        CSSearchableIndex.default().deleteAllSearchableItems()
        URLCache.shared.removeAllCachedResponses()

        for suite in [TaskifySharedContainer.appGroupID, ShareTransferStore.groupID] {
            UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        }
        if let appID = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: appID)
        }
        WidgetCenter.shared.reloadAllTimelines()
        // Any failure above keeps the marker so the next launch retries before reading data.
        try files.removeItem(at: marker)
    }

    private static func removeContents(of directory: URL) throws {
        let entries: [URL]
        do {
            entries = try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        } catch let error as CocoaError where isMissing(error) {
            return
        }
        for entry in entries { try removeItem(entry) }
    }

    private static func removeItem(_ url: URL) throws {
        do {
            try files.removeItem(at: url)
        } catch let error as CocoaError where isMissing(error) {
            // Absent on fresh installs, and expected if we are retrying a partial reset.
        }
    }

    private static func isMissing(_ error: CocoaError) -> Bool {
        error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile
    }
}

import AppKit
import Foundation
import TaskifyCore
import UserNotifications

@MainActor
enum MacLocalReset {
    private static let files = FileManager.default
    private static var marker: URL {
        URL.libraryDirectory.appendingPathComponent("TaskifyLocalReset.pending")
    }

    static var isPending: Bool { files.fileExists(atPath: marker.path) }

    static func request() throws {
        try Data().write(to: marker, options: .atomic)
        NSApplication.shared.terminate(nil)
    }

    static func finishIfRequested() throws {
        do {
            _ = try files.attributesOfItem(atPath: marker.path)
        } catch let error as CocoaError where isMissing(error) {
            return
        }

        let bundleID = Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac"
        let identityStore = KeychainIdentityStore()
        let vault = MacAccountVault(service: bundleID + ".accounts", usesSharedAccessGroup: true)
        let storeDirectory = TaskifySharedContainer.storeDirectory()
        let accountDirectory = MacAccountStoragePaths.accountsDirectory(primaryURL: JSONTaskStore.defaultURL)
        let scopedIDs = try directoryNamesIfPresent(accountDirectory)
        let savedIDs = try vault.load().accounts.map(\.publicKeyHex)
        for id in Set(savedIDs + scopedIDs) {
            guard let accountID = NostrPublicKey.parse(id)?.hexString else { continue }
            let suite = MacAccountPreferences.suiteName(bundleIdentifier: bundleID, accountID: accountID)
            UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        }

        try removeIfPresent(storeDirectory)
        let privateDirectory = TaskifySharedContainer.privateDirectory()
        if privateDirectory != storeDirectory {
            try removeIfPresent(privateDirectory)
        }
        let caches = files.urls(for: .cachesDirectory, in: .userDomainMask).first ?? files.temporaryDirectory
        try removeIfPresent(caches.appendingPathComponent("TaskifyChatAttachments", isDirectory: true))
        try removeIfPresent(files.temporaryDirectory.appendingPathComponent("TaskifyMedia", isDirectory: true))
        URLCache.shared.removeAllCachedResponses()

        try identityStore.clearForLocalReset()
        try vault.save(MacAccountVaultState())
        let notifications = UNUserNotificationCenter.current()
        notifications.removeAllPendingNotificationRequests()
        notifications.removeAllDeliveredNotifications()
        NSApplication.shared.unregisterForRemoteNotifications()
        UserDefaults.standard.removePersistentDomain(forName: bundleID)
        try files.removeItem(at: marker)
    }

    private static func directoryNamesIfPresent(_ url: URL) throws -> [String] {
        do {
            return try files.contentsOfDirectory(atPath: url.path)
        } catch let error as CocoaError where isMissing(error) {
            return []
        }
    }

    private static func removeIfPresent(_ url: URL) throws {
        do {
            try files.removeItem(at: url)
        } catch let error as CocoaError where isMissing(error) {
            return
        }
    }

    private static func isMissing(_ error: CocoaError) -> Bool {
        error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile
    }
}

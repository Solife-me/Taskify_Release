import Foundation
#if os(macOS)
import Security
#endif

/// Where Taskify keeps its data so that processes other than the app can read it.
///
/// Widgets, the Add Task intent and the app are separate processes with separate containers. The
/// only thing they can share is an App Group container, so the store lives there when the group is
/// available. When it isn't -- the capability not yet enabled, a unit test, a preview -- this falls
/// back to the app's own Application Support directory, which is where the store lived before.
/// Falling back keeps the app fully working on its own; it just means anything outside the app
/// sees no data.
public enum TaskifySharedContainer {
    /// Must match the signed App Groups entitlement on the app and its extensions.
    /// An unentitled Mac must use private storage even if Foundation returns a group URL.
    public static let appGroupID = "group.solife.me.Taskify"

    /// True when the App Group capability is actually in effect. Widgets can only show real data
    /// when this is true.
    public static func isAvailable(
        fileManager: FileManager = .default,
        authorization: (String) -> Bool = processAuthorizesAppGroup
    ) -> Bool {
        groupDirectory(fileManager: fileManager, authorization: authorization) != nil
    }

    /// macOS may return a plausible group URL even without permission to use it.
    /// Check the running executable's signed entitlements, not its bundled plist.
    public static func processAuthorizesAppGroup(_ identifier: String) -> Bool {
#if os(macOS)
        guard let task = SecTaskCreateFromSelf(nil),
              let groups = SecTaskCopyValueForEntitlement(task, "com.apple.security.application-groups" as CFString, nil) as? [String]
        else { return false }
        return groups.contains(identifier)
#else
        return true // Other Apple platforms validate access in the container lookup.
#endif
    }

    public static func groupDirectory(
        appGroupID: String = TaskifySharedContainer.appGroupID,
        fileManager: FileManager = .default,
        authorization: (String) -> Bool = processAuthorizesAppGroup
    ) -> URL? {
        guard authorization(appGroupID) else { return nil }
        return fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
    }

    /// The app's own directory -- the pre-App-Group location, and the fallback.
    public static func privateDirectory(fileManager: FileManager = .default) -> URL {
        let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.temporaryDirectory
        return applicationSupport.appendingPathComponent("TaskifyNative", isDirectory: true)
    }

    public static func storeDirectory(
        appGroupID: String = TaskifySharedContainer.appGroupID,
        fileManager: FileManager = .default,
        authorization: (String) -> Bool = processAuthorizesAppGroup
    ) -> URL {
        guard let group = groupDirectory(appGroupID: appGroupID, fileManager: fileManager, authorization: authorization) else {
            return privateDirectory(fileManager: fileManager)
        }
        return group.appendingPathComponent("TaskifyNative", isDirectory: true)
    }

    /// Moves an existing store into the shared container the first time the group becomes
    /// available, so enabling the capability doesn't look like the app lost everything.
    ///
    /// Copies rather than moves, and only when the destination is empty: if anything goes wrong
    /// the original is still sitting where the app used to read it. Returns whether it copied.
    @discardableResult
    public static func migrateIfNeeded(
        appGroupID: String = TaskifySharedContainer.appGroupID,
        fileManager: FileManager = .default,
        authorization: (String) -> Bool = processAuthorizesAppGroup
    ) -> Bool {
        guard let group = groupDirectory(appGroupID: appGroupID, fileManager: fileManager, authorization: authorization) else {
            return false
        }
        let source = privateDirectory(fileManager: fileManager)
            .appendingPathComponent(storeFilename, isDirectory: false)
        let destinationDirectory = group.appendingPathComponent("TaskifyNative", isDirectory: true)
        let destination = destinationDirectory.appendingPathComponent(storeFilename, isDirectory: false)

        guard fileManager.fileExists(atPath: source.path),
              !fileManager.fileExists(atPath: destination.path) else { return false }

        do {
            try fileManager.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)
            try fileManager.copyItem(at: source, to: destination)
            return true
        } catch {
            return false
        }
    }

    public static let storeFilename = "taskify.json"
}

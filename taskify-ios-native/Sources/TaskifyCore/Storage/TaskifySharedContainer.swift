import Foundation

/// Where Taskify keeps its data so that processes other than the app can read it.
///
/// Widgets, the Add Task intent and the app are separate processes with separate containers. The
/// only thing they can share is an App Group container, so the store lives there when the group is
/// available. When it isn't -- the capability not yet enabled, a unit test, a preview -- this falls
/// back to the app's own Application Support directory, which is where the store lived before.
/// Falling back keeps the app fully working on its own; it just means anything outside the app
/// sees no data.
public enum TaskifySharedContainer {
    /// Must match the App Groups capability on both the app and the widget extension exactly. A
    /// mismatch is silent -- `containerURL(forSecurityApplicationGroupIdentifier:)` just returns
    /// nil, the store quietly falls back to the app's private directory, and widgets show nothing
    /// with no error anywhere to explain it.
    public static let appGroupID = "group.solife.me.Taskify"

    /// True when the App Group capability is actually in effect. Widgets can only show real data
    /// when this is true.
    public static func isAvailable(fileManager: FileManager = .default) -> Bool {
        groupDirectory(fileManager: fileManager) != nil
    }

    public static func groupDirectory(
        appGroupID: String = TaskifySharedContainer.appGroupID,
        fileManager: FileManager = .default
    ) -> URL? {
        fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
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
        fileManager: FileManager = .default
    ) -> URL {
        guard let group = groupDirectory(appGroupID: appGroupID, fileManager: fileManager) else {
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
        fileManager: FileManager = .default
    ) -> Bool {
        guard let group = groupDirectory(appGroupID: appGroupID, fileManager: fileManager) else {
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

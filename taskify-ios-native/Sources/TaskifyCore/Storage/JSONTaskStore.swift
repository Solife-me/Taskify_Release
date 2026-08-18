import Foundation

public actor JSONTaskStore {
    public struct LoadResult: Sendable {
        public let snapshot: TaskifySnapshot
        public let wasRepaired: Bool
    }

    /// Resolves to the App Group container when that capability is in effect, so widgets and the
    /// Add Task intent read the same file the app writes. Falls back to the app's own directory
    /// otherwise -- see `TaskifySharedContainer`.
    public static var defaultURL: URL {
        TaskifySharedContainer.storeDirectory()
            .appendingPathComponent(TaskifySharedContainer.storeFilename, isDirectory: false)
    }

    private let fileURL: URL

    public init(fileURL: URL = JSONTaskStore.defaultURL) {
        self.fileURL = fileURL
    }

    public func load() throws -> TaskifySnapshot {
        try loadWithRepairStatus().snapshot
    }

    public func loadWithRepairStatus() throws -> LoadResult {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return LoadResult(snapshot: .empty, wasRepaired: false)
        }

        let data = try Data(contentsOf: fileURL)
        let decoder = JSONDecoder()
        var snapshot = try decoder.decode(TaskifySnapshot.self, from: data)
        let decodedSnapshot = snapshot
        snapshot.repairSelection()
        return LoadResult(snapshot: snapshot, wasRepaired: snapshot != decodedSnapshot)
    }

    public func save(_ snapshot: TaskifySnapshot) throws {
        let directoryURL = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )

        let encoder = JSONEncoder()
        // Sorted for deterministic output; not pretty-printed. Nothing reads this file by eye,
        // and the indentation was roughly a third of the bytes written on every debounced save
        // and read back on every launch.
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(snapshot)
        try data.write(to: fileURL, options: .atomic)
    }
}

import Foundation

public actor JSONTaskStore {
    public struct LoadResult: Sendable {
        public let snapshot: TaskifySnapshot
        public let wasRepaired: Bool
    }

    public static var defaultURL: URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return applicationSupport
            .appendingPathComponent("TaskifyNative", isDirectory: true)
            .appendingPathComponent("taskify.json", isDirectory: false)
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
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(snapshot)
        try data.write(to: fileURL, options: .atomic)
    }
}

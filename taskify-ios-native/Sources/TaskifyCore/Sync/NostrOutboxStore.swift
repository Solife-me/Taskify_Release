import Foundation

public struct NostrOutboxEntry: Codable, Equatable, Sendable, Identifiable {
    public var id: String { event.id }
    public var event: NostrEvent
    public var relayURLs: [String]
    public var boardLocalID: String
    public var taskID: String
    public var queuedAt: Date

    public init(
        event: NostrEvent,
        relayURLs: [String],
        boardLocalID: String,
        taskID: String,
        queuedAt: Date = Date()
    ) {
        self.event = event
        self.relayURLs = relayURLs
        self.boardLocalID = boardLocalID
        self.taskID = taskID
        self.queuedAt = queuedAt
    }
}

public actor NostrOutboxStore {
    public static var defaultURL: URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return applicationSupport
            .appendingPathComponent("TaskifyNative", isDirectory: true)
            .appendingPathComponent("nostr-outbox.json", isDirectory: false)
    }

    private let fileURL: URL
    private var entries: [NostrOutboxEntry]

    public init(fileURL: URL = NostrOutboxStore.defaultURL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([NostrOutboxEntry].self, from: data) {
            entries = decoded
        } else {
            entries = []
        }
    }

    public func allEntries() -> [NostrOutboxEntry] {
        entries.sorted { $0.queuedAt < $1.queuedAt }
    }

    public func enqueue(_ entry: NostrOutboxEntry) throws {
        entries.removeAll {
            $0.boardLocalID == entry.boardLocalID && $0.taskID == entry.taskID
        }
        entries.append(entry)
        try persist()
    }

    public func markAccepted(eventID: String) throws {
        entries.removeAll { $0.event.id == eventID }
        try persist()
    }

    private func persist() throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(entries).write(to: fileURL, options: .atomic)
    }
}

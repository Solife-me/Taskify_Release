import Foundation

public struct NostrOutboxEntry: Codable, Equatable, Sendable, Identifiable {
    public var id: String { event.id }
    public var event: NostrEvent
    public var relayURLs: [String]
    public var boardLocalID: String
    public var taskID: String
    public var queuedAt: Date
    public var acceptedRelayURLs: [String]?

    public init(
        event: NostrEvent,
        relayURLs: [String],
        boardLocalID: String,
        taskID: String,
        queuedAt: Date = Date(),
        acceptedRelayURLs: [String]? = nil
    ) {
        self.event = event
        self.relayURLs = relayURLs
        self.boardLocalID = boardLocalID
        self.taskID = taskID
        self.queuedAt = queuedAt
        self.acceptedRelayURLs = acceptedRelayURLs
    }

    public var pendingRelayURLs: [String] {
        let accepted = Set(acceptedRelayURLs ?? [])
        return relayURLs.filter { !accepted.contains($0) }
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

    public func isPending(eventID: String, relayURL: String) -> Bool {
        entries.first(where: { $0.event.id == eventID })?
            .pendingRelayURLs
            .contains(relayURL) == true
    }

    public func enqueue(_ entry: NostrOutboxEntry) throws {
        try enqueue([entry])
    }

    public func enqueue(_ newEntries: [NostrOutboxEntry]) throws {
        guard !newEntries.isEmpty else { return }
        for entry in newEntries {
            entries.removeAll {
                $0.boardLocalID == entry.boardLocalID && $0.taskID == entry.taskID
            }
            entries.append(entry)
        }
        try persist()
    }

    public func markAccepted(eventID: String, relayURL: String) throws {
        guard let index = entries.firstIndex(where: { $0.event.id == eventID }),
              entries[index].relayURLs.contains(relayURL) else { return }

        var accepted = Set(entries[index].acceptedRelayURLs ?? [])
        accepted.insert(relayURL)
        entries[index].acceptedRelayURLs = entries[index].relayURLs.filter { accepted.contains($0) }
        if entries[index].pendingRelayURLs.isEmpty {
            entries.remove(at: index)
        }
        try persist()
    }

    public func replaceRelayTargets(
        boardLocalID: String,
        relayURLs: [String]
    ) throws {
        let normalizedRelays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !normalizedRelays.isEmpty else { return }

        for index in entries.indices where entries[index].boardLocalID == boardLocalID {
            let accepted = Set(entries[index].acceptedRelayURLs ?? [])
            entries[index].relayURLs = normalizedRelays
            entries[index].acceptedRelayURLs = normalizedRelays.filter { accepted.contains($0) }
        }
        entries.removeAll {
            $0.boardLocalID == boardLocalID && $0.pendingRelayURLs.isEmpty
        }
        try persist()
    }

    public func removeEntries(boardLocalID: String) throws {
        let originalCount = entries.count
        entries.removeAll { $0.boardLocalID == boardLocalID }
        if entries.count != originalCount {
            try persist()
        }
    }

    private func persist() throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        // See `JSONTaskStore.save` — deterministic, but not indented for human reading.
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(entries).write(to: fileURL, options: .atomic)
    }
}

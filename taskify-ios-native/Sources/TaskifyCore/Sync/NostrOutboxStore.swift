import Foundation

public enum NostrOutboxAcknowledgementPolicy: String, Codable, Equatable, Sendable {
    /// State-replication events remain queued until every configured replica accepts them.
    case everyRelay
    /// Delivery events are complete once one destination accepts them. Other inbox relays are
    /// redundancy, not a reason to leave a chat message pending forever.
    case anyRelay
}

public struct NostrOutboxEntry: Codable, Equatable, Sendable, Identifiable {
    public var id: String { event.id }
    public var event: NostrEvent
    public var relayURLs: [String]
    public var boardLocalID: String
    public var taskID: String
    public var queuedAt: Date
    public var acceptedRelayURLs: [String]?
    /// Optional for backward-compatible decoding of existing outbox files.
    public var acknowledgementPolicy: NostrOutboxAcknowledgementPolicy?
    public var expiresAt: Date?
    /// Cleared only after the parent is accepted. Optional for older outboxes.
    public var dependsOnEventID: String?

    public init(
        event: NostrEvent,
        relayURLs: [String],
        boardLocalID: String,
        taskID: String,
        queuedAt: Date = Date(),
        acceptedRelayURLs: [String]? = nil,
        acknowledgementPolicy: NostrOutboxAcknowledgementPolicy = .everyRelay,
        expiresAt: Date? = nil,
        dependsOnEventID: String? = nil
    ) {
        self.event = event
        self.relayURLs = relayURLs
        self.boardLocalID = boardLocalID
        self.taskID = taskID
        self.queuedAt = queuedAt
        self.acceptedRelayURLs = acceptedRelayURLs
        self.acknowledgementPolicy = acknowledgementPolicy
        self.expiresAt = expiresAt
        self.dependsOnEventID = dependsOnEventID
    }

    public var pendingRelayURLs: [String] {
        let accepted = Set(acceptedRelayURLs ?? [])
        return relayURLs.filter { !accepted.contains($0) }
    }

    public var effectiveAcknowledgementPolicy: NostrOutboxAcknowledgementPolicy {
        acknowledgementPolicy ?? .everyRelay
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
    private var deferredPersistTask: Task<Void, Never>?

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

    public func entryCount() -> Int { entries.count }

    public func pendingRelayURLs() -> Set<String> {
        entries.reduce(into: Set<String>()) { relays, entry in
            relays.formUnion(entry.pendingRelayURLs)
        }
    }

    /// Returns this relay's work newest-first. The delivery scheduler periodically takes the
    /// oldest entry from this list as well, so fresh state can jump a large backlog without
    /// permanently starving durable older changes.
    public func pendingEntries(
        for relayURL: String,
        excludingEventIDs: Set<String> = []
    ) -> [NostrOutboxEntry] {
        entries
            .filter {
                !excludingEventIDs.contains($0.event.id) &&
                    $0.dependsOnEventID == nil &&
                    $0.pendingRelayURLs.contains(relayURL)
            }
            .sorted {
                if $0.queuedAt != $1.queuedAt { return $0.queuedAt > $1.queuedAt }
                if $0.event.createdAt != $1.event.createdAt {
                    return $0.event.createdAt > $1.event.createdAt
                }
                return $0.event.id > $1.event.id
            }
    }

    public func isPending(eventID: String, relayURL: String) -> Bool {
        guard let entry = entries.first(where: { $0.event.id == eventID }) else { return false }
        return entry.dependsOnEventID == nil && entry.pendingRelayURLs.contains(relayURL)
    }

    public func enqueue(_ entry: NostrOutboxEntry) throws {
        try enqueue([entry])
    }

    public func enqueue(_ newEntries: [NostrOutboxEntry]) throws {
        guard !newEntries.isEmpty else { return }
        let previous = entries
        for entry in newEntries {
            entries.removeAll {
                $0.boardLocalID == entry.boardLocalID && $0.taskID == entry.taskID
            }
            entries.append(entry)
        }
        do { try persist() }
        catch { entries = previous; throw error }
    }

    @discardableResult
    public func markAccepted(eventID: String, relayURL: String) throws -> NostrOutboxEntry? {
        guard let index = entries.firstIndex(where: { $0.event.id == eventID }),
              entries[index].relayURLs.contains(relayURL) else { return nil }

        let hasDependents = entries.contains { $0.dependsOnEventID == eventID }
        let previous = hasDependents ? entries : nil
        var accepted = Set(entries[index].acceptedRelayURLs ?? [])
        accepted.insert(relayURL)
        entries[index].acceptedRelayURLs = entries[index].relayURLs.filter { accepted.contains($0) }
        let isComplete = entries[index].effectiveAcknowledgementPolicy == .anyRelay ||
            entries[index].pendingRelayURLs.isEmpty
        let completed = isComplete ? entries.remove(at: index) : nil
        if let completed { releaseDependents(of: [completed.id]) }
        if completed != nil && hasDependents {
            // Commit the acknowledgement and the released replies together
            // before the scheduler can publish a follow-up.
            do { try persist() }
            catch { if let previous { entries = previous }; throw error }
        } else { scheduleDeferredPersist() }
        return completed
    }

    @discardableResult
    public func removeExpired(now: Date = Date()) throws -> [NostrOutboxEntry] {
        var expired = entries.filter { entry in
            guard let expiresAt = entry.expiresAt else { return false }
            return expiresAt <= now
        }
        guard !expired.isEmpty else { return [] }
        var expiredIDs = Set(expired.map(\.event.id))
        // A reply cannot outlive a parent that was never delivered.
        while let dependent = entries.first(where: {
            !expiredIDs.contains($0.id) && $0.dependsOnEventID.map(expiredIDs.contains) == true
        }) {
            expired.append(dependent)
            expiredIDs.insert(dependent.id)
        }
        entries.removeAll { expiredIDs.contains($0.event.id) }
        try persist()
        return expired.sorted { $0.queuedAt < $1.queuedAt }
    }

    /// Stops a permanently unavailable replica from retaining already-published events forever.
    /// Entries that no relay has accepted are deliberately excluded: age alone must never discard
    /// the only durable copy of a local change.
    @discardableResult
    public func removeStaleReplicaBacklog(
        now: Date = Date(),
        retention: TimeInterval
    ) throws -> [NostrOutboxEntry] {
        let cutoff = now.addingTimeInterval(-max(0, retention))
        let stale = entries.filter {
            !($0.acceptedRelayURLs ?? []).isEmpty &&
                !$0.pendingRelayURLs.isEmpty &&
                $0.queuedAt <= cutoff
        }
        guard !stale.isEmpty else { return [] }
        let staleIDs = Set(stale.map(\.event.id))
        entries.removeAll { staleIDs.contains($0.event.id) }
        releaseDependents(of: staleIDs)
        try persist()
        return stale.sorted { $0.queuedAt < $1.queuedAt }
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
        let completed = entries.filter {
            $0.boardLocalID == boardLocalID && $0.pendingRelayURLs.isEmpty
        }
        let completedIDs = Set(completed.map(\.id))
        entries.removeAll { completedIDs.contains($0.id) }
        releaseDependents(of: completedIDs)
        try persist()
    }

    /// Drops relays from every queued entry, completing entries left with no pending target.
    /// Used when a relay leaves the device's sync list: a relay that will never accept an event
    /// must not hold the change queue open forever. Returns the completed entries so callers can
    /// report their delivery state.
    @discardableResult
    public func stripRelayTargets(_ relayURLs: Set<String>) throws -> [NostrOutboxEntry] {
        let targets = Set(relayURLs.compactMap(TaskifyRelayURL.normalize))
        guard !targets.isEmpty else { return [] }
        return try stripTargets { entry in
            entry.relayURLs.filter { !targets.contains($0) }
        }
    }

    /// Drops one relay from every queued entry of the given event kinds. Used when a relay
    /// demonstrated it rejects a kind, so its targets stop holding those changes open.
    @discardableResult
    public func stripRelayTargets(
        _ relayURL: String,
        eventKinds: Set<Int>
    ) throws -> [NostrOutboxEntry] {
        guard let normalized = TaskifyRelayURL.normalize(relayURL), !eventKinds.isEmpty else {
            return []
        }
        return try stripTargets { entry in
            guard eventKinds.contains(entry.event.kind) else { return entry.relayURLs }
            return entry.relayURLs.filter { $0 != normalized }
        }
    }

    public func entry(eventID: String) -> NostrOutboxEntry? {
        entries.first { $0.event.id == eventID }
    }

    /// Shared target-stripping core: rewrites every entry's targets with `retaining`, completes
    /// entries left with no pending target, releases dependents, persists once.
    private func stripTargets(
        retaining: (NostrOutboxEntry) -> [String]
    ) throws -> [NostrOutboxEntry] {
        let previous = entries
        for index in entries.indices {
            let retained = retaining(entries[index])
            guard retained.count != entries[index].relayURLs.count else { continue }
            entries[index].relayURLs = retained
            let accepted = Set(entries[index].acceptedRelayURLs ?? [])
            entries[index].acceptedRelayURLs = retained.filter { accepted.contains($0) }
        }
        let completed = entries.filter { $0.pendingRelayURLs.isEmpty }
        let completedIDs = Set(completed.map(\.id))
        entries.removeAll { completedIDs.contains($0.id) }
        releaseDependents(of: completedIDs)
        if entries != previous {
            do { try persist() }
            catch { entries = previous; throw error }
        }
        return completed
    }

    public func removeEntries(boardLocalID: String) throws {
        let originalCount = entries.count
        entries.removeAll { $0.boardLocalID == boardLocalID }
        if entries.count != originalCount {
            try persist()
        }
    }

    private func persist() throws {
        deferredPersistTask?.cancel()
        deferredPersistTask = nil
        try persistToDisk()
    }

    private func releaseDependents(of eventIDs: Set<String>) {
        for index in entries.indices where entries[index].dependsOnEventID.map(eventIDs.contains) == true {
            entries[index].dependsOnEventID = nil
        }
    }

    private func scheduleDeferredPersist() {
        deferredPersistTask?.cancel()
        deferredPersistTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            await self?.persistDeferredChanges()
        }
    }

    private func persistDeferredChanges() {
        deferredPersistTask = nil
        try? persistToDisk()
    }

    private func persistToDisk() throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        // See `JSONTaskStore.save` — deterministic, but not indented for human reading.
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(entries).write(to: fileURL, options: .atomic)
    }
}

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
    /// Relays that refused this event outright (`blocked:`, `restricted:`, `invalid:`): when each
    /// may be tried again. The change stays queued, since it may be the only copy, but a refusing
    /// relay isn't sent it again on every reconnect. Optional for older outboxes.
    public var relayRejections: [String: RelayRejectionBackoff]?
    /// Queued by "Republish current snapshot": current state resent, not a new change. Nil only in
    /// outboxes written before the flag existed (see `limitRepublishedEntries`).
    public var isRepublish: Bool?

    public init(
        event: NostrEvent,
        relayURLs: [String],
        boardLocalID: String,
        taskID: String,
        queuedAt: Date = Date(),
        acceptedRelayURLs: [String]? = nil,
        acknowledgementPolicy: NostrOutboxAcknowledgementPolicy = .everyRelay,
        expiresAt: Date? = nil,
        dependsOnEventID: String? = nil,
        isRepublish: Bool = false
    ) {
        self.isRepublish = isRepublish
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

    /// Whether `relayURL` refused this event and its retry time hasn't come yet.
    public func isHeldBack(for relayURL: String, now: Date) -> Bool {
        guard let rejection = relayRejections?[relayURL] else { return false }
        return rejection.retryAfter > now
    }

    public var pendingRelayURLs: [String] {
        let accepted = Set(acceptedRelayURLs ?? [])
        return relayURLs.filter { !accepted.contains($0) }
    }

    public var effectiveAcknowledgementPolicy: NostrOutboxAcknowledgementPolicy {
        acknowledgementPolicy ?? .everyRelay
    }
}

public struct RelayRejectionBackoff: Codable, Equatable, Sendable {
    public var count: Int
    public var retryAfter: Date

    /// One hour after the first refusal, doubling each time, capped at a week.
    static func next(after previous: RelayRejectionBackoff?, now: Date) -> RelayRejectionBackoff {
        let count = (previous?.count ?? 0) + 1
        let delay = min(3600 * pow(2, Double(count - 1)), 7 * 24 * 3600)
        return RelayRejectionBackoff(count: count, retryAfter: now.addingTimeInterval(delay))
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
        excludingEventIDs: Set<String> = [],
        now: Date = Date()
    ) -> [NostrOutboxEntry] {
        entries
            .filter {
                !excludingEventIDs.contains($0.event.id) &&
                    $0.dependsOnEventID == nil &&
                    $0.pendingRelayURLs.contains(relayURL) &&
                    !$0.isHeldBack(for: relayURL, now: now)
            }
            .sorted {
                if $0.queuedAt != $1.queuedAt { return $0.queuedAt > $1.queuedAt }
                if $0.event.createdAt != $1.event.createdAt {
                    return $0.event.createdAt > $1.event.createdAt
                }
                return $0.event.id > $1.event.id
            }
    }

    /// Records that `relayURL` refused this event outright and returns when it may be tried
    /// again. The entry stays queued for that relay and every other one.
    @discardableResult
    public func recordRejection(eventID: String, relayURL: String, now: Date = Date()) throws -> Date? {
        guard let index = entries.firstIndex(where: { $0.event.id == eventID }) else { return nil }
        let previous = entries
        var rejections = entries[index].relayRejections ?? [:]
        let backoff = RelayRejectionBackoff.next(after: rejections[relayURL], now: now)
        rejections[relayURL] = backoff
        entries[index].relayRejections = rejections
        do { try persist() } catch { entries = previous; throw error }
        return backoff.retryAfter
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

    /// Queued events of `kind` still waiting on `relayURL` that nothing else waits on, oldest
    /// first: what the outbox audit can check against that relay.
    public func auditableEntries(for relayURL: String, kind: Int) -> [NostrOutboxEntry] {
        entries
            .filter { $0.event.kind == kind && $0.dependsOnEventID == nil && $0.pendingRelayURLs.contains(relayURL) }
            .sorted { $0.queuedAt < $1.queuedAt }
    }

    /// `markAccepted` for a whole batch in one pass and one write: the outbox audit settles a
    /// backlog thousands of entries long, where a scan per entry cost minutes on a phone. Returns
    /// the events it settled and the entries no relay still needs, which leave the outbox.
    public func settleDeliveries(
        eventIDs: Set<String>,
        relayURL: String
    ) throws -> (settledEventIDs: Set<String>, completed: [NostrOutboxEntry]) {
        guard !eventIDs.isEmpty else { return ([], []) }
        let previous = entries
        var settled = Set<String>()
        var completedIDs = Set<String>()
        for index in entries.indices where eventIDs.contains(entries[index].event.id) {
            guard entries[index].dependsOnEventID == nil,
                  entries[index].pendingRelayURLs.contains(relayURL) else { continue }
            var accepted = Set(entries[index].acceptedRelayURLs ?? [])
            accepted.insert(relayURL)
            entries[index].acceptedRelayURLs = entries[index].relayURLs.filter { accepted.contains($0) }
            settled.insert(entries[index].event.id)
            if entries[index].effectiveAcknowledgementPolicy == .anyRelay || entries[index].pendingRelayURLs.isEmpty {
                completedIDs.insert(entries[index].id)
            }
        }
        guard !settled.isEmpty else { return ([], []) }
        let completed = entries.filter { completedIDs.contains($0.id) }
        let hasDependents = !completedIDs.isEmpty && entries.contains {
            $0.dependsOnEventID.map(completedIDs.contains) == true
        }
        entries.removeAll { completedIDs.contains($0.id) }
        releaseDependents(of: completedIDs)
        if hasDependents {
            // As in `markAccepted`: released replies are committed before they can be published.
            do { try persist() }
            catch { entries = previous; throw error }
        } else { scheduleDeferredPersist() }
        return (settled, completed)
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

    /// Stops sending a board's republished entries anywhere but `keptRelayURLs` (Taskify's own
    /// relays). A republish resends current state that other devices already have, but an entry
    /// can still carry the only copy of an edit it replaced in the queue, so entries are narrowed
    /// rather than dropped: they still reach a kept relay, which every client reads. An entry that
    /// targets none of the kept relays is left untouched. Returns how many entries changed.
    ///
    /// Outboxes from before `isRepublish` existed can't say which entries a republish queued, so
    /// there a burst of at least `legacyBurstMinimum` entries for the board, queued no more than
    /// `legacyBurstGap` apart, counts: ordinary edits never queue that many at once.
    @discardableResult
    public func limitRepublishedEntries(
        boardLocalID: String,
        toRelays keptRelayURLs: Set<String>,
        legacyBurstMinimum: Int = 50,
        legacyBurstGap: TimeInterval = 0.5
    ) throws -> Int {
        let kept = Set(TaskifyRelayURL.normalizedList(Array(keptRelayURLs)))
        let legacyBurstIDs = Self.legacyBurstEventIDs(
            entries.filter { $0.boardLocalID == boardLocalID && $0.isRepublish == nil },
            minimum: legacyBurstMinimum,
            gap: legacyBurstGap
        )
        var changed = 0
        var completedIDs = Set<String>()
        for index in entries.indices where entries[index].boardLocalID == boardLocalID {
            let entry = entries[index]
            guard entry.isRepublish == true || legacyBurstIDs.contains(entry.event.id),
                  entry.relayURLs.contains(where: kept.contains) else { continue }
            let accepted = Set(entry.acceptedRelayURLs ?? [])
            let narrowed = entry.relayURLs.filter { kept.contains($0) || accepted.contains($0) }
            guard narrowed != entry.relayURLs else { continue }
            entries[index].relayURLs = narrowed
            entries[index].relayRejections = entry.relayRejections?.filter { narrowed.contains($0.key) }
            if entries[index].pendingRelayURLs.isEmpty { completedIDs.insert(entry.event.id) }
            changed += 1
        }
        guard changed > 0 else { return 0 }
        entries.removeAll { completedIDs.contains($0.event.id) }
        releaseDependents(of: completedIDs)
        try persist()
        return changed
    }

    private static func legacyBurstEventIDs(
        _ candidates: [NostrOutboxEntry],
        minimum: Int,
        gap: TimeInterval
    ) -> Set<String> {
        let sorted = candidates.sorted { $0.queuedAt < $1.queuedAt }
        var result = Set<String>()
        var run: [NostrOutboxEntry] = []
        func closeRun() {
            if run.count >= minimum { result.formUnion(run.map(\.event.id)) }
            run.removeAll()
        }
        for entry in sorted {
            if let last = run.last, entry.queuedAt.timeIntervalSince(last.queuedAt) > gap { closeRun() }
            run.append(entry)
        }
        closeRun()
        return result
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

    /// Completes deliveries to relays outside `reachable` — ones the engine no longer connects to,
    /// such as an inbox relay dropped from the account's list — for entries another relay has
    /// already accepted. Nothing will ever send those, and the change is stored elsewhere. An
    /// entry no relay has accepted keeps every target: it may be the only copy.
    public func completeUnreachableTargets(reachable: Set<String>) throws -> [NostrOutboxEntry] {
        try stripTargets { entry in
            let accepted = Set(entry.acceptedRelayURLs ?? [])
            guard !accepted.isEmpty else { return entry.relayURLs }
            return entry.relayURLs.filter { reachable.contains($0) || accepted.contains($0) }
        }
    }

    /// Swaps a queued event for an equivalent one — the same change re-mined to meet a relay's
    /// proof-of-work floor — keeping which relays already hold it. Replies waiting on the old
    /// event wait on the new one.
    public func replaceEvent(_ eventID: String, with replacement: NostrEvent) throws -> Bool {
        guard replacement.id != eventID,
              let index = entries.firstIndex(where: { $0.event.id == eventID }) else { return false }
        let previous = entries
        entries[index].event = replacement
        for dependent in entries.indices where entries[dependent].dependsOnEventID == eventID {
            entries[dependent].dependsOnEventID = replacement.id
        }
        do { try persist() }
        catch { entries = previous; throw error }
        return true
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

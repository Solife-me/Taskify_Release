import Foundation

/// Cross-device sync of per-account app state as encrypted, self-addressed kind-30078 events:
/// the Bible reading tracker, the scripture memory list and chat state (read markers plus
/// responses to shared items). Wire-compatible with the PWA, whose merge rules live in
/// `taskify-core/src/appStateSync.ts`; keep the two in step.
///
/// Bible tracker and scripture memory merge three ways against the last state this device
/// synced (its "base"), so an edit on either device survives and a removal is honored instead of
/// the last publisher overwriting the other. Conflicts resolve symmetrically so two devices
/// merging each other's copies converge. Chat state only moves forward, so it needs no base.
public enum AppStateSyncContract {
    public static let eventKind = 30_078
    public static let clientTag = "taskify.app"
    public static let bibleTrackerDTag = "taskify-bible-tracker"
    public static let scriptureMemoryDTag = "taskify-scripture-memory"
    public static let chatStateDTag = "taskify-chat-state"
    public static let dTags = [bibleTrackerDTag, scriptureMemoryDTag, chatStateDTag]

    public static func event(
        dTag: String,
        payload: some Encodable,
        identity: NostrIdentity,
        createdAt: Int,
        nonce: Data? = nil
    ) throws -> NostrEvent {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let content = try NIP44V2.encrypt(
            encoder.encode(payload),
            privateKey: identity.privateKey,
            publicKey: identity.publicKey,
            nonce: nonce
        )
        return try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: eventKind,
            tags: [["d", dTag], ["client", clientTag]],
            content: content
        )
    }

    /// The base to merge an incoming Bible tracker / scripture memory payload against. Senders
    /// publish `baseTimestamp` 0 when they have never synced (a fresh install, or relays
    /// unreachable on the first pull): their copy lacks everything they never saw, and those gaps
    /// must not be read as deletions. Older clients omit the field and merge as before.
    public static func sharedBase<T>(baseTimestamp: Int?, localBase: T?) -> T? {
        baseTimestamp == 0 ? nil : localBase
    }

    /// Verifies the event is this identity's own app-state event and returns its plaintext.
    public static func decrypt(event: NostrEvent, identity: NostrIdentity) throws -> (dTag: String, plaintext: Data) {
        guard event.kind == eventKind,
              event.publicKey.lowercased() == identity.publicKeyHex,
              let dTag = event.firstTagValue(named: "d"),
              dTags.contains(dTag),
              event.verify() else {
            throw NostrAppBackupError.invalidEvent
        }
        let plaintext = try NIP44V2.decrypt(
            event.content,
            privateKey: identity.privateKey,
            publicKey: identity.publicKey
        )
        return (dTag, plaintext)
    }
}

public struct BibleTrackerSyncPayload: Codable, Equatable, Sendable {
    public var version: Int
    public var timestamp: Int
    /// See `AppStateSyncContract.sharedBase`.
    public var baseTimestamp: Int?
    public var bibleTracker: BibleTrackerState

    public init(timestamp: Int, baseTimestamp: Int, bibleTracker: BibleTrackerState) {
        version = 1
        self.timestamp = timestamp
        self.baseTimestamp = baseTimestamp
        self.bibleTracker = bibleTracker
    }
}

public struct ScriptureMemorySyncPayload: Codable, Equatable, Sendable {
    public var version: Int
    public var timestamp: Int
    /// See `AppStateSyncContract.sharedBase`.
    public var baseTimestamp: Int?
    public var scriptureMemory: ScriptureMemoryState

    public init(timestamp: Int, baseTimestamp: Int, scriptureMemory: ScriptureMemoryState) {
        version = 1
        self.timestamp = timestamp
        self.baseTimestamp = baseTimestamp
        self.scriptureMemory = scriptureMemory
    }
}

// MARK: - Three-way merge primitives

enum AppStateMerge {
    /// Elements added on either side are kept; elements removed on either side are dropped.
    /// Without a base every element on either side is kept.
    static func mergeSet(base: [Int]?, local: [Int], remote: [Int]) -> [Int] {
        let baseSet = Set(base ?? [])
        let localSet = Set(local)
        let remoteSet = Set(remote)
        let kept = localSet.filter { remoteSet.contains($0) || !baseSet.contains($0) }
            .union(remoteSet.filter { localSet.contains($0) || !baseSet.contains($0) })
        return kept.sorted()
    }

    /// Keyed three-way merge, matching `mergeRecordThreeWay` in the PWA. `resolve` handles keys
    /// changed differently on both sides and must be symmetric.
    static func mergeRecord<V: Equatable>(
        base: [String: V]?,
        local: [String: V],
        remote: [String: V],
        resolve: (V, V) -> V
    ) -> [String: V] {
        var merged: [String: V] = [:]
        for key in Set(local.keys).union(remote.keys) {
            let l = local[key]
            let r = remote[key]
            let b = base?[key]
            if let l, let r {
                if l == r { merged[key] = l }
                else if let b, l == b { merged[key] = r }
                else if let b, r == b { merged[key] = l }
                else { merged[key] = resolve(l, r) }
                continue
            }
            guard let only = l ?? r else { continue }
            if let b, only == b { continue }
            merged[key] = only
        }
        return merged
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standardFormatter = ISO8601DateFormatter()
    private static let formatterLock = NSLock()

    /// Milliseconds since the epoch, or -infinity for a missing or unparsable timestamp (matching
    /// the PWA's `Date.parse` ordering).
    static func isoMillis(_ value: String?) -> Double {
        guard let value, !value.isEmpty else { return -.infinity }
        formatterLock.lock()
        defer { formatterLock.unlock() }
        guard let date = fractionalFormatter.date(from: value) ?? standardFormatter.date(from: value) else {
            return -.infinity
        }
        return (date.timeIntervalSince1970 * 1000).rounded()
    }

    /// A deterministic ordering for tie-breaks, so both devices pick the same value.
    static func stableKey(_ value: some Encodable) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

// MARK: - Scripture memory

public extension ScriptureMemoryState {
    /// Three-way merge of this device's list (`self`) with another device's.
    func merged(with remote: ScriptureMemoryState, base: ScriptureMemoryState?) -> ScriptureMemoryState {
        func byID(_ entries: [ScriptureMemoryEntry]) -> [String: ScriptureMemoryEntry] {
            var record: [String: ScriptureMemoryEntry] = [:]
            for entry in entries where !entry.id.isEmpty { record[entry.id] = entry }
            return record
        }
        let merged = AppStateMerge.mergeRecord(
            base: base.map { byID($0.entries) },
            local: byID(entries),
            remote: byID(remote.entries),
            resolve: Self.furtherReviewed
        )
        var ordered: [ScriptureMemoryEntry] = []
        var seen = Set<String>()
        for entry in entries + remote.entries {
            guard let next = merged[entry.id], seen.insert(entry.id).inserted else { continue }
            ordered.append(next)
        }
        let reviewTimes = [lastReviewISO, remote.lastReviewISO] + ordered.map(\.lastReviewISO)
        var latest: String?
        var latestTime = -Double.infinity
        for value in reviewTimes {
            let time = AppStateMerge.isoMillis(value)
            if time > latestTime {
                latestTime = time
                latest = value
            }
        }
        return ScriptureMemoryState(entries: ordered, lastReviewISO: latest)
    }

    /// Order-independent comparison of the synced content.
    func syncEquivalent(to other: ScriptureMemoryState) -> Bool {
        entries.sorted { $0.id < $1.id } == other.entries.sorted { $0.id < $1.id }
            && lastReviewISO == other.lastReviewISO
    }

    private static func furtherReviewed(_ a: ScriptureMemoryEntry, _ b: ScriptureMemoryEntry) -> ScriptureMemoryEntry {
        if a.totalReviews != b.totalReviews { return a.totalReviews > b.totalReviews ? a : b }
        let reviewA = AppStateMerge.isoMillis(a.lastReviewISO)
        let reviewB = AppStateMerge.isoMillis(b.lastReviewISO)
        if reviewA != reviewB { return reviewA > reviewB ? a : b }
        if a.stage != b.stage { return a.stage > b.stage ? a : b }
        let scheduledA = AppStateMerge.isoMillis(a.scheduledAtISO)
        let scheduledB = AppStateMerge.isoMillis(b.scheduledAtISO)
        if scheduledA != scheduledB { return scheduledA > scheduledB ? a : b }
        return AppStateMerge.stableKey(a) >= AppStateMerge.stableKey(b) ? a : b
    }
}

// MARK: - Bible tracker

public extension BibleTrackerState {
    /// Three-way merge of this device's tracker (`self`) with another device's.
    func merged(with remote: BibleTrackerState, base: BibleTrackerState?) -> BibleTrackerState {
        let mergedArchive = Self.mergeArchives(base: base?.archive, local: archive, remote: remote.archive)
        if lastResetISO != remote.lastResetISO {
            // One device reset since they last agreed: the newer reading cycle wins outright, and
            // the older cycle's progress lives on in the archive the reset wrote.
            let localTime = AppStateMerge.isoMillis(lastResetISO)
            let remoteTime = AppStateMerge.isoMillis(remote.lastResetISO)
            let remoteWins = remoteTime != localTime ? remoteTime > localTime : remote.lastResetISO > lastResetISO
            var winner = remoteWins ? remote : self
            winner.archive = mergedArchive
            return winner
        }
        // A base from an earlier reading cycle says nothing about this cycle's removals.
        let cycleBase = base?.lastResetISO == lastResetISO ? base : nil
        var progress: [String: [Int]] = [:]
        for book in Set(self.progress.keys).union(remote.progress.keys) {
            let chapters = AppStateMerge.mergeSet(
                base: cycleBase?.progress[book],
                local: self.progress[book] ?? [],
                remote: remote.progress[book] ?? []
            )
            if !chapters.isEmpty { progress[book] = chapters }
        }
        var verses: [String: [String: [Int]]] = [:]
        for book in Set(self.verses.keys).union(remote.verses.keys) {
            let l = self.verses[book] ?? [:]
            let r = remote.verses[book] ?? [:]
            var inner: [String: [Int]] = [:]
            for chapter in Set(l.keys).union(r.keys) {
                let values = AppStateMerge.mergeSet(
                    base: cycleBase?.verses[book]?[chapter],
                    local: l[chapter] ?? [],
                    remote: r[chapter] ?? []
                )
                if !values.isEmpty { inner[chapter] = values }
            }
            if !inner.isEmpty { verses[book] = inner }
        }
        var verseCounts: [String: [String: Int]] = [:]
        for book in Set(self.verseCounts.keys).union(remote.verseCounts.keys) {
            let inner = AppStateMerge.mergeRecord(
                base: cycleBase?.verseCounts[book],
                local: self.verseCounts[book] ?? [:],
                remote: remote.verseCounts[book] ?? [:],
                resolve: max
            )
            if !inner.isEmpty { verseCounts[book] = inner }
        }
        let completedBooks = AppStateMerge.mergeRecord(
            base: cycleBase?.completedBooks,
            local: self.completedBooks,
            remote: remote.completedBooks
        ) { a, b in
            AppStateMerge.isoMillis(a.completedAtISO) <= AppStateMerge.isoMillis(b.completedAtISO) ? a : b
        }
        return BibleTrackerState(
            lastResetISO: lastResetISO,
            progress: progress,
            archive: mergedArchive,
            verses: verses,
            verseCounts: verseCounts,
            completedBooks: completedBooks
        )
    }

    /// Order-independent comparison of the synced content.
    func syncEquivalent(to other: BibleTrackerState) -> Bool {
        var lhs = self
        var rhs = other
        lhs.archive.sort { $0.id < $1.id }
        rhs.archive.sort { $0.id < $1.id }
        return lhs == rhs
    }

    private static func mergeArchives(
        base: [BibleTrackerArchiveEntry]?,
        local: [BibleTrackerArchiveEntry],
        remote: [BibleTrackerArchiveEntry]
    ) -> [BibleTrackerArchiveEntry] {
        func byID(_ entries: [BibleTrackerArchiveEntry]) -> [String: BibleTrackerArchiveEntry] {
            Dictionary(entries.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
        let merged = AppStateMerge.mergeRecord(
            base: base.map(byID),
            local: byID(local),
            remote: byID(remote)
        ) { a, b in AppStateMerge.stableKey(a) >= AppStateMerge.stableKey(b) ? a : b }
        return merged.values.sorted {
            let lhs = AppStateMerge.isoMillis($0.savedAtISO)
            let rhs = AppStateMerge.isoMillis($1.savedAtISO)
            if lhs != rhs { return lhs > rhs }
            return $0.id < $1.id
        }
    }
}

// MARK: - Chat state

public enum ChatInboxResponseStatus: String, Codable, Sendable {
    case accepted
    case declined
    case tentative
    case deleted

    public init?(_ status: SharedInboxItemStatus) {
        switch status {
        case .accepted: self = .accepted
        case .declined: self = .declined
        case .tentative: self = .tentative
        case .deleted: self = .deleted
        case .pending: return nil
        }
    }

    public var sharedInboxStatus: SharedInboxItemStatus {
        switch self {
        case .accepted: .accepted
        case .declined: .declined
        case .tentative: .tentative
        case .deleted: .deleted
        }
    }
}

public struct ChatInboxResponse: Codable, Equatable, Sendable {
    public var status: ChatInboxResponseStatus
    /// Unix seconds when the response was made.
    public var at: Int

    public init(status: ChatInboxResponseStatus, at: Int) {
        self.status = status
        self.at = at
    }

    /// Later response wins; a tie breaks on the status name, as in the PWA.
    static func pick(_ a: ChatInboxResponse, _ b: ChatInboxResponse) -> ChatInboxResponse {
        if a.at != b.at { return a.at > b.at ? a : b }
        return a.status.rawValue >= b.status.rawValue ? a : b
    }
}

public struct ChatSyncState: Codable, Equatable, Sendable {
    /// Conversation key (lowercased peer pubkey or group id) -> read-through Unix seconds.
    public var readThrough: [String: Int]
    /// Shared-item gift-wrap event id -> the response given on some device.
    public var inboxResponses: [String: ChatInboxResponse]

    public init(readThrough: [String: Int] = [:], inboxResponses: [String: ChatInboxResponse] = [:]) {
        self.readThrough = readThrough
        self.inboxResponses = inboxResponses
    }

    private enum CodingKeys: String, CodingKey { case readThrough, inboxResponses }
    private struct LossyResponse: Decodable {
        let status: String?
        let at: Double?
    }

    /// Lenient like the PWA's `sanitizeChatSyncState`: keys are lowercased and entries this
    /// build does not understand are skipped instead of failing the whole payload.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawRead = (try? container.decodeIfPresent([String: Double].self, forKey: .readThrough)) ?? nil
        let rawResponses = (try? container.decodeIfPresent([String: LossyResponse].self, forKey: .inboxResponses)) ?? nil
        var readThrough: [String: Int] = [:]
        for (key, value) in rawRead ?? [:] {
            let normalized = key.trimmingCharacters(in: .whitespaces).lowercased()
            guard !normalized.isEmpty, value.isFinite, value > 0 else { continue }
            readThrough[normalized] = max(readThrough[normalized] ?? 0, Int(value))
        }
        var responses: [String: ChatInboxResponse] = [:]
        for (key, value) in rawResponses ?? [:] {
            let normalized = key.trimmingCharacters(in: .whitespaces).lowercased()
            guard !normalized.isEmpty,
                  let status = value.status.flatMap(ChatInboxResponseStatus.init(rawValue:)) else { continue }
            let at = value.at.map { $0.isFinite ? max(0, Int($0)) : 0 } ?? 0
            let response = ChatInboxResponse(status: status, at: at)
            responses[normalized] = responses[normalized].map { ChatInboxResponse.pick($0, response) } ?? response
        }
        self.readThrough = readThrough
        self.inboxResponses = responses
    }

    public func merged(with other: ChatSyncState) -> ChatSyncState {
        var merged = self
        for (key, seconds) in other.readThrough {
            merged.readThrough[key] = max(merged.readThrough[key] ?? 0, seconds)
        }
        for (key, response) in other.inboxResponses {
            merged.inboxResponses[key] = merged.inboxResponses[key].map { ChatInboxResponse.pick($0, response) } ?? response
        }
        return merged
    }

    /// True when merging `local` in would change nothing, i.e. there is nothing to publish.
    public func covers(_ local: ChatSyncState) -> Bool {
        for (key, seconds) in local.readThrough where (readThrough[key] ?? 0) < seconds {
            return false
        }
        for (key, response) in local.inboxResponses {
            guard let existing = inboxResponses[key],
                  ChatInboxResponse.pick(existing, response) == existing else { return false }
        }
        return true
    }

    /// The payload's plaintext ceiling, matching the PWA's `CHAT_SYNC_MAX_PLAINTEXT_BYTES`.
    /// NIP-44 refuses plaintext over 65,535 bytes and common relays reject events over 64 KB;
    /// encryption plus base64 grows the content by about a third.
    public static let maxPlaintextBytes = 32 * 1024

    /// Drops entries older than `maxAge`, keeps the newest `maxEntries` of each map, then drops
    /// the oldest remaining entries until the payload fits `maxBytes`, matching the PWA's
    /// `pruneChatSyncState`.
    public func pruned(
        nowSeconds: Int,
        maxAgeSeconds: Int = 180 * 24 * 60 * 60,
        maxEntries: Int = 1000,
        maxBytes: Int = ChatSyncState.maxPlaintextBytes
    ) -> ChatSyncState {
        let cutoff = nowSeconds - maxAgeSeconds
        enum Value { case read(Int), response(ChatInboxResponse) }
        struct Entry { let key: String; let time: Int; let value: Value }
        func newest(_ entries: [Entry]) -> [Entry] {
            Array(entries.filter { $0.time >= cutoff }
                .sorted { $0.time != $1.time ? $0.time > $1.time : $0.key < $1.key }
                .prefix(maxEntries))
        }
        let entries = (
            newest(readThrough.map { Entry(key: $0.key, time: $0.value, value: .read($0.value)) })
                + newest(inboxResponses.map { Entry(key: $0.key, time: $0.value.at, value: .response($0.value)) })
        ).sorted { $0.time != $1.time ? $0.time > $1.time : $0.key < $1.key }
        func build(_ count: Int) -> ChatSyncState {
            var result = ChatSyncState()
            for entry in entries.prefix(count) {
                switch entry.value {
                case .read(let seconds): result.readThrough[entry.key] = seconds
                case .response(let response): result.inboxResponses[entry.key] = response
                }
            }
            return result
        }
        // Room for the payload's version and timestamp fields.
        let envelopeBytes = 64
        func fits(_ count: Int) -> Bool {
            ((try? JSONEncoder().encode(build(count)))?.count ?? .max) + envelopeBytes <= maxBytes
        }
        if fits(entries.count) { return build(entries.count) }
        var low = 0
        var high = entries.count
        while low < high {
            let mid = (low + high + 1) / 2
            if fits(mid) { low = mid } else { high = mid - 1 }
        }
        return build(low)
    }

    /// The state to publish when merging `local` into what the relays hold (`self`) would change
    /// the published, pruned state; nil when there is nothing to publish. Entries pruning would
    /// drop never count as unpublished, so they cannot cause a republish loop.
    public func toPublish(merging local: ChatSyncState, nowSeconds: Int) -> ChatSyncState? {
        guard !covers(local) else { return nil }
        let next = merged(with: local).pruned(nowSeconds: nowSeconds)
        return next == self ? nil : next
    }
}

public struct ChatStateSyncPayload: Codable, Equatable, Sendable {
    public var version: Int
    public var timestamp: Int
    public var readThrough: [String: Int]
    public var inboxResponses: [String: ChatInboxResponse]

    public init(timestamp: Int, state: ChatSyncState) {
        version = 1
        self.timestamp = timestamp
        readThrough = state.readThrough
        inboxResponses = state.inboxResponses
    }

    public var state: ChatSyncState {
        ChatSyncState(readThrough: readThrough, inboxResponses: inboxResponses)
    }

    private enum CodingKeys: String, CodingKey { case version, timestamp, readThrough, inboxResponses }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        timestamp = (try? container.decodeIfPresent(Int.self, forKey: .timestamp)) ?? 0
        let state = try ChatSyncState(from: decoder)
        readThrough = state.readThrough
        inboxResponses = state.inboxResponses
    }
}

// MARK: - Relay lookup

public enum AppStateSyncFinder {
    /// Fetches this identity's app-state events from every relay in one round trip per relay,
    /// newest first per d-tag. A silent relay is bounded by `timeout`.
    public static func findLatest(
        publicKey: String,
        relayURLs: [String],
        timeout: TimeInterval = 4
    ) async -> [String: NostrEvent] {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !publicKey.isEmpty, !relays.isEmpty else { return [:] }
        return await withTaskGroup(of: [NostrEvent].self) { group in
            for relayURL in relays {
                group.addTask { await fetch(publicKey: publicKey, relayURL: relayURL, timeout: timeout) }
            }
            var latest: [String: NostrEvent] = [:]
            for await events in group {
                for event in events {
                    guard let dTag = event.firstTagValue(named: "d") else { continue }
                    if let existing = latest[dTag],
                       existing.createdAt > event.createdAt
                        || (existing.createdAt == event.createdAt && existing.id <= event.id) {
                        continue
                    }
                    latest[dTag] = event
                }
            }
            return latest
        }
    }

    private static func fetch(publicKey: String, relayURL: String, timeout: TimeInterval) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let stream = connection.messages()
        let subscriptionID = "app-state-\(UUID().uuidString)"
        do {
            try await connection.connect()
            try await connection.subscribeToAppState(
                id: subscriptionID,
                authorPublicKey: publicKey,
                dTags: AppStateSyncContract.dTags
            )
        } catch {
            await connection.disconnect()
            return []
        }
        let events = await withTaskGroup(of: [NostrEvent]?.self) { group in
            group.addTask {
                var matches: [NostrEvent] = []
                for await message in stream {
                    guard !Task.isCancelled else { return matches }
                    switch message {
                    case .event(let receivedID, let event) where receivedID == subscriptionID:
                        guard event.kind == AppStateSyncContract.eventKind,
                              event.publicKey.lowercased() == publicKey.lowercased(),
                              let dTag = event.firstTagValue(named: "d"),
                              AppStateSyncContract.dTags.contains(dTag),
                              event.verify() else { continue }
                        matches.append(event)
                    case .endOfStoredEvents(let receivedID) where receivedID == subscriptionID:
                        return matches
                    case .closed(let receivedID, _) where receivedID == subscriptionID:
                        return matches
                    case .disconnected:
                        return matches
                    default:
                        continue
                    }
                }
                return matches
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(max(0.25, timeout) * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? []
        }
        try? await connection.closeSubscription(id: subscriptionID)
        await connection.disconnect()
        return events
    }
}

// MARK: - Snapshot bridge

public extension TaskifySnapshot {
    /// This device's side of the synced chat state.
    var chatSyncState: ChatSyncState {
        var readThrough: [String: Int] = [:]
        for (key, seconds) in directMessageReadAt ?? [:] where seconds > 0 {
            let normalized = key.lowercased()
            readThrough[normalized] = max(readThrough[normalized] ?? 0, seconds)
        }
        var responses: [String: ChatInboxResponse] = [:]
        func record(_ wrapEventID: String, _ status: SharedInboxItemStatus, _ respondedAt: Date?) {
            guard let synced = ChatInboxResponseStatus(status) else { return }
            responses[wrapEventID.lowercased()] = ChatInboxResponse(
                status: synced,
                at: respondedAt.map { Int($0.timeIntervalSince1970) } ?? 0
            )
        }
        for item in sharedInboxItems ?? [] { record(item.wrapEventID, item.status, item.respondedAt) }
        for item in sharedContactInboxItems ?? [] { record(item.wrapEventID, item.status, item.respondedAt) }
        for item in sharedBoardInboxItems ?? [] { record(item.wrapEventID, item.status, item.respondedAt) }
        for item in sharedCalendarInviteItems ?? [] { record(item.wrapEventID, item.status, item.respondedAt) }
        return ChatSyncState(readThrough: readThrough, inboxResponses: responses)
    }

    /// Advances read markers to those seen on another device. Returns whether anything moved.
    @discardableResult
    mutating func applySyncedReadThrough(_ readThrough: [String: Int]) -> Bool {
        var states = directMessageReadAt ?? [:]
        var changed = false
        for (key, seconds) in readThrough where seconds > (states[key] ?? 0) {
            states[key] = seconds
            changed = true
        }
        if changed { directMessageReadAt = states }
        return changed
    }

    /// Marks still-pending shared items answered because another device answered them. Only the
    /// record changes: adding the task, contact or board already happened on the device that
    /// answered and reaches this one through its own sync. Returns whether anything changed.
    @discardableResult
    mutating func applySyncedInboxResponses(_ responses: [String: ChatInboxResponse]) -> Bool {
        guard !responses.isEmpty else { return false }
        func apply<Item>(
            _ items: inout [Item]?,
            wrapEventID: KeyPath<Item, String>,
            status: WritableKeyPath<Item, SharedInboxItemStatus>,
            respondedAt: WritableKeyPath<Item, Date?>
        ) -> Bool {
            guard var list = items else { return false }
            var changed = false
            for index in list.indices where list[index][keyPath: status] == .pending {
                guard let response = responses[list[index][keyPath: wrapEventID].lowercased()] else { continue }
                list[index][keyPath: status] = response.status.sharedInboxStatus
                // The other device's time, so re-deriving this response reproduces it exactly.
                list[index][keyPath: respondedAt] = Date(timeIntervalSince1970: TimeInterval(response.at))
                changed = true
            }
            if changed { items = list }
            return changed
        }
        let tasks = apply(&sharedInboxItems, wrapEventID: \.wrapEventID, status: \.status, respondedAt: \.respondedAt)
        let contacts = apply(&sharedContactInboxItems, wrapEventID: \.wrapEventID, status: \.status, respondedAt: \.respondedAt)
        let boards = apply(&sharedBoardInboxItems, wrapEventID: \.wrapEventID, status: \.status, respondedAt: \.respondedAt)
        let invites = apply(&sharedCalendarInviteItems, wrapEventID: \.wrapEventID, status: \.status, respondedAt: \.respondedAt)
        return tasks || contacts || boards || invites
    }
}

// MARK: - Local bookkeeping

/// What this device last agreed on with its other devices, per synced record. Persisted so a
/// restart neither re-applies stale events nor republishes unchanged state.
public struct AppStateSyncLedger: Codable, Equatable, Sendable {
    public struct Entry<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
        public var lastEventID: String?
        public var lastTimestamp = 0
        /// The last state agreed with the other devices: the merge base for Bible tracker and
        /// scripture memory, and the newest known relay copy for chat state.
        public var synced: Value?

        public init() {}

        /// Our own echo, or older than what this device already has.
        public func isStale(eventID: String, createdAt: Int) -> Bool {
            eventID == lastEventID || createdAt < lastTimestamp
        }

        /// `baseTimestamp` to publish: 0 until this device has synced (see
        /// `AppStateSyncContract.sharedBase`).
        public var baseTimestamp: Int { synced == nil ? 0 : lastTimestamp }

        public mutating func record(eventID: String?, timestamp: Int, synced value: Value) {
            lastEventID = eventID
            lastTimestamp = max(lastTimestamp, timestamp)
            synced = value
        }

        /// A timestamp newer than anything this device has published or seen for the record.
        public func nextTimestamp(now: Date = Date()) -> Int {
            max(Int(now.timeIntervalSince1970), lastTimestamp + 1)
        }
    }

    public var publicKey: String?
    public var bibleTracker = Entry<BibleTrackerState>()
    public var scriptureMemory = Entry<ScriptureMemoryState>()
    public var chat = Entry<ChatSyncState>()

    public init(publicKey: String? = nil) {
        self.publicKey = publicKey
    }
}

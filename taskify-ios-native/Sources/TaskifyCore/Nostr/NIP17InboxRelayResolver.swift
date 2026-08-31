import Foundation

public struct NIP17DeliveryPlan: Equatable, Sendable {
    public let recipientRelayURLs: [String]
    public let senderRelayURLs: [String]

    public init(recipientRelayURLs: [String], senderRelayURLs: [String]) {
        self.recipientRelayURLs = recipientRelayURLs
        self.senderRelayURLs = senderRelayURLs
    }
}

/// NIP-17 requires a separate gift wrap for each receiver, delivered to that receiver's
/// advertised kind-10050 inbox relays. Recipients that have not advertised any inbox relays
/// fall back to the sender's discovery relays so DMs still reach them. In particular, the
/// sender's self-copy must not be copied to the other participant's inbox relays.
public enum NIP17RelayRouting {
    public static func deliveryPlan(
        recipientInboxRelayURLs: [String],
        senderInboxRelayURLs: [String]
    ) -> NIP17DeliveryPlan? {
        let recipientRelays = TaskifyRelayURL.normalizedList(recipientInboxRelayURLs)
        let senderRelays = TaskifyRelayURL.normalizedList(senderInboxRelayURLs)
        guard !recipientRelays.isEmpty, !senderRelays.isEmpty else { return nil }
        return NIP17DeliveryPlan(
            recipientRelayURLs: recipientRelays,
            senderRelayURLs: senderRelays
        )
    }
}

public enum NIP17InboxRelayPreference {
    public static let eventKind = 10_050

    public static func event(
        identity: NostrIdentity,
        relayURLs: [String],
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> NostrEvent {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !relays.isEmpty else { throw NostrEventError.invalidEvent }
        return try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: eventKind,
            tags: relays.map { ["relay", $0] },
            content: ""
        )
    }
}

enum NIP17InboxRelayCacheLookup: Equatable, Sendable {
    case fresh([String])
    case stale([String])
    case missing
}

struct NIP17ResolvedPreference: Sendable {
    let relayURLs: [String]
    let eventCreatedAt: Int?
}

actor NIP17InboxRelayPreferenceCache {
    static var defaultURL: URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return applicationSupport
            .appendingPathComponent("TaskifyNative", isDirectory: true)
            .appendingPathComponent("nip17-inbox-preferences.json", isDirectory: false)
    }

    private struct Entry: Codable, Sendable {
        let relayURLs: [String]
        let expiresAt: Date
        let discardAfter: Date
        let eventCreatedAt: Int?
    }

    private let fileURL: URL?
    private var entries: [String: Entry]
    private var inFlightFetches: [String: Task<NIP17ResolvedPreference, Never>] = [:]

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL
        if let fileURL,
           let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([String: Entry].self, from: data) {
            entries = decoded
        } else {
            entries = [:]
        }
    }

    func relayURLs(for recipientPublicKey: String, now: Date = Date()) -> [String]? {
        let key = recipientPublicKey.lowercased()
        guard let entry = entries[key] else { return nil }
        guard entry.expiresAt > now else {
            entries.removeValue(forKey: key)
            return nil
        }
        return entry.relayURLs
    }

    func lookup(
        for recipientPublicKey: String,
        now: Date = Date()
    ) -> NIP17InboxRelayCacheLookup {
        let key = recipientPublicKey.lowercased()
        guard let entry = entries[key] else { return .missing }
        guard entry.discardAfter > now else {
            entries.removeValue(forKey: key)
            persistSafely()
            return .missing
        }
        return entry.expiresAt > now
            ? .fresh(entry.relayURLs)
            : .stale(entry.relayURLs)
    }

    func fetchTask(
        for recipientPublicKey: String,
        operation: @escaping @Sendable () async -> NIP17ResolvedPreference
    ) -> Task<NIP17ResolvedPreference, Never> {
        let key = recipientPublicKey.lowercased()
        if let existing = inFlightFetches[key] { return existing }
        let task = Task { await operation() }
        inFlightFetches[key] = task
        return task
    }

    func store(
        _ relayURLs: [String],
        for recipientPublicKey: String,
        expiresAfter lifetime: TimeInterval,
        staleFor staleLifetime: TimeInterval = 0,
        eventCreatedAt: Int? = nil,
        now: Date = Date()
    ) {
        let key = recipientPublicKey.lowercased()
        let expiresAt = now.addingTimeInterval(max(0, lifetime))
        entries[key] = Entry(
            relayURLs: TaskifyRelayURL.normalizedList(relayURLs),
            expiresAt: expiresAt,
            discardAfter: expiresAt.addingTimeInterval(max(0, staleLifetime)),
            eventCreatedAt: eventCreatedAt
        )
        inFlightFetches.removeValue(forKey: key)
        persistSafely()
    }

    private func persistSafely() {
        guard let fileURL else { return }
        do {
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(entries).write(to: fileURL, options: .atomic)
        } catch {
            // Relay preferences are a performance cache. Delivery still has recipient-specific
            // fallback relays when the cache cannot be persisted.
        }
    }
}

public enum NIP17InboxRelayResolver {
    public static let preferenceEventKind = NIP17InboxRelayPreference.eventKind
    private static let preferenceCache = NIP17InboxRelayPreferenceCache(
        fileURL: NIP17InboxRelayPreferenceCache.defaultURL
    )
    private static let positiveCacheLifetime: TimeInterval = 10 * 60
    private static let negativeCacheLifetime: TimeInterval = 90
    private static let positiveStaleLifetime: TimeInterval = 30 * 24 * 60 * 60
    private static let negativeStaleLifetime: TimeInterval = 10 * 60

    public static func relayURLs(
        from events: [NostrEvent],
        recipientPublicKey: String
    ) -> [String] {
        let normalizedRecipient = recipientPublicKey.lowercased()
        guard let latest = events
            .filter({
                $0.kind == preferenceEventKind &&
                    $0.publicKey.lowercased() == normalizedRecipient &&
                    $0.verify()
            })
            .max(by: { $0.createdAt < $1.createdAt }) else { return [] }
        return TaskifyRelayURL.normalizedList(latest.tags.compactMap { tag in
            guard tag.count >= 2, tag[0] == "relay" else { return nil }
            return tag[1]
        })
    }

    /// Resolves the relays to deliver a NIP-17 gift wrap to. Prefers the recipient's advertised
    /// kind-10050 inbox relays and falls back to `discoveryRelayURLs` — which therefore double as
    /// the delivery fallback — when the recipient has advertised none.
    public static func resolve(
        recipientPublicKey: String,
        discoveryRelayURLs: [String],
        timeout: Duration = .seconds(2)
    ) async -> [String] {
        let fallback = TaskifyRelayURL.normalizedList(discoveryRelayURLs)
        guard NostrPublicKey.parse(recipientPublicKey) != nil, !fallback.isEmpty else {
            return fallback
        }

        let normalizedRecipient = recipientPublicKey.lowercased()
        switch await preferenceCache.lookup(for: normalizedRecipient) {
        case .fresh(let cached):
            return deliveryRelayURLs(
                advertisedRelayURLs: cached,
                fallbackRelayURLs: fallback
            )
        case .stale(let cached):
            refreshInBackground(
                recipientPublicKey: normalizedRecipient,
                discoveryRelayURLs: fallback,
                timeout: timeout
            )
            return deliveryRelayURLs(
                advertisedRelayURLs: cached,
                fallbackRelayURLs: fallback
            )
        case .missing:
            break
        }

        let discovered = await fetchAndCache(
            recipientPublicKey: normalizedRecipient,
            discoveryRelayURLs: fallback,
            timeout: timeout
        )
        return deliveryRelayURLs(
            advertisedRelayURLs: discovered,
            fallbackRelayURLs: fallback
        )
    }

    public static func deliveryRelayURLs(
        advertisedRelayURLs: [String],
        fallbackRelayURLs: [String]
    ) -> [String] {
        let advertised = TaskifyRelayURL.normalizedList(advertisedRelayURLs)
        if !advertised.isEmpty { return advertised }
        return TaskifyRelayURL.normalizedList(fallbackRelayURLs)
    }

    /// Resolves only the inbox relays the recipient has actually advertised via kind-10050,
    /// without any delivery fallback. Used for self-discovery, where an empty result means
    /// "no signed preference published yet" and must trigger bootstrapping.
    public static func resolveAdvertised(
        recipientPublicKey: String,
        discoveryRelayURLs: [String],
        timeout: Duration = .seconds(2)
    ) async -> [String] {
        let discoveryRelays = TaskifyRelayURL.normalizedList(discoveryRelayURLs)
        guard NostrPublicKey.parse(recipientPublicKey) != nil,
              !discoveryRelays.isEmpty else { return [] }

        let normalizedRecipient = recipientPublicKey.lowercased()
        switch await preferenceCache.lookup(for: normalizedRecipient) {
        case .fresh(let cached):
            return cached
        case .stale(let cached):
            refreshInBackground(
                recipientPublicKey: normalizedRecipient,
                discoveryRelayURLs: discoveryRelays,
                timeout: timeout
            )
            return cached
        case .missing:
            break
        }

        return await fetchAndCache(
            recipientPublicKey: normalizedRecipient,
            discoveryRelayURLs: discoveryRelays,
            timeout: timeout
        )
    }

    private static func fetchAndCache(
        recipientPublicKey: String,
        discoveryRelayURLs: [String],
        timeout: Duration
    ) async -> [String] {
        let discoveryRelays = TaskifyRelayURL.normalizedList(discoveryRelayURLs)
        let fetchTask = await preferenceCache.fetchTask(for: recipientPublicKey) {
            let events = await withTaskGroup(of: [NostrEvent].self) { group in
                for relayURL in discoveryRelays {
                    group.addTask {
                        await fetchPreferenceEvents(
                            relayURL: relayURL,
                            recipientPublicKey: recipientPublicKey,
                            timeout: timeout
                        )
                    }
                }
                var collected: [NostrEvent] = []
                for await relayEvents in group { collected.append(contentsOf: relayEvents) }
                return collected
            }
            let relayURLs = relayURLs(from: events, recipientPublicKey: recipientPublicKey)
            let latestCreatedAt = events
                .filter {
                    $0.kind == preferenceEventKind &&
                        $0.publicKey.lowercased() == recipientPublicKey &&
                        $0.verify()
                }
                .map(\.createdAt)
                .max()
            return NIP17ResolvedPreference(
                relayURLs: relayURLs,
                eventCreatedAt: latestCreatedAt
            )
        }
        let discovered = await fetchTask.value
        await preferenceCache.store(
            discovered.relayURLs,
            for: recipientPublicKey,
            expiresAfter: discovered.relayURLs.isEmpty
                ? negativeCacheLifetime
                : positiveCacheLifetime,
            staleFor: discovered.relayURLs.isEmpty
                ? negativeStaleLifetime
                : positiveStaleLifetime,
            eventCreatedAt: discovered.eventCreatedAt
        )
        return discovered.relayURLs
    }

    private static func refreshInBackground(
        recipientPublicKey: String,
        discoveryRelayURLs: [String],
        timeout: Duration
    ) {
        Task {
            _ = await fetchAndCache(
                recipientPublicKey: recipientPublicKey,
                discoveryRelayURLs: discoveryRelayURLs,
                timeout: timeout
            )
        }
    }

    private static func fetchPreferenceEvents(
        relayURL: String,
        recipientPublicKey: String,
        timeout: Duration
    ) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let subscriptionID = "taskify-nip17-relays-\(UUID().uuidString)"
        let stream = connection.messages()
        let result = await withTaskGroup(of: [NostrEvent].self) { group in
            group.addTask {
                do {
                    try await connection.connect()
                    try await connection.subscribeToNIP17InboxRelayPreferences(
                        id: subscriptionID,
                        authorPublicKey: recipientPublicKey
                    )
                } catch {
                    return []
                }
                var events: [NostrEvent] = []
                for await message in stream {
                    if Task.isCancelled { return events }
                    switch message {
                    case .event(let id, let event) where id == subscriptionID:
                        events.append(event)
                    case .endOfStoredEvents(let id) where id == subscriptionID:
                        return events
                    case .closed(let id, _) where id == subscriptionID:
                        return events
                    case .disconnected:
                        return events
                    default:
                        continue
                    }
                }
                return events
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return []
            }
            let first = await group.next() ?? []
            group.cancelAll()
            return first
        }
        try? await connection.closeSubscription(id: subscriptionID)
        await connection.disconnect()
        return result
    }
}

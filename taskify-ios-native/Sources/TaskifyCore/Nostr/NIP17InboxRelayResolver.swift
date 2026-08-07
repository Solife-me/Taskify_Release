import Foundation

actor NIP17InboxRelayPreferenceCache {
    private struct Entry: Sendable {
        let relayURLs: [String]
        let expiresAt: Date
    }

    private var entries: [String: Entry] = [:]
    private var inFlightFetches: [String: Task<[String], Never>] = [:]

    func relayURLs(for recipientPublicKey: String, now: Date = Date()) -> [String]? {
        let key = recipientPublicKey.lowercased()
        guard let entry = entries[key] else { return nil }
        guard entry.expiresAt > now else {
            entries.removeValue(forKey: key)
            return nil
        }
        return entry.relayURLs
    }

    func fetchTask(
        for recipientPublicKey: String,
        operation: @escaping @Sendable () async -> [String]
    ) -> Task<[String], Never> {
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
        now: Date = Date()
    ) {
        let key = recipientPublicKey.lowercased()
        entries[key] = Entry(
            relayURLs: TaskifyRelayURL.normalizedList(relayURLs),
            expiresAt: now.addingTimeInterval(max(0, lifetime))
        )
        inFlightFetches.removeValue(forKey: key)
    }
}

public enum NIP17InboxRelayResolver {
    public static let preferenceEventKind = 10_050
    private static let preferenceCache = NIP17InboxRelayPreferenceCache()
    private static let positiveCacheLifetime: TimeInterval = 10 * 60
    private static let negativeCacheLifetime: TimeInterval = 90

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

    public static func resolve(
        recipientPublicKey: String,
        fallbackRelayURLs: [String],
        timeout: Duration = .seconds(2)
    ) async -> [String] {
        let fallback = TaskifyRelayURL.normalizedList(fallbackRelayURLs)
        guard NostrPublicKey.parse(recipientPublicKey) != nil, !fallback.isEmpty else {
            return fallback
        }

        let normalizedRecipient = recipientPublicKey.lowercased()
        if let cached = await preferenceCache.relayURLs(for: normalizedRecipient) {
            return TaskifyRelayURL.normalizedList(cached + fallback)
        }

        let fetchTask = await preferenceCache.fetchTask(for: normalizedRecipient) {
            let events = await withTaskGroup(of: [NostrEvent].self) { group in
                for relayURL in fallback {
                    group.addTask {
                        await fetchPreferenceEvents(
                            relayURL: relayURL,
                            recipientPublicKey: normalizedRecipient,
                            timeout: timeout
                        )
                    }
                }
                var collected: [NostrEvent] = []
                for await relayEvents in group { collected.append(contentsOf: relayEvents) }
                return collected
            }
            return relayURLs(from: events, recipientPublicKey: normalizedRecipient)
        }
        let discovered = await fetchTask.value
        await preferenceCache.store(
            discovered,
            for: normalizedRecipient,
            expiresAfter: discovered.isEmpty ? negativeCacheLifetime : positiveCacheLifetime
        )
        return TaskifyRelayURL.normalizedList(
            discovered + fallback
        )
    }

    private static func fetchPreferenceEvents(
        relayURL: String,
        recipientPublicKey: String,
        timeout: Duration
    ) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let subscriptionID = "taskify-nip17-relays-\(UUID().uuidString)"
        let stream = connection.messages()
        do {
            try await connection.connect()
            try await connection.subscribeToNIP17InboxRelayPreferences(
                id: subscriptionID,
                authorPublicKey: recipientPublicKey
            )
        } catch {
            await connection.disconnect()
            return []
        }

        let result = await withTaskGroup(of: [NostrEvent].self) { group in
            group.addTask {
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

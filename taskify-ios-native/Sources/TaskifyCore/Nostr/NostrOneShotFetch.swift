import Foundation

/// A single NIP-01 filter for a one-shot lookup (REQ until EOSE, then CLOSE).
public struct NostrRelayFilter: Equatable, Sendable {
    public var kinds: [Int]
    public var authors: [String]
    public var dTags: [String]?
    public var limit: Int
    public var since: Int?

    public init(kinds: [Int], authors: [String], dTags: [String]? = nil, limit: Int, since: Int? = nil) {
        self.kinds = kinds
        self.authors = authors
        self.dTags = dTags
        self.limit = limit
        self.since = since
    }

    public func jsonObject() -> [String: Any] {
        var object: [String: Any] = ["kinds": kinds, "authors": authors, "limit": limit]
        if let dTags { object["#d"] = dTags }
        if let since { object["since"] = since }
        return object
    }
}

/// Runs one-shot lookups against relays. `TaskSyncEngine` implements this over its open
/// connections, so a lookup doesn't open a fresh socket to a relay it is already connected to;
/// `NostrFreshConnectionFetcher` connects per relay and is used for everything else.
public protocol NostrOneShotFetching: Sendable {
    /// Events from every relay, unverified and possibly duplicated across relays. A silent relay
    /// is bounded by `timeout` and never holds up the others.
    func fetchOnce(filter: NostrRelayFilter, relayURLs: [String], timeout: TimeInterval) async -> [NostrEvent]
}

public struct NostrFreshConnectionFetcher: NostrOneShotFetching {
    public init() {}

    public func fetchOnce(filter: NostrRelayFilter, relayURLs: [String], timeout: TimeInterval) async -> [NostrEvent] {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !relays.isEmpty else { return [] }
        return await withTaskGroup(of: [NostrEvent].self) { group in
            for relayURL in relays {
                group.addTask { await Self.fetch(filter: filter, relayURL: relayURL, timeout: timeout) }
            }
            var events: [NostrEvent] = []
            for await batch in group { events.append(contentsOf: batch) }
            return events
        }
    }

    private static func fetch(filter: NostrRelayFilter, relayURL: String, timeout: TimeInterval) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let stream = connection.messages()
        let subscriptionID = "once-\(UUID().uuidString)"
        do {
            try await connection.connect()
            try await connection.request(id: subscriptionID, filter: filter)
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

extension Duration {
    var seconds: TimeInterval {
        let parts = components
        return TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18
    }
}

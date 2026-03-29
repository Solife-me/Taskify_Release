/// RelayPool.swift
/// WebSocket relay pool — mirrors RuntimeNostrSession architecture from the PWA.
///
/// Key design decisions matching taskify-runtime-nostr/src/RuntimeNostrSession.ts:
/// - Actor-isolated: all state mutations are serialized
/// - Exponential backoff reconnect per relay (mirrors scheduleRelayConnect)
/// - Subscription deduplication via stable filter key (mirrors SubscriptionManager)
/// - Event batch flush on EOSE before firing onEose (mirrors SubscriptionManager EOSE drain)
/// - CursorStore: per-filter since cursor advanced on every received event
/// - EventCache: deduplication ring buffer (mirrors EventCache.ts)
///
/// Primal-informed additions (patterns only, no GPL code):
/// - `atLeastOneConnected()` — mirrors Primal RelayPool.atLeastOneConnected @Published
/// - `connectionSummary()` — structured label for UI (e.g. "2/4 relays")
/// - Conforms to RelayPoolProtocol so RelayConnection can be mock-tested

import Foundation

// MARK: - ConnectionSummary

/// Structured relay connection state for UI consumption.
/// Mirrors Primal's `numOfConnected` / `atLeastOneConnected` @Published pattern.
public struct ConnectionSummary: Sendable, Equatable {
    public let connected: Int
    public let total: Int
    public var label: String { "\(connected)/\(total) relays" }
    public var hasAny: Bool { connected > 0 }
}

// MARK: - RelayPool

public actor RelayPool: RelayPoolProtocol {

    // MARK: Dependencies injected at init

    private let relayURLs: [String]
    private let onConnectionSummaryChange: (@Sendable (ConnectionSummary) -> Void)?
    private let onPermanentFailure: (@Sendable (String, NSError?) -> Void)?

    // MARK: State

    private var connections: [String: RelayConnection] = [:]
    private var subscriptions: [String: SubscriptionState] = [:]
    private var cursorStore = CursorStore()
    private var eventCache = EventCache()

    public init(
        relayURLs: [String],
        onConnectionSummaryChange: (@Sendable (ConnectionSummary) -> Void)? = nil,
        onPermanentFailure: (@Sendable (String, NSError?) -> Void)? = nil
    ) {
        self.relayURLs = relayURLs
        self.onConnectionSummaryChange = onConnectionSummaryChange
        self.onPermanentFailure = onPermanentFailure
    }

    // MARK: Connect

    public func connect() async {
        for url in relayURLs {
            guard connections[url] == nil else { continue }
            let conn = RelayConnection(url: url, pool: self)
            connections[url] = conn
            await conn.connect()
        }
        await publishConnectionSummary()
    }

    public func disconnect() async {
        for (_, conn) in connections { await conn.disconnect(notifyPool: false) }
        connections.removeAll()
        subscriptions.removeAll()
        await publishConnectionSummary()
    }

    public func connectedCount() async -> Int {
        var count = 0
        for (_, conn) in connections {
            if await conn.connected() { count += 1 }
        }
        return count
    }

    public func relayStatuses() async -> [(url: String, connected: Bool)] {
        var statuses: [(url: String, connected: Bool)] = []
        for (url, conn) in connections {
            statuses.append((url: url, connected: await conn.connected()))
        }
        // Include configured relays that haven't connected yet (no RelayConnection created yet)
        for url in relayURLs where connections[url] == nil {
            statuses.append((url: url, connected: false))
        }
        return statuses
    }

    /// Returns true if at least one relay is currently connected.
    /// Mirrors Primal's `atLeastOneConnected` @Published property.
    public func atLeastOneConnected() async -> Bool {
        for (_, conn) in connections {
            if await conn.connected() { return true }
        }
        return false
    }

    /// Returns a structured summary of relay connection state for UI.
    /// e.g. `ConnectionSummary(connected: 2, total: 4)` → "2/4 relays"
    public func connectionSummary() async -> ConnectionSummary {
        let total = relayURLs.count
        var connected = 0
        for (_, conn) in connections {
            if await conn.connected() { connected += 1 }
        }
        return ConnectionSummary(connected: connected, total: total)
    }

    public func relayDidConnect(url: String) async {
        guard let connection = connections[url] else { return }
        for state in subscriptions.values {
            let req = buildREQ(id: state.key, filters: state.filters)
            await connection.send(req)
        }
        await publishConnectionSummary()
    }

    public func relayDidDisconnect(url _: String) async {
        await publishConnectionSummary()
    }

    public func relayDidFailPermanently(url: String, error: NSError?) async {
        onPermanentFailure?(url, error)
    }

    // MARK: Subscribe

    /// Opens a subscription on all connected relays and returns a managed handle.
    /// Mirrors SubscriptionManager.subscribe() — deduplicates by stable filter key.
    public func subscribe(
        filters: [[String: Any]],
        onEvent: @escaping (NostrEvent, String?) -> Void,
        onEose: @escaping (String?) -> Void
    ) -> String {
        let key = subscriptionKey(filters: filters)
        if subscriptions[key] != nil {
            subscriptions[key]?.refCount += 1
            return key
        }

        let state = SubscriptionState(
            key: key,
            filters: filters,
            onEvent: onEvent,
            onEose: onEose
        )
        subscriptions[key] = state

        let req = buildREQ(id: key, filters: filters)
        for (_, conn) in connections {
            Task { await conn.send(req) }
        }
        return key
    }

    /// Releases a subscription. Stops it when refCount drops to zero.
    public func unsubscribe(key: String) {
        guard var state = subscriptions[key] else { return }
        state.refCount -= 1
        if state.refCount <= 0 {
            subscriptions.removeValue(forKey: key)
            let close = buildCLOSE(id: key)
            for (_, conn) in connections {
                Task { await conn.send(close) }
            }
        } else {
            subscriptions[key] = state
        }
    }

    // MARK: Publish

    public func publish(event: NostrEvent) async {
        let msg = buildEVENT(event: event)
        for (_, conn) in connections { await conn.send(msg) }
    }

    // MARK: Fetch (one-shot)

    /// One-shot fetch with EOSE + inactivity settle — mirrors RuntimeNostrSession.fetchEvents().
    /// Timeouts (ms): hardTimeout=8000, eoseGrace=200, inactivity=1500
    public func fetchEvents(
        filters: [[String: Any]],
        hardTimeoutMs: Int = 8_000,
        eoseGraceMs: Int = 200,
        inactivityMs: Int = 1_500
    ) async -> [NostrEvent] {
        let subId = "fetch-\(UUID().uuidString.prefix(8))"
        let req = buildREQ(id: subId, filters: filters)

        return await withCheckedContinuation { continuation in
            var collected: [NostrEvent] = []
            var pendingEvents: [NostrEvent] = []
            var settled = false
            var firstEvent = false
            var graceTimer: Task<Void, Never>? = nil
            var inactivityTimer: Task<Void, Never>? = nil

            let settle: () -> Void = {
                guard !settled else { return }
                settled = true
                graceTimer?.cancel()
                inactivityTimer?.cancel()
                let close = self.buildCLOSE(id: subId)
                for (_, conn) in self.connections {
                    Task { await conn.send(close) }
                }
                self.subscriptions.removeValue(forKey: subId)
                continuation.resume(returning: collected)
            }

            let startGrace: () -> Void = {
                guard !settled, graceTimer == nil else { return }
                inactivityTimer?.cancel()
                inactivityTimer = nil
                graceTimer = Task {
                    try? await Task.sleep(nanoseconds: UInt64(eoseGraceMs) * 1_000_000)
                    if !Task.isCancelled { settle() }
                }
            }

            let resetInactivity: () -> Void = {
                guard !settled, graceTimer == nil, firstEvent else { return }
                inactivityTimer?.cancel()
                inactivityTimer = Task {
                    try? await Task.sleep(nanoseconds: UInt64(inactivityMs) * 1_000_000)
                    if !Task.isCancelled { startGrace() }
                }
            }

            // Register as subscription for event dispatch
            let state = SubscriptionState(
                key: subId,
                filters: filters,
                onEvent: { event, relayUrl in
                    if settled { return }
                    pendingEvents.append(event)
                    firstEvent = true
                    resetInactivity()
                },
                onEose: { _ in
                    // Drain pending before signalling done (mirrors SubscriptionManager EOSE drain)
                    for event in pendingEvents { collected.append(event) }
                    pendingEvents.removeAll()
                    startGrace()
                }
            )
            subscriptions[subId] = state

            // Hard timeout
            Task {
                try? await Task.sleep(nanoseconds: UInt64(hardTimeoutMs) * 1_000_000)
                settle()
            }

            // Send REQ
            for (_, conn) in connections {
                Task { await conn.send(req) }
            }
        }
    }

    // MARK: Internal dispatch (called from RelayConnection)

    public nonisolated func dispatch(message: RelayMessage, from relayUrl: String) {
        Task { await _dispatch(message: message, relayUrl: relayUrl) }
    }

    /// Async variant for test-only use — awaits actor isolation before dispatching.
    public func dispatchAsync(message: RelayMessage, from relayUrl: String) {
        _dispatch(message: message, relayUrl: relayUrl)
    }

    private func _dispatch(message: RelayMessage, relayUrl: String) {
        switch message {
        case .event(let subId, let event):
            guard var state = subscriptions[subId] else { return }
            guard !eventCache.contains(event.id) else { return }
            eventCache.add(id: event.id)
            cursorStore.update(subId: subId, createdAt: event.created_at)
            state.pendingEvents.append((event, relayUrl))
            subscriptions[subId] = state

        case .eose(let subId):
            guard var state = subscriptions[subId] else { return }
            // Drain all buffered events before firing onEose — mirrors SubscriptionManager EOSE drain.
            // Without this, EOSE fires while events are still pending, causing stale state flicker.
            let drained = state.pendingEvents
            state.pendingEvents.removeAll()
            subscriptions[subId] = state
            for (event, relay) in drained { state.onEvent(event, relay) }
            state.onEose(relayUrl)

        case .ok, .notice, .closed:
            break
        }
    }

    // MARK: Message builders

    private func buildREQ(id: String, filters: [[String: Any]]) -> String {
        var arr: [Any] = ["REQ", id]
        arr.append(contentsOf: filters)
        let data = try! JSONSerialization.data(withJSONObject: arr)
        return String(data: data, encoding: .utf8)!
    }

    private func buildCLOSE(id: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: ["CLOSE", id])
        return String(data: data, encoding: .utf8)!
    }

    private func buildEVENT(event: NostrEvent) -> String {
        let dict: [String: Any] = [
            "id": event.id, "pubkey": event.pubkey, "created_at": event.created_at,
            "kind": event.kind, "tags": event.tags, "content": event.content, "sig": event.sig,
        ]
        let data = try! JSONSerialization.data(withJSONObject: ["EVENT", dict])
        return String(data: data, encoding: .utf8)!
    }

    private func subscriptionKey(filters: [[String: Any]]) -> String {
        // Stable key: sorted JSON of filters (mirrors SubscriptionManager stableStringify)
        let parts = filters.map { filter -> String in
            let sorted = filter.sorted { $0.key < $1.key }
            let dict = Dictionary(uniqueKeysWithValues: sorted)
            let data = (try? JSONSerialization.data(withJSONObject: dict, options: .sortedKeys)) ?? Data()
            return String(data: data, encoding: .utf8) ?? ""
        }.sorted().joined(separator: "|")
        return parts
    }

    private func publishConnectionSummary() async {
        guard let onConnectionSummaryChange else { return }
        onConnectionSummaryChange(await connectionSummary())
    }
}

// MARK: - SubscriptionState

private struct SubscriptionState {
    let key: String
    let filters: [[String: Any]]
    let onEvent: (NostrEvent, String?) -> Void
    let onEose: (String?) -> Void
    var refCount: Int = 1
    var pendingEvents: [(NostrEvent, String?)] = []
}

// MARK: - CursorStore

/// Tracks the highest `created_at` seen per subscription key.
/// Mirrors CursorStore.ts — used as `since` on reconnect/resubscribe.
private struct CursorStore {
    private var cursors: [String: Int] = [:]

    mutating func update(subId: String, createdAt: Int) {
        let prev = cursors[subId] ?? 0
        if createdAt > prev { cursors[subId] = createdAt }
    }

    func since(for subId: String) -> Int? {
        cursors[subId]
    }
}

// MARK: - EventCache

/// Deduplication ring buffer — mirrors EventCache.ts (maxSize 2048).
private struct EventCache {
    private var seenIds: [String] = []
    private var seenSet: Set<String> = []
    private let maxSize = 2048

    mutating func contains(_ id: String) -> Bool { seenSet.contains(id) }

    mutating func add(id: String) {
        seenSet.insert(id)
        seenIds.append(id)
        if seenIds.count > maxSize, let first = seenIds.first {
            seenSet.remove(first)
            seenIds.removeFirst()
        }
    }
}

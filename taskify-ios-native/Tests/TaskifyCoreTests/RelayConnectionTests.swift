/// RelayConnectionTests.swift
/// Tests for RelayConnection ping/keepalive, reconnect, and published state.

import Foundation
import Testing
@testable import TaskifyCore

// MARK: - Mock RelayPool for testing

final class MockRelayPool: RelayPoolProtocol, @unchecked Sendable {
    var dispatchedMessages: [(RelayMessage, String)] = []
    var connectedUrls: [String] = []
    var disconnectedUrls: [String] = []
    var permanentFailures: [(String, NSError?)] = []

    nonisolated func dispatch(message: RelayMessage, from relayUrl: String) {
        dispatchedMessages.append((message, relayUrl))
    }

    func relayDidConnect(url: String) async {
        connectedUrls.append(url)
    }

    func relayDidDisconnect(url: String) async {
        disconnectedUrls.append(url)
    }

    func relayDidFailPermanently(url: String, error: NSError?) async {
        permanentFailures.append((url, error))
    }
}

// MARK: - RelayConnectionTests

@Suite("RelayConnection")
struct RelayConnectionTests {

    @Test("connected() returns false before connect()")
    func notConnectedInitially() async {
        let pool = MockRelayPool()
        let conn = RelayConnection(url: "wss://relay.example.com", pool: pool)
        let connected = await conn.connected()
        #expect(connected == false)
    }

    @Test("pendingMessages queued when not connected")
    func queuesPendingMessagesWhenDisconnected() async {
        let pool = MockRelayPool()
        let conn = RelayConnection(url: "wss://relay.example.com", pool: pool)
        // send without connecting — should queue, not crash
        await conn.send("""
        ["REQ","sub1",{"kinds":[30301]}]
        """)
        let hasPending = await conn.hasPendingMessages()
        #expect(hasPending == true)
    }

    @Test("disconnect() sets connected to false")
    func disconnectSetsNotConnected() async {
        let pool = MockRelayPool()
        let conn = RelayConnection(url: "wss://relay.example.com", pool: pool)
        await conn.disconnect()
        let connected = await conn.connected()
        #expect(connected == false)
    }

    @Test("ping interval is 10 seconds (Primal-parity)")
    func pingIntervalIsTenSeconds() {
        #expect(RelayConnection.pingIntervalSeconds == 10)
    }

    @Test("exponential backoff caps at 30 seconds")
    func backoffCapsAt30() async {
        // Verify the constant is set correctly
        #expect(RelayConnection.maxReconnectDelaySecs == 30.0)
    }

    @Test("TLS trust errors do not auto reconnect")
    func tlsTrustErrorsDoNotReconnect() {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorSecureConnectionFailed)
        #expect(RelayConnection.shouldAutoReconnect(after: error) == false)
    }

    @Test("transient network errors still auto reconnect")
    func transientErrorsStillReconnect() {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)
        #expect(RelayConnection.shouldAutoReconnect(after: error) == true)
    }
}

// MARK: - RelayPoolPublishedStateTests

@Suite("RelayPool published state")
struct RelayPoolPublishedStateTests {

    @Test("initial connectedCount is 0")
    func initialConnectedCount() async {
        let pool = RelayPool(relayURLs: [])
        let count = await pool.connectedCount()
        #expect(count == 0)
    }

    @Test("initial atLeastOneConnected is false")
    func initialAtLeastOneConnected() async {
        let pool = RelayPool(relayURLs: [])
        let result = await pool.atLeastOneConnected()
        #expect(result == false)
    }

    @Test("relayStatuses returns empty for empty pool")
    func relayStatusesEmpty() async {
        let pool = RelayPool(relayURLs: [])
        let statuses = await pool.relayStatuses()
        #expect(statuses.isEmpty)
    }

    @Test("relayStatuses lists all configured relay URLs")
    func relayStatusesListsAllURLs() async {
        let urls = ["wss://relay.a.com", "wss://relay.b.com"]
        let pool = RelayPool(relayURLs: urls)
        let statuses = await pool.relayStatuses()
        #expect(statuses.count == 2)
        let listedURLs = Set(statuses.map(\.url))
        #expect(listedURLs == Set(urls))
    }

    @Test("connectionSummary reflects 0/N when not connected")
    func connectionSummaryDisconnected() async {
        let pool = RelayPool(relayURLs: ["wss://a.com", "wss://b.com"])
        let summary = await pool.connectionSummary()
        #expect(summary.total == 2)
        #expect(summary.connected == 0)
        #expect(summary.label == "0/2 relays")
    }
}

// MARK: - RelayPool EOSE drain tests

@Suite("RelayPool EOSE drain")
struct RelayPoolEoseDrainTests {

    @Test("EOSE drains pending events before firing onEose")
    func eoseDrainsBefore() async {
        // This tests the invariant: onEose must never fire while there are
        // buffered events that haven't been delivered yet.
        // Simulated via direct dispatch calls.

        let pool = RelayPool(relayURLs: [])
        var eventOrder: [String] = []

        // Inject a fake subscription via subscribe()
        let subKey = await pool.subscribe(
            filters: [["kinds": [30301]]],
            onEvent: { event, _ in
                eventOrder.append("event:\(event.id)")
            },
            onEose: { _ in
                eventOrder.append("eose")
            }
        )
        #expect(!subKey.isEmpty)

        // Simulate receiving an event then EOSE on a relay
        let fakeEvent = NostrEvent(
            id: "aabbcc",
            pubkey: "pubkey1",
            created_at: 1000,
            kind: 30301,
            tags: [["d", "task1"], ["b", "board1"]],
            content: "encrypted"
        )
        await pool.dispatchAsync(message: .event(subscriptionId: subKey, event: fakeEvent), from: "wss://r.com")
        await pool.dispatchAsync(message: .eose(subscriptionId: subKey), from: "wss://r.com")

        // Allow actor task to flush
        try? await Task.sleep(nanoseconds: 10_000_000)

        // Invariant: event must appear before eose in delivery order
        #expect(eventOrder.first == "event:aabbcc")
        #expect(eventOrder.last == "eose")
        #expect(eventOrder.count == 2)
    }

    @Test("duplicate events are deduplicated by EventCache")
    func duplicateEventsDeduped() async {
        let pool = RelayPool(relayURLs: [])
        var eventCount = 0

        let subKey = await pool.subscribe(
            filters: [["kinds": [30301]]],
            onEvent: { _, _ in eventCount += 1 },
            onEose: { _ in }
        )

        let fakeEvent = NostrEvent(
            id: "dedup-test-id",
            pubkey: "pubkey1",
            created_at: 1000,
            kind: 30301,
            tags: [],
            content: ""
        )

        // Dispatch same event twice (from two different relays — real-world duplicate)
        await pool.dispatchAsync(message: .event(subscriptionId: subKey, event: fakeEvent), from: "wss://r1.com")
        await pool.dispatchAsync(message: .event(subscriptionId: subKey, event: fakeEvent), from: "wss://r2.com")
        await pool.dispatchAsync(message: .eose(subscriptionId: subKey), from: "wss://r1.com")

        try? await Task.sleep(nanoseconds: 10_000_000)

        #expect(eventCount == 1)
    }
}

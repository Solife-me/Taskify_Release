import Foundation
import XCTest
@testable import TaskifyCore

/// One-shot lookups (account backup, app state, contacts) ride on the sync engine's open relay
/// connections instead of opening a fresh socket per relay per lookup. Relays the engine isn't
/// connected to go to the fallback fetcher.
final class OneShotFetchTests: XCTestCase {
    private let connectedURL = "wss://connected.example"
    private let otherURL = "wss://elsewhere.example"

    private func event(_ number: Int) -> NostrEvent {
        NostrEvent(
            id: String(format: "%064x", number), publicKey: String(repeating: "a", count: 64),
            createdAt: number, kind: 30078, tags: [["d", "x"]], content: "", signature: "fixture"
        )
    }

    func testLookupReusesTheOpenConnectionAndFallsBackForOthers() async throws {
        let relay = RespondingRelayTransport(events: [event(1), event(2)])
        let fallback = RecordingFallbackFetcher(events: [event(3)])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { _ in relay },
            oneShotFallback: fallback
        )
        addTeardownBlock { await engine.stop() }
        await engine.configure(boards: [], auxiliaryRelayURLs: [connectedURL], inboxRelayURLs: [])
        let connects = await relay.connectCount
        XCTAssertEqual(connects, 1)

        let filter = NostrRelayFilter(kinds: [30078], authors: [String(repeating: "a", count: 64)], dTags: ["x"], limit: 4)
        let events = await engine.fetchOnce(filter: filter, relayURLs: [connectedURL, otherURL], timeout: 2)

        XCTAssertEqual(Set(events.map(\.id)), Set([event(1).id, event(2).id, event(3).id]))
        let requests = await relay.requests
        XCTAssertEqual(requests.count, 1, "One REQ on the existing connection")
        let connectsAfter = await relay.connectCount
        XCTAssertEqual(connectsAfter, 1, "No new socket for the connected relay")
        let closed = await relay.closedSubscriptionIDs
        XCTAssertEqual(closed, requests.map(\.id), "The one-shot subscription is closed afterwards")
        let fallbackRelays = await fallback.relayURLs
        XCTAssertEqual(fallbackRelays, [otherURL], "Only the unconnected relay uses a fresh socket")
    }

    func testRelayFilterEncodesNIP01Fields() {
        let filter = NostrRelayFilter(kinds: [30078], authors: ["abc"], dTags: ["a", "b"], limit: 8, since: 100)
        let object = filter.jsonObject()
        XCTAssertEqual(object["kinds"] as? [Int], [30078])
        XCTAssertEqual(object["authors"] as? [String], ["abc"])
        XCTAssertEqual(object["#d"] as? [String], ["a", "b"])
        XCTAssertEqual(object["limit"] as? Int, 8)
        XCTAssertEqual(object["since"] as? Int, 100)
    }
}

private actor RespondingRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private let events: [NostrEvent]
    private(set) var connectCount = 0
    private(set) var requests: [(id: String, filter: NostrRelayFilter)] = []
    private(set) var closedSubscriptionIDs: [String] = []

    init(events: [NostrEvent]) { self.events = events }

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() { connectCount += 1 }
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boardTag: String, limit: Int, since: Int?) {}
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) { closedSubscriptionIDs.append(id) }
    func authenticate(_ event: NostrEvent) {}
    func publish(_ event: NostrEvent) async {}
    func request(id: String, filter: NostrRelayFilter) async throws {
        requests.append((id, filter))
        for event in events { stream.continuation.yield(.event(subscriptionID: id, event: event)) }
        stream.continuation.yield(.endOfStoredEvents(subscriptionID: id))
    }
}

private actor RecordingFallbackFetcher: NostrOneShotFetching {
    private let events: [NostrEvent]
    private(set) var relayURLs: [String] = []
    init(events: [NostrEvent]) { self.events = events }
    func fetchOnce(filter: NostrRelayFilter, relayURLs: [String], timeout: TimeInterval) async -> [NostrEvent] {
        self.relayURLs.append(contentsOf: relayURLs)
        return events
    }
}

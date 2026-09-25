import Foundation
import XCTest
@testable import TaskifyCore

/// relay.damus.io runs strfry with auth on but no serviceUrl: it challenges requests for
/// restricted kinds (a private gift-wrap inbox) and then answers every AUTH with "error: relay
/// needs serviceUrl to be configured before AUTH can work". That relay still serves everything
/// else, so a refused AUTH must not take it offline, and must not be retried in a loop.
final class RelayAuthUnavailableTests: XCTestCase {
    private let relayURL = "wss://auth-less.example"
    private let key = Data(repeating: 7, count: 32)

    func testARefusedAuthKeepsTheRelayOnlineAndIsNotRetried() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let relay = AuthRefusingRelayTransport()
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { _ in relay }
        )
        addTeardownBlock { await engine.stop() }
        let identity = try NostrIdentity(privateKey: key)
        await engine.setIdentity(identity)
        await engine.configure(boards: [], auxiliaryRelayURLs: [relayURL], inboxPublicKey: identity.publicKeyHex,
                               inboxRelayURLs: [relayURL])

        await engine.handle(.auth(challenge: "first"), from: relayURL)
        let authEvents = await relay.authEvents
        let authEvent = try XCTUnwrap(authEvents.first)
        await engine.handle(
            .acknowledgement(eventID: authEvent.id, accepted: false,
                             message: "error: relay needs serviceUrl to be configured before AUTH can work"),
            from: relayURL
        )

        // Publishing to that relay carries on.
        let note = try NostrEvent.signed(privateKey: key, createdAt: 100, kind: 1, tags: [], content: "still delivered")
        try await engine.enqueueForPublish([TaskSyncRelayPublishRequest(
            event: note, relayURLs: [relayURL], outboxScope: "test", recordID: "note", acknowledgementPolicy: .anyRelay
        )])
        for _ in 0..<50 where await relay.publishedEventIDs.isEmpty {
            try await Task.sleep(for: .milliseconds(20))
        }
        let published = await relay.publishedEventIDs
        XCTAssertEqual(published, [note.id], "A refused AUTH must not stop publishing to the relay")

        // The relay challenges again and closes the inbox subscription: no new AUTH attempts.
        await engine.handle(.closed(subscriptionID: "anything", message: "auth-required: requested filter requires authentication"), from: relayURL)
        await engine.handle(.auth(challenge: "second"), from: relayURL)
        let attempts = await relay.authEvents.count
        XCTAssertEqual(attempts, 1, "AUTH the relay can't do is not retried")
        let connections = await relay.connectionCount
        XCTAssertEqual(connections, 1, "The relay is not dropped and reconnected")
    }
}

private actor AuthRefusingRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private(set) var authEvents: [NostrEvent] = []
    private(set) var publishedEventIDs: [String] = []
    private(set) var connectionCount = 0

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() { connectionCount += 1 }
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {}
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) { publishedEventIDs.append(event.id) }
    func authenticate(_ event: NostrEvent) { authEvents.append(event) }
}

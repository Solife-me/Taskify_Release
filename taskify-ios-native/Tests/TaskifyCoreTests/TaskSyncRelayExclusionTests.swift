import Foundation
import XCTest
@testable import TaskifyCore

/// Covers the device-local sync relay list: excluding a relay tears its connection down and
/// drains the queue it was holding open. Relay rejections preserve unacknowledged changes
/// and do not suppress other events of the same kind. No sockets are opened.
final class TaskSyncRelayExclusionTests: XCTestCase {
    private let relayURL = "wss://board-relay.example"
    private let otherRelayURL = "wss://other-relay.example"
    private let stateKind = 30078

    private func event(_ number: Int, kind: Int) -> NostrEvent {
        NostrEvent(
            id: String(format: "%064x", number),
            publicKey: String(repeating: "a", count: 64),
            createdAt: number,
            kind: kind,
            tags: [],
            content: "ordinary-message-\(number)",
            signature: "fixture"
        )
    }

    private func request(
        _ number: Int,
        kind: Int,
        relayURLs: [String]
    ) -> TaskSyncRelayPublishRequest {
        TaskSyncRelayPublishRequest(
            event: event(number, kind: kind),
            relayURLs: relayURLs,
            outboxScope: "state",
            recordID: "record-\(number)"
        )
    }

    private func engine(
        transports: [String: CountingRelayTransport]
    ) -> TaskSyncEngine {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { transports[$0]! }
        )
        addTeardownBlock { await engine.stop() }
        return engine
    }

    func testExcludedRelayDisconnectsAndStopsReceivingPublishes() async throws {
        let relay = CountingRelayTransport()
        let engine = engine(transports: [relayURL: relay])
        await engine.configure(boards: [], auxiliaryRelayURLs: [relayURL], inboxRelayURLs: [])
        let connectCount = await relay.connectCount
        XCTAssertEqual(connectCount, 1)

        await engine.configure(
            boards: [],
            auxiliaryRelayURLs: [relayURL],
            inboxRelayURLs: [],
            excludedRelayURLs: [relayURL]
        )
        let disconnectCount = await relay.disconnectCount
        XCTAssertEqual(disconnectCount, 1, "The excluded relay's connection must be torn down")

        try await engine.enqueueForPublish([
            request(1, kind: stateKind, relayURLs: [relayURL])
        ])
        let pending = await engine.pendingPublishCount()
        XCTAssertEqual(pending, 0, "Publishes must not be queued for an excluded relay")
    }

    func testExcludingRelayCompletesEntriesThatOnlyWaitedOnIt() async throws {
        let relay = CountingRelayTransport()
        let other = CountingRelayTransport()
        let engine = engine(transports: [relayURL: relay, otherRelayURL: other])
        await engine.configure(
            boards: [],
            auxiliaryRelayURLs: [relayURL, otherRelayURL],
            inboxRelayURLs: []
        )
        try await engine.enqueueForPublish([
            request(1, kind: stateKind, relayURLs: [relayURL]),
            request(2, kind: stateKind, relayURLs: [relayURL, otherRelayURL])
        ])
        let before = await engine.pendingPublishCount()
        XCTAssertEqual(before, 2)

        await engine.configure(
            boards: [],
            auxiliaryRelayURLs: [relayURL, otherRelayURL],
            inboxRelayURLs: [],
            excludedRelayURLs: [relayURL]
        )
        // The first entry had nowhere left to go and completed; the second keeps waiting on the
        // remaining healthy replica.
        let after = await engine.pendingPublishCount()
        XCTAssertEqual(after, 1)
        await engine.handle(
            .acknowledgement(eventID: event(2, kind: stateKind).id, accepted: true, message: ""),
            from: otherRelayURL
        )
        let drained = await engine.pendingPublishCount()
        XCTAssertEqual(drained, 0)

        try await engine.enqueueForPublish([
            request(3, kind: stateKind, relayURLs: [relayURL])
        ])
        let requeued = await engine.pendingPublishCount()
        XCTAssertEqual(requeued, 0, "Later changes never re-enter the excluded relay")
    }

    func testRepeatedRejectionsPreserveDurableChangesAndAllowLaterEventsOfSameKind() async throws {
        let relay = CountingRelayTransport()
        let engine = engine(transports: [relayURL: relay])
        await engine.configure(boards: [], auxiliaryRelayURLs: [relayURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([
            request(1, kind: stateKind, relayURLs: [relayURL]),
            request(2, kind: stateKind, relayURLs: [relayURL]),
            request(3, kind: stateKind, relayURLs: [relayURL])
        ])
        let before = await engine.pendingPublishCount()
        XCTAssertEqual(before, 3)

        let rejectionMessage = "blocked: kind \(stateKind) not accepted here"
        await engine.handle(
            .acknowledgement(eventID: event(1, kind: stateKind).id, accepted: false, message: rejectionMessage),
            from: relayURL
        )
        let oneStrike = await engine.pendingPublishCount()
        XCTAssertEqual(oneStrike, 3, "A single rejection must not suppress the kind yet")

        await engine.handle(
            .acknowledgement(eventID: event(2, kind: stateKind).id, accepted: false, message: rejectionMessage),
            from: relayURL
        )
        let suppressed = await engine.pendingPublishCount()
        XCTAssertEqual(suppressed, 3, "Rejections cannot discard unacknowledged changes")

        try await engine.enqueueForPublish([request(4, kind: stateKind, relayURLs: [relayURL])])
        let requeued = await engine.pendingPublishCount()
        XCTAssertEqual(requeued, 4, "A rejection applies to an event, not every future event of its kind")

        try await engine.enqueueForPublish([
            request(5, kind: NIP17GiftWrap.wrapKind, relayURLs: [relayURL])
        ])
        let otherKindPending = await engine.pendingPublishCount()
        XCTAssertEqual(otherKindPending, 5, "All unacknowledged changes stay durable")
    }

    func testRefusedEventIsHeldBackFromThatRelayButStaysQueued() async throws {
        let relay = CountingRelayTransport()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let outbox = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let engine = TaskSyncEngine(outbox: outbox, connectionFactory: { _ in relay })
        addTeardownBlock { await engine.stop() }
        await engine.configure(boards: [], auxiliaryRelayURLs: [relayURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([request(1, kind: stateKind, relayURLs: [relayURL])])

        await engine.handle(
            .acknowledgement(eventID: event(1, kind: stateKind).id, accepted: false, message: "blocked: not on the allow list"),
            from: relayURL
        )
        let pending = await engine.pendingPublishCount()
        XCTAssertEqual(pending, 1, "The change stays queued")
        let eligible = await outbox.pendingEntries(for: relayURL)
        XCTAssertEqual(eligible, [], "…but is not offered to the refusing relay again right away")
    }

    func testDuplicateRejectionCountsAsDelivered() async throws {
        let relay = CountingRelayTransport()
        let engine = engine(transports: [relayURL: relay])
        await engine.configure(boards: [], auxiliaryRelayURLs: [relayURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([request(1, kind: stateKind, relayURLs: [relayURL])])
        await engine.handle(
            .acknowledgement(eventID: event(1, kind: stateKind).id, accepted: false, message: "duplicate: already have this event"),
            from: relayURL
        )
        let pending = await engine.pendingPublishCount()
        XCTAssertEqual(pending, 0)
    }
}

private actor CountingRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private(set) var connectCount = 0
    private(set) var disconnectCount = 0

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() { connectCount += 1 }
    func disconnect() { disconnectCount += 1 }
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boardTag: String, limit: Int, since: Int?) {}
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func authenticate(_ event: NostrEvent) {}
    func publish(_ event: NostrEvent) async {}
}
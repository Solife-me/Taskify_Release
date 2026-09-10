import Foundation
import XCTest
@testable import TaskifyCore

final class NIP17InboxLatencyTests: XCTestCase {
    private let publicKey = String(repeating: "a", count: 64)
    private let relay = "wss://inbox.example"

    private func event(_ number: Int) -> NostrEvent {
        try! NostrEvent.signed(privateKey: Data(repeating: 1, count: 32),
            createdAt: 10_000 - number, kind: NIP17GiftWrap.wrapKind,
            tags: [["p", publicKey]], content: "encrypted-\(number)")
    }

    private func engine() async -> (TaskSyncEngine, String) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let engine = TaskSyncEngine(outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")), connectionFactory: { _ in InboxAuditTransport() })
        // Exercise the production relay ingress without requiring an external relay or socket.
        await engine.configure(boards: [], inboxPublicKey: publicKey, inboxRelayURLs: [relay])
        let subscription = await engine.beginSharedInboxReplay(relayURL: relay, publicKey: publicKey)
        return (engine, subscription)
    }

    private func delivered(_ engine: TaskSyncEngine) async -> (history: [String], live: [String]) {
        // A queued marker makes this deterministic even if no DM was emitted; a regression
        // reports an empty list instead of hanging while waiting for the missing message.
        await engine.handle(.notice("latency-test-complete"), from: relay)
        var history: [String] = []
        var live: [String] = []
        for await update in engine.updates() {
            switch update {
            case .sharedInbox(let event): live.append(event.id)
            case .sharedInboxBatch(let events): history.append(contentsOf: events.map(\.id))
            case .status(let report) where report.relays.contains(where: { $0.message == "latency-test-complete" }):
                return (history, live)
            default: break
            }
        }
        return (history, live)
    }

    func testInboxEventIsDeliveredBeforeEndOfStoredEvents() async {
        let (engine, subscription) = await engine()
        await engine.handle(.event(subscriptionID: subscription, event: event(1)), from: relay)
        // Intentionally never deliver EOSE, matching a relay still busy replaying history.
        let received = await delivered(engine)
        XCTAssertEqual(received.history, [event(1).id])
        await engine.stop()
    }

    func testDelayedEOSEDoesNotDuplicateHistoryAndLaterMessagesAreLive() async {
        let (engine, subscription) = await engine()
        await engine.handle(.event(subscriptionID: subscription, event: event(1)), from: relay)
        await engine.handle(.event(subscriptionID: subscription, event: event(1)), from: relay)
        await engine.handle(.endOfStoredEvents(subscriptionID: subscription), from: relay)
        await engine.handle(.event(subscriptionID: subscription, event: event(2)), from: relay)
        let received = await delivered(engine)
        XCTAssertEqual(received.history, [event(1).id])
        XCTAssertEqual(received.live, [event(2).id])
        await engine.stop()
    }

    func testSlowConsumerDoesNotLoseMessagesBeyondOld512UpdateBuffer() async {
        let (engine, subscription) = await engine()
        for number in 1...750 {
            await engine.handle(.event(subscriptionID: subscription, event: event(number)), from: relay)
        }
        let received = await delivered(engine)
        XCTAssertEqual(received.history, (1...750).map { event($0).id })
        await engine.stop()
    }

    func testLiveMessagesPreemptRecoveryAndCryptoBatchesStayBounded() {
        var queue = NIP17InboxProcessingQueue()
        queue.enqueue((1...500).map(event), isHistory: true)
        XCTAssertEqual(queue.nextBatch().map(\.id), (1...8).map { event($0).id })
        queue.enqueue([event(501)], isHistory: false)
        let next = queue.nextBatch()
        XCTAssertEqual(next.count, 8)
        XCTAssertEqual(next.first?.id, event(501).id)
        XCTAssertEqual(next.dropFirst().map(\.id), (9...15).map { event($0).id })
        var remaining: [NostrEvent] = []
        while !queue.isEmpty {
            let batch = queue.nextBatch()
            XCTAssertLessThanOrEqual(batch.count, 8)
            remaining.append(contentsOf: batch)
        }
        XCTAssertEqual(remaining.map(\.id), (16...500).map { event($0).id })
    }

    func testKnownEventsAndQueuedDuplicatesSkipWorkButFailuresCanRetry() {
        var queue = NIP17InboxProcessingQueue(knownEventIDs: [event(1).id])
        queue.enqueue([event(1), event(2), event(2), event(3)], isHistory: true)
        XCTAssertEqual(queue.nextBatch().map(\.id), [event(2).id, event(3).id])
        queue.recordProcessed([event(2).id])
        // Event 3 failed authentication and was not recorded as processed.
        queue.enqueue([event(2), event(3)], isHistory: false)
        XCTAssertEqual(queue.nextBatch().map(\.id), [event(3).id])
        XCTAssertTrue(queue.isEmpty)
    }

    func testRecoveryContinuesUnderSustainedLiveTraffic() {
        var queue = NIP17InboxProcessingQueue()
        queue.enqueue([event(1), event(2)], isHistory: true)
        queue.enqueue((3...100).map(event), isHistory: false)
        XCTAssertEqual(queue.nextBatch().last?.id, event(1).id)
        XCTAssertEqual(queue.nextBatch().last?.id, event(2).id)
    }

    func testSavedMessageSkipListPreservesPaymentRecoveryAndUnconfirmedSends() {
        func message(_ number: Int, content: String, incoming: Bool = true,
                     state: NostrDirectMessageDeliveryState? = nil) -> NostrDirectMessage {
            NostrDirectMessage(rumorEventID: "rumor-\(number)", wrapEventID: event(number).id,
                               peerPublicKey: publicKey, senderPublicKey: publicKey, content: content,
                               createdAt: number, isIncoming: incoming, deliveryState: state)
        }
        var snapshot = TaskifySnapshot.empty
        snapshot.directMessages = [
            message(1, content: "Ordinary saved DM"),
            message(2, content: "Here you go: cashuAeyJ0b2tlbiI6W119fQ"),
            message(3, content: "Still sending", incoming: false, state: .queued),
            message(4, content: "Confirmed", incoming: false, state: .sent),
        ]
        XCTAssertEqual(snapshot.savedNonPaymentInboxEventIDs(), [event(1).id, event(4).id])
    }
}

private actor InboxAuditTransport: TaskSyncRelayTransport {
    nonisolated let stream = AsyncStream<NostrRelayMessage>.makeStream()
    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boardTag: String, limit: Int, since: Int?) {}
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) {}
    func authenticate(_ event: NostrEvent) {}
}

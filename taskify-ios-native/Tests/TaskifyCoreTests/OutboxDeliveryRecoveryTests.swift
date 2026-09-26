import Foundation
import XCTest
@testable import TaskifyCore
import TaskifyWatchShared

/// Queued deliveries that can never succeed as they stand: ones waiting on a relay the account no
/// longer uses, and ones a relay refuses for too little proof of work.
final class OutboxDeliveryRecoveryTests: XCTestCase {
    private let keptRelay = "wss://kept.example"
    private let retiredRelay = "wss://retired.example"
    private let key = Data(repeating: 7, count: 32)

    private func makeEngine(
        relay: RecordingRelayTransport,
        outbox: NostrOutboxStore,
        proofOfWork: Int = 0
    ) -> TaskSyncEngine {
        let engine = TaskSyncEngine(
            outbox: outbox,
            connectionFactory: { _ in relay },
            unreachableRelayGrace: 0.2,
            proofOfWorkRequirement: { _ in proofOfWork }
        )
        addTeardownBlock { await engine.stop() }
        return engine
    }

    private func makeOutbox() -> NostrOutboxStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
    }

    private func note(_ content: String, key: Data? = nil) throws -> NostrEvent {
        try NostrEvent.signed(privateKey: key ?? self.key, createdAt: 1_000, kind: 30_078,
                              tags: [["d", content]], content: content)
    }

    // MARK: - Relays no longer configured

    func testADeliveryToARelayNoLongerUsedCompletesOnceAnotherRelayHasIt() async throws {
        let outbox = makeOutbox()
        let storedElsewhere = try note("inbox-list")
        let onlyCopy = try note("only-copy")
        let notYetAccepted = try note("not-yet-accepted")
        try await outbox.enqueue([
            NostrOutboxEntry(event: storedElsewhere, relayURLs: [keptRelay, retiredRelay], boardLocalID: "scope",
                             taskID: "inbox-list", acceptedRelayURLs: [keptRelay]),
            NostrOutboxEntry(event: onlyCopy, relayURLs: [retiredRelay], boardLocalID: "scope", taskID: "only-copy"),
            NostrOutboxEntry(event: notYetAccepted, relayURLs: [keptRelay, retiredRelay], boardLocalID: "scope",
                             taskID: "not-yet-accepted"),
        ])
        let engine = makeEngine(relay: RecordingRelayTransport(), outbox: outbox)
        await engine.configure(boards: [], auxiliaryRelayURLs: [keptRelay], inboxRelayURLs: [keptRelay])

        let beforeGrace = Set(await outbox.allEntries().map(\.taskID))
        XCTAssertTrue(beforeGrace.contains("inbox-list"), "A relay set still settling drops nothing")

        for _ in 0..<100 where await outbox.entry(eventID: storedElsewhere.id) != nil {
            try await Task.sleep(for: .milliseconds(20))
        }
        let remaining = Dictionary(uniqueKeysWithValues: await outbox.allEntries().map { ($0.taskID, $0.pendingRelayURLs) })
        XCTAssertNil(remaining["inbox-list"], "Stored on a relay in use; nothing will ever send it to the retired one")
        XCTAssertEqual(remaining["only-copy"], [retiredRelay], "No relay has it yet: it may be the only copy")
        XCTAssertEqual(Set(remaining["not-yet-accepted"] ?? []), [keptRelay, retiredRelay])
    }

    func testARelayBackInTheConfigurationKeepsItsDeliveries() async throws {
        let outbox = makeOutbox()
        let event = try note("inbox-list")
        try await outbox.enqueue([
            NostrOutboxEntry(event: event, relayURLs: [keptRelay, retiredRelay], boardLocalID: "scope",
                             taskID: "inbox-list", acceptedRelayURLs: [keptRelay]),
        ])
        let engine = makeEngine(relay: RecordingRelayTransport(), outbox: outbox)
        await engine.configure(boards: [], auxiliaryRelayURLs: [keptRelay], inboxRelayURLs: [keptRelay])
        await engine.configure(boards: [], auxiliaryRelayURLs: [keptRelay, retiredRelay], inboxRelayURLs: [keptRelay])
        try await Task.sleep(for: .milliseconds(500))

        let pending = await outbox.entry(eventID: event.id)?.pendingRelayURLs
        XCTAssertEqual(pending, [retiredRelay])
    }

    // MARK: - Proof of work

    func testAProofOfWorkRefusalReminesTheChangeWithItsOwnKey() async throws {
        let outbox = makeOutbox()
        let relay = RecordingRelayTransport()
        let engine = makeEngine(relay: relay, outbox: outbox, proofOfWork: 12)
        let identity = try NostrIdentity(privateKey: key)
        await engine.setIdentity(identity)
        await engine.configure(boards: [], auxiliaryRelayURLs: [keptRelay], inboxRelayURLs: [keptRelay])
        let unmined = try note("scripture-memory")
        try XCTSkipIf(TaskifyRelayProofOfWork.leadingZeroBits(unmined.id) >= 12, "Unmined id already meets the target")
        try await engine.enqueueForPublish([TaskSyncRelayPublishRequest(
            event: unmined, relayURLs: [keptRelay], outboxScope: "app-state", recordID: "scripture-memory",
            acknowledgementPolicy: .everyRelay
        )])
        for _ in 0..<100 where await !relay.publishedEventIDs.contains(unmined.id) {
            try await Task.sleep(for: .milliseconds(10))
        }

        await engine.handle(.acknowledgement(eventID: unmined.id, accepted: false, message: "pow: difficulty too low"),
                            from: keptRelay)

        let entries = await outbox.allEntries()
        let queued = try XCTUnwrap(entries.first)
        let mined = queued.event
        XCTAssertNotEqual(mined.id, unmined.id)
        XCTAssertGreaterThanOrEqual(TaskifyRelayProofOfWork.leadingZeroBits(mined.id), 12)
        XCTAssertTrue(mined.verify())
        XCTAssertEqual(mined.publicKey, unmined.publicKey)
        XCTAssertEqual(mined.createdAt, unmined.createdAt)
        XCTAssertEqual(mined.content, unmined.content)
        XCTAssertEqual(mined.tags.first { $0.first == "nonce" }?.last, "12")
        XCTAssertNil(queued.relayRejections, "Nothing to hold back: the relay gets the mined change")
        for _ in 0..<100 where await !relay.publishedEventIDs.contains(mined.id) {
            try await Task.sleep(for: .milliseconds(10))
        }
        let published = await relay.publishedEventIDs
        XCTAssertTrue(published.contains(mined.id), "The mined change is sent in its place")
    }

    func testAProofOfWorkRefusalThisClientCantMeetIsHeldBack() async throws {
        let outbox = makeOutbox()
        let relay = RecordingRelayTransport()
        let engine = makeEngine(relay: relay, outbox: outbox, proofOfWork: 12)
        await engine.configure(boards: [], auxiliaryRelayURLs: [keptRelay], inboxRelayURLs: [keptRelay])
        // Signed by a key this client doesn't hold (a gift wrap's one-off key, say).
        let foreign = try note("wrap", key: Data(repeating: 9, count: 32))
        try await engine.enqueueForPublish([TaskSyncRelayPublishRequest(
            event: foreign, relayURLs: [keptRelay], outboxScope: "dm", recordID: "wrap", acknowledgementPolicy: .anyRelay
        )])
        for _ in 0..<100 where await relay.publishedEventIDs.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }

        await engine.handle(.acknowledgement(eventID: foreign.id, accepted: false, message: "pow: difficulty too low"),
                            from: keptRelay)

        let entry = await outbox.entry(eventID: foreign.id)
        let queued = try XCTUnwrap(entry)
        XCTAssertNotNil(queued.relayRejections?[keptRelay], "Held back rather than resent on every reconnect")
    }
}

private actor RecordingRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private(set) var publishedEventIDs: [String] = []

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {
        stream.continuation.yield(.endOfStoredEvents(subscriptionID: id))
    }
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) { publishedEventIDs.append(event.id) }
    func authenticate(_ event: NostrEvent) {}
}

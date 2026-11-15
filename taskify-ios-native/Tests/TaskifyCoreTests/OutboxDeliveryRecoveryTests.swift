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
        proofOfWork: Int = 0,
        cachedProofOfWork: (@Sendable (String) async -> Int)? = nil,
        recordProofOfWork: @escaping @Sendable (String, Int) async -> Void = { _, _ in }
    ) -> TaskSyncEngine {
        let engine = TaskSyncEngine(
            outbox: outbox,
            connectionFactory: { _ in relay },
            unreachableRelayGrace: 0.2,
            proofOfWorkRequirement: { _ in proofOfWork },
            cachedProofOfWorkRequirement: cachedProofOfWork ?? { _ in proofOfWork },
            recordProofOfWorkRequirement: recordProofOfWork
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

    func testRepairWithoutAReplacementDoesNotKeepFlushing() async throws {
        let outbox = makeOutbox()
        let lookups = RecordedProofOfWork()
        let engine = TaskSyncEngine(
            outbox: outbox,
            connectionFactory: { _ in RecordingRelayTransport() },
            proofOfWorkRequirement: { relay in
                await lookups.record(relay, 0)
                return 0
            }
        )
        addTeardownBlock { await engine.stop() }
        let event = try note("ordinary")
        try await engine.enqueueForPublish([TaskSyncRelayPublishRequest(
            event: event, relayURLs: [keptRelay], outboxScope: "app-state", recordID: "ordinary"
        )])
        try await Task.sleep(for: .milliseconds(100))
        let first = await lookups.count
        try await Task.sleep(for: .milliseconds(100))
        let second = await lookups.count
        XCTAssertEqual(first, second, "A repair pass that changes nothing must not request another flush")
        XCTAssertLessThanOrEqual(second, 1)
    }

    func testOrdinaryRelayGetsOriginalWhileProofOfWorkRelaysShareHardestCopy() async throws {
        let outbox = makeOutbox()
        let ordinary = RecordingRelayTransport()
        let low = RecordingRelayTransport()
        let high = RecordingRelayTransport()
        let lowURL = "wss://low.example"
        let highURL = "wss://high.example"
        let relayURLs = [keptRelay, lowURL, highURL]
        let connections = [keptRelay: ordinary, lowURL: low, highURL: high]
        let floors = [lowURL: 8, highURL: 10]
        let engine = TaskSyncEngine(
            outbox: outbox,
            connectionFactory: { connections[$0]! },
            proofOfWorkRequirement: { floors[$0] ?? 0 },
            cachedProofOfWorkRequirement: { floors[$0] ?? 0 }
        )
        addTeardownBlock { await engine.stop() }
        await engine.setIdentity(try NostrIdentity(privateKey: key))
        await engine.configure(boards: [], auxiliaryRelayURLs: relayURLs, inboxRelayURLs: [])
        let original = try note("mixed")
        try await engine.enqueueForPublish([TaskSyncRelayPublishRequest(
            event: original, relayURLs: relayURLs, outboxScope: "state", recordID: "mixed"
        )])
        for _ in 0..<120 {
            if await !ordinary.publishedEvents.isEmpty, await !low.publishedEvents.isEmpty,
               await !high.publishedEvents.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let publishedOrdinary = await ordinary.publishedEvents
        let publishedLow = await low.publishedEvents
        let publishedHigh = await high.publishedEvents
        XCTAssertEqual(publishedOrdinary, [original])
        let mined = try XCTUnwrap(publishedHigh.first)
        XCTAssertEqual(publishedLow, [mined])
        XCTAssertNotEqual(mined.id, original.id)
        XCTAssertTrue(TaskifyRelayProofOfWork.satisfies(id: mined.id, tags: mined.tags, difficulty: 10))
        XCTAssertEqual(mined.tags.first { $0.first == "nonce" }?.last, "10")

        await engine.handle(.acknowledgement(eventID: original.id, accepted: true, message: ""), from: keptRelay)
        await engine.handle(.acknowledgement(eventID: mined.id, accepted: true, message: ""), from: lowURL)
        let pending = await outbox.entry(eventID: original.id)?.pendingRelayURLs
        XCTAssertEqual(pending, [highURL])
        await engine.handle(.acknowledgement(eventID: mined.id, accepted: true, message: ""), from: highURL)
        let remaining = await outbox.entryCount()
        XCTAssertEqual(remaining, 0)
    }

    func testOrdinaryWriteDoesNotWaitForSlowRelayMetadata() async throws {
        let outbox = makeOutbox()
        let relay = RecordingRelayTransport()
        let engine = TaskSyncEngine(
            outbox: outbox,
            connectionFactory: { _ in relay },
            proofOfWorkRequirement: { _ in
                try? await Task.sleep(for: .seconds(2))
                return 0
            },
            cachedProofOfWorkRequirement: { _ in 0 }
        )
        addTeardownBlock { await engine.stop() }
        await engine.configure(boards: [], auxiliaryRelayURLs: [keptRelay], inboxRelayURLs: [])
        let original = try note("immediate")
        try await engine.enqueueForPublish([TaskSyncRelayPublishRequest(
            event: original, relayURLs: [keptRelay], outboxScope: "state", recordID: "immediate"
        )])
        for _ in 0..<50 where await relay.publishedEvents.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        let published = await relay.publishedEvents
        XCTAssertEqual(published, [original])
    }

    func testGiftWrapAcknowledgesFirstRelayAndReplicatesAfterProofOfWorkRefusal() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("outbox.json")
        let recorded = RecordedProofOfWork()
        let ordinary = RecordingRelayTransport()
        let strict = RecordingRelayTransport()
        let sender = try NostrIdentity(privateKey: key)
        let recipient = try NostrIdentity(privateKey: Data(repeating: 8, count: 32))
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex, createdAt: 1_000, kind: NIP17GiftWrap.rumorKind,
            tags: [["p", recipient.publicKeyHex]], content: "durable retry"
        )
        let outward = try NIP17OutgoingMessageBatch(
            rumors: [rumor], identity: sender,
            relayURLsByRecipient: [recipient.publicKeyHex: [keptRelay, retiredRelay], sender.publicKeyHex: [keptRelay]],
            allowProofOfWorkRetry: true
        )
        let delivery = try XCTUnwrap(outward.deliveries.first { $0.recipientPublicKey == recipient.publicKeyHex })
        // Simulate a write queued by an earlier process before the refusal arrived.
        try await NostrOutboxStore(fileURL: fileURL).enqueue(NostrOutboxEntry(
            event: delivery.event, relayURLs: delivery.relayURLs, boardLocalID: "chat", taskID: "dm",
            acknowledgementPolicy: .firstRelay, encryptedProofOfWorkKey: delivery.encryptedProofOfWorkKey
        ))
        let outbox = NostrOutboxStore(fileURL: fileURL)
        let engine = TaskSyncEngine(
            outbox: outbox,
            connectionFactory: { [keptRelay, retiredRelay] in $0 == keptRelay ? ordinary : strict },
            proofOfWorkRequirement: { _ in 0 },
            cachedProofOfWorkRequirement: { await recorded.entries[$0] ?? 0 },
            recordProofOfWorkRequirement: { await recorded.record($0, $1) }
        )
        addTeardownBlock { await engine.stop() }
        let deliveryUpdates = RecordedProofOfWork()
        let updates = Task {
            for await update in engine.updates() {
                if case .publishState(let id, .sent) = update, id == "dm" { await deliveryUpdates.record(id, 0) }
            }
        }
        defer { updates.cancel() }
        await engine.setIdentity(sender)
        await engine.configure(boards: [], auxiliaryRelayURLs: [keptRelay, retiredRelay], inboxRelayURLs: [])
        for _ in 0..<100 where await strict.publishedEvents.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        await engine.handle(.acknowledgement(eventID: delivery.event.id, accepted: true, message: ""), from: keptRelay)
        let pendingReplicas = await outbox.pendingRelayURLs()
        XCTAssertEqual(pendingReplicas, [retiredRelay])
        await engine.handle(.acknowledgement(eventID: delivery.event.id, accepted: false, message: "pow: difficulty 0 is less than 10"), from: retiredRelay)
        for _ in 0..<150 where await strict.publishedEvents.count < 2 {
            try await Task.sleep(for: .milliseconds(10))
        }
        let published = await strict.publishedEvents
        XCTAssertEqual(published.first, delivery.event)
        let mined = try XCTUnwrap(published.dropFirst().first)
        XCTAssertEqual(mined.content, delivery.event.content)
        XCTAssertEqual(mined.publicKey, delivery.event.publicKey)
        XCTAssertTrue(TaskifyRelayProofOfWork.satisfies(id: mined.id, tags: mined.tags, difficulty: 10))
        XCTAssertEqual(try NIP17GiftWrap.unwrapRumor(mined, recipient: recipient).rumor.id, rumor.id)
        let reportedSent = await deliveryUpdates.count
        XCTAssertEqual(reportedSent, 1)
        await engine.handle(.acknowledgement(eventID: mined.id, accepted: true, message: ""), from: retiredRelay)
        let remaining = await outbox.entryCount()
        XCTAssertEqual(remaining, 0)
    }

    func testAKnownProofOfWorkFloorReminesBeforeFirstPublish() async throws {
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
        for _ in 0..<100 where await outbox.entry(eventID: unmined.id)?.proofOfWorkEvent == nil {
            try await Task.sleep(for: .milliseconds(10))
        }

        let entries = await outbox.allEntries()
        let queued = try XCTUnwrap(entries.first)
        let mined = try XCTUnwrap(queued.proofOfWorkEvent)
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
        XCTAssertFalse(published.contains(unmined.id), "A known floor is applied before the low-work event is offered")
        XCTAssertTrue(published.contains(mined.id), "The mined change is sent in its place")
    }

    func testAHeldBoardEventRecoversAfterItsBoardKeyBecomesAvailable() async throws {
        let outbox = makeOutbox()
        let relay = RecordingRelayTransport()
        let engine = makeEngine(relay: relay, outbox: outbox, proofOfWork: 12)
        let board = Board(
            id: "current-local-id",
            name: "Recovered board",
            nostrBoardID: "stable-nostr-board-id",
            relayURLs: [keptRelay]
        )
        let unmined = try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: board.effectiveNostrBoardID),
            createdAt: 1_000,
            kind: TaskEventCodec.taskEventKind,
            tags: [["d", "queued-task"]],
            content: "queued"
        )
        try XCTSkipIf(TaskifyRelayProofOfWork.leadingZeroBits(unmined.id) >= 12, "Unmined id already meets the target")
        try await outbox.enqueue(NostrOutboxEntry(
            event: unmined,
            relayURLs: [keptRelay],
            boardLocalID: "stale-local-id",
            taskID: "queued-task"
        ))
        _ = try await outbox.recordRejection(eventID: unmined.id, relayURL: keptRelay)
        _ = try await outbox.recordRejection(eventID: unmined.id, relayURL: keptRelay)

        await engine.configure(boards: [board], auxiliaryRelayURLs: [], inboxRelayURLs: [keptRelay])
        for _ in 0..<200 where await outbox.entry(eventID: unmined.id)?.proofOfWorkEvent == nil {
            try await Task.sleep(for: .milliseconds(10))
        }

        let recoveredEntries = await outbox.allEntries()
        let queued = try XCTUnwrap(recoveredEntries.first)
        let mined = try XCTUnwrap(queued.proofOfWorkEvent)
        XCTAssertEqual(queued.event.id, unmined.id)
        XCTAssertGreaterThanOrEqual(TaskifyRelayProofOfWork.leadingZeroBits(mined.id), 12)
        XCTAssertEqual(mined.publicKey, unmined.publicKey)
        XCTAssertNil(queued.relayRejections, "The replacement is not held by the old event's backoff")
        for _ in 0..<100 where await !relay.publishedEventIDs.contains(mined.id) {
            try await Task.sleep(for: .milliseconds(10))
        }
        let published = await relay.publishedEventIDs
        XCTAssertTrue(published.contains(mined.id))
    }

    /// nos.lol and other strfry write policies can enforce proof of work without advertising it
    /// in NIP-11. The refusal names the floor; ignoring it left every change queued there.
    func testAProofOfWorkRefusalNamingAnUnadvertisedFloorIsMinedAndRemembered() async throws {
        let outbox = makeOutbox()
        let relay = RecordingRelayTransport()
        let recorded = RecordedProofOfWork()
        let engine = makeEngine(
            relay: relay,
            outbox: outbox,
            proofOfWork: 0,
            cachedProofOfWork: { await recorded.entries[$0] ?? 0 },
            recordProofOfWork: { relayURL, difficulty in
                await recorded.record(relayURL, difficulty)
            }
        )
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

        await engine.handle(
            .acknowledgement(eventID: unmined.id, accepted: false,
                             message: "pow: difficulty 8 is less than 12"),
            from: keptRelay
        )

        for _ in 0..<120 where await outbox.entry(eventID: unmined.id)?.proofOfWorkEvent == nil {
            try await Task.sleep(for: .milliseconds(10))
        }
        let entries = await outbox.allEntries()
        let queued = try XCTUnwrap(entries.first)
        let mined = try XCTUnwrap(queued.proofOfWorkEvent)
        XCTAssertGreaterThanOrEqual(
            TaskifyRelayProofOfWork.leadingZeroBits(mined.id), 12,
            "Mined to the floor the refusal named, not the zero NIP-11 advertises"
        )
        let learning = await recorded.entries
        XCTAssertEqual(learning[keptRelay], 12, "Remembered so the next event is mined up front")
        for _ in 0..<100 where await !relay.publishedEventIDs.contains(mined.id) {
            try await Task.sleep(for: .milliseconds(10))
        }
        let published = await relay.publishedEventIDs
        XCTAssertTrue(published.contains(mined.id))
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
    private(set) var publishedEvents: [NostrEvent] = []
    var publishedEventIDs: [String] { publishedEvents.map(\.id) }

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {
        stream.continuation.yield(.endOfStoredEvents(subscriptionID: id))
    }
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) { publishedEvents.append(event) }
    func authenticate(_ event: NostrEvent) {}
}

private actor RecordedProofOfWork {
    private(set) var count = 0
    private(set) var entries: [String: Int] = [:]

    func record(_ relayURL: String, _ difficulty: Int) {
        count += 1
        entries[relayURL] = difficulty
    }
}

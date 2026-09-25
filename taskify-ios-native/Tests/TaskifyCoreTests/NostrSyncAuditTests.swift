import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyCore

final class NostrSyncAuditTests: XCTestCase {
    private let relayURL = "wss://audit.example"
    private let key = Data(repeating: 1, count: 32)

    private func setupEngine(board: Board? = nil, inbox: String? = nil) async -> (TaskSyncEngine, AuditRelayTransport) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let relay = AuditRelayTransport()
        let engine = TaskSyncEngine(outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")), connectionFactory: { _ in relay })
        addTeardownBlock { await engine.stop() }
        await engine.configure(boards: board.map { [$0] } ?? [], auxiliaryRelayURLs: [relayURL], inboxPublicKey: inbox, inboxRelayURLs: inbox == nil ? [] : [relayURL])
        return (engine, relay)
    }

    func testBulkTaskClocksDoNotDriftOneSecondPerUnrelatedRecord() {
        let now = 1_800_000_000
        let timestamps = (0..<2000).map { _ in NostrEvent.nextTimestamp(after: now - 10, now: now) }
        XCTAssertEqual(Set(timestamps), [now])
        XCTAssertEqual(NostrEvent.nextTimestamp(after: now, now: now), now + 1)
        XCTAssertEqual(NostrEvent.nextTimestamp(after: Int.max, now: now), Int.max)
    }

    func testCorruptEnvelopeCannotPoisonDeduplicationOrCursor() async throws {
        let identity = try NostrIdentity(privateKey: key)
        let (engine, relay) = await setupEngine(inbox: identity.publicKeyHex)
        let subValue = await relay.lastInboxFilter()
        let sub = try XCTUnwrap(subValue)
        let valid = try NostrEvent.signed(privateKey: key, createdAt: Int(Date().timeIntervalSince1970), kind: 1059, tags: [["p", identity.publicKeyHex]], content: "opaque encrypted data")
        var corrupt = valid
        corrupt.createdAt = Int.max
        await engine.handle(.event(subscriptionID: sub.id, event: corrupt), from: relayURL)
        let delivered = expectation(description: "valid copy is delivered after corrupted copy")
        let listener = Task {
            for await update in engine.updates() {
                if case .sharedInboxBatch(let events) = update, events.contains(where: { $0.id == valid.id }) { delivered.fulfill(); return }
            }
        }
        defer { listener.cancel() }
        await engine.handle(.event(subscriptionID: sub.id, event: valid), from: relayURL)
        await fulfillment(of: [delivered], timeout: 1)
        await engine.handle(.endOfStoredEvents(subscriptionID: sub.id), from: relayURL)
        await engine.refreshSharedInboxAfterPush()
        let resumedValue = await relay.lastInboxFilter()
        let resumed = try XCTUnwrap(resumedValue)
        XCTAssertLessThanOrEqual(resumed.since, valid.createdAt - 172_800)
    }

    func testInterruptedBoardHistoryIsDeliveredWithoutAdvancingResumePastUnseenHistory() async throws {
        let board = Board(id: "audit-board", name: "Audit", relayURLs: [relayURL])
        let (engine, relay) = await setupEngine(board: board)
        let subValue = await relay.lastBoardFilter()
        let sub = try XCTUnwrap(subValue)
        let task = TaskItem(id: "first", boardID: board.id, title: "First")
        let event = try TaskEventCodec.taskEvent(task: task, board: board, createdAt: 1_700_000_000)
        let delivered = expectation(description: "partial history survives disconnect")
        let listener = Task {
            for await update in engine.updates() {
                if case .batch(let tasks, _) = update, tasks.contains(where: { $0.task.id == task.id }) { delivered.fulfill(); return }
            }
        }
        defer { listener.cancel() }
        await engine.handle(.event(subscriptionID: sub.id, event: event), from: relayURL)
        await engine.handle(.disconnected("interrupted before EOSE"), from: relayURL)
        await fulfillment(of: [delivered], timeout: 1)
        await engine.retryNow()
        let resumedValue = await relay.lastBoardFilter()
        let resumed = try XCTUnwrap(resumedValue)
        XCTAssertNil(resumed.since, "A partial newest-first replay is not a completed history checkpoint")
    }

    func testMissingEOSEDoesNotHoldBoardUpdatesIndefinitely() async throws {
        let board = Board(id: "audit-board", name: "Audit", relayURLs: [relayURL])
        let (engine, relay) = await setupEngine(board: board)
        let subValue = await relay.lastBoardFilter()
        let sub = try XCTUnwrap(subValue)
        let event = try TaskEventCodec.taskEvent(task: TaskItem(id: "new", boardID: board.id, title: "New"), board: board, createdAt: 100)
        let delivered = expectation(description: "bounded history flush without EOSE")
        let listener = Task {
            for await update in engine.updates() {
                if case .batch(let tasks, _) = update, tasks.contains(where: { $0.task.id == "new" }) { delivered.fulfill(); return }
            }
        }
        defer { listener.cancel() }
        await engine.handle(.event(subscriptionID: sub.id, event: event), from: relayURL)
        await fulfillment(of: [delivered], timeout: 1)
    }

    func testFalseDuplicateAcknowledgementRetainsDurableEvent() async throws {
        let (engine, _) = await setupEngine()
        let event = try NostrEvent.signed(privateKey: key, createdAt: 100, kind: 1, tags: [], content: "queued")
        try await engine.enqueueForPublish([TaskSyncRelayPublishRequest(event: event, relayURLs: [relayURL], outboxScope: "audit", recordID: event.id)])
        await engine.handle(.acknowledgement(eventID: event.id, accepted: false, message: "duplicate: no acceptance"), from: relayURL)
        let pending = await engine.pendingPublishCount()
        XCTAssertEqual(pending, 1)
        await engine.handle(.acknowledgement(eventID: event.id, accepted: true, message: "duplicate: stored"), from: relayURL)
        let completed = await engine.pendingPublishCount()
        XCTAssertEqual(completed, 0)
    }

    func testConcurrentAuthRequiredRepliesReuseOnePendingAuthorization() async throws {
        let (engine, relay) = await setupEngine()
        await engine.setIdentity(try NostrIdentity(privateKey: key))
        await engine.handle(.auth(challenge: "challenge"), from: relayURL)
        for _ in 0..<8 { await engine.handle(.notice("auth-required: authenticate"), from: relayURL) }
        let count = await relay.authCount
        XCTAssertEqual(count, 1)
    }

    func testInboxPreferenceTieUsesLowestEventIDOnPhoneAndWatch() throws {
        let identity = try NostrIdentity(privateKey: key)
        let first = try NIP17InboxRelayPreference.event(identity: identity, relayURLs: ["wss://one.example"], createdAt: 100)
        let second = try NIP17InboxRelayPreference.event(identity: identity, relayURLs: ["wss://two.example"], createdAt: 100)
        let winner = first.id < second.id ? first : second
        let expected = [try XCTUnwrap(winner.firstTagValue(named: "relay"))]
        for events in [[first, second], [second, first]] {
            XCTAssertEqual(NIP17InboxRelayResolver.relayURLs(from: events, recipientPublicKey: identity.publicKeyHex), expected)
            let watchEvents = try events.map { try JSONDecoder().decode(TaskifyWatchNostrEvent.self, from: JSONEncoder().encode($0)) }
            XCTAssertEqual(TaskifyWatchRelayRouting.resolve(recipientPublicKey: identity.publicKeyHex, events: watchEvents, discoveryComplete: true).relayURLs, expected)
        }
    }

    func testMaximumSupportedNIP44PlaintextRoundTripsIncludingEnvelopeOverhead() throws {
        let plaintext = Data(repeating: 97, count: 2_000_000)
        let encrypted = try NIP44V2.encrypt(plaintext, conversationKey: key)
        XCTAssertEqual(try NIP44V2.decrypt(encrypted, conversationKey: key), plaintext)
        XCTAssertEqual(try TaskifyWatchNIP44V2.decrypt(encrypted, conversationKey: key), plaintext)
        XCTAssertThrowsError(try NIP44V2.decrypt(encrypted, conversationKey: Data()))
    }
}

private actor AuditRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private var boardFilters: [(id: String, since: Int?)] = []
    private var inboxFilters: [(id: String, since: Int)] = []
    private(set) var authCount = 0
    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) { boardFilters.append((id, boards.first?.since)) }
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) { inboxFilters.append((id, since)) }
    func lastBoardFilter() -> (id: String, since: Int?)? { boardFilters.last }
    func lastInboxFilter() -> (id: String, since: Int)? { inboxFilters.last }
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) {}
    func authenticate(_ event: NostrEvent) { authCount += 1 }
}

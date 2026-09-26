import Foundation
import XCTest
@testable import TaskifyCore

/// The outbox audit settles queued deliveries only when the relay's own answer proves them
/// redundant, so a backlog left by an older build drains without resending it and without
/// dropping a change some relay still lacks.
final class OutboxRelayAuditTests: XCTestCase {
    private let relayURL = "wss://audit-relay.example"
    private lazy var board = Board(id: "board", name: "Board", kind: .week, nostrBoardID: "audit-board-id", relayURLs: [relayURL])

    private func task(_ id: String, title: String = "Task", deleted: Bool = false) -> TaskItem {
        var task = TaskItem(id: id, boardID: board.id, title: title,
                            createdAt: Date(timeIntervalSince1970: 1_780_000_000))
        task.deleted = deleted
        return task
    }

    private func event(_ task: TaskItem, at createdAt: Int) throws -> NostrEvent {
        try TaskEventCodec.taskEvent(task: task, board: board, createdAt: createdAt)
    }

    // MARK: - Rules

    func testTombstoneIsRedundantWhereTheTaskIsAlreadyDeletedOrAbsent() throws {
        let ours = try event(task("t", deleted: true), at: 2_000)
        let relayTombstone = try event(task("t", deleted: true), at: 1_000)
        XCTAssertTrue(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: relayTombstone, relayAnsweredCompletely: true, board: board))
        XCTAssertTrue(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: nil, relayAnsweredCompletely: true, board: board),
                      "Nothing stored there: nothing to delete")
        XCTAssertFalse(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: nil, relayAnsweredCompletely: false, board: board),
                       "A relay that didn't finish answering proves nothing")
    }

    func testTombstoneIsStillNeededWhereTheTaskIsLive() throws {
        let ours = try event(task("t", deleted: true), at: 2_000)
        let relayLive = try event(task("t"), at: 1_000)
        XCTAssertFalse(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: relayLive, relayAnsweredCompletely: true, board: board))
    }

    func testANewerRelayVersionWins() throws {
        let ours = try event(task("t", title: "Mine"), at: 1_000)
        let relayNewer = try event(task("t", title: "Theirs"), at: 2_000)
        XCTAssertTrue(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: relayNewer, relayAnsweredCompletely: true, board: board))
    }

    func testALiveVersionIsRedundantOnlyWhenItsContentMatches() throws {
        let ours = try event(task("t", title: "Same"), at: 2_000)
        let relaySame = try event(task("t", title: "Same"), at: 1_000)
        let relayOlderDifferent = try event(task("t", title: "Before the edit"), at: 1_000)
        XCTAssertTrue(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: relaySame, relayAnsweredCompletely: true, board: board))
        XCTAssertFalse(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: relayOlderDifferent, relayAnsweredCompletely: true, board: board))
        XCTAssertFalse(TaskSyncEngine.relayAlreadyHas(ours, relayLatest: nil, relayAnsweredCompletely: true, board: board),
                       "A live change the relay lacks must be delivered")
    }

    // MARK: - Engine

    private func makeEngine(relay: AuditingRelayTransport, outbox: NostrOutboxStore) async -> TaskSyncEngine {
        let engine = TaskSyncEngine(outbox: outbox, connectionFactory: { _ in relay })
        addTeardownBlock { await engine.stop() }
        return engine
    }

    private func makeOutbox() -> NostrOutboxStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
    }

    private func entries(_ events: [NostrEvent]) -> [NostrOutboxEntry] {
        events.map { NostrOutboxEntry(event: $0, relayURLs: [relayURL], boardLocalID: board.id, taskID: $0.firstTagValue(named: "d")!) }
    }

    func testAuditSettlesOnlyTheDeliveriesTheRelayAlreadyHas() async throws {
        let outbox = makeOutbox()
        let relay = AuditingRelayTransport()
        let engine = await makeEngine(relay: relay, outbox: outbox)
        await engine.configure(boards: [board], auxiliaryRelayURLs: [], inboxRelayURLs: [])

        let deletedThere = try event(task("deleted-there", deleted: true), at: 2_000)
        let absentThere = try event(task("absent-there", deleted: true), at: 2_000)
        let liveThere = try event(task("live-there", deleted: true), at: 2_000)
        let unchanged = try event(task("unchanged", title: "Same"), at: 2_000)
        let edited = try event(task("edited", title: "New title"), at: 2_000)
        await relay.store([
            try event(task("deleted-there", deleted: true), at: 1_000),
            try event(task("live-there"), at: 1_000),
            try event(task("unchanged", title: "Same"), at: 1_000),
            try event(task("edited", title: "Old title"), at: 1_000),
        ])
        try await outbox.enqueue(entries([deletedThere, absentThere, liveThere, unchanged, edited]))

        let audit = await engine.reconcileOutboxWithRelays()

        XCTAssertEqual(audit.settledDeliveries, 3)
        let remaining = Set(await outbox.allEntries().map { $0.taskID })
        XCTAssertEqual(remaining, ["live-there", "edited"], "Changes the relay still lacks stay queued")
    }

    /// Relays return fewer events than a request's `limit` when their own cap is lower, so a
    /// short answer must not read as "the rest aren't there".
    func testARelayCappingItsAnswerDoesNotProveAddressesAbsent() async throws {
        let outbox = makeOutbox()
        let relay = AuditingRelayTransport(maximumEventsPerRequest: 2)
        let engine = await makeEngine(relay: relay, outbox: outbox)
        await engine.configure(boards: [board], auxiliaryRelayURLs: [], inboxRelayURLs: [])
        let ids = (0..<5).map { "live-\($0)" }
        await relay.store(try ids.map { try event(task($0), at: 1_000) })
        try await outbox.enqueue(entries(try ids.map { try event(task($0, deleted: true), at: 2_000) }))

        let audit = await engine.reconcileOutboxWithRelays()

        XCTAssertEqual(audit.settledDeliveries, 0, "Every task is live there, so every deletion is still needed")
        let remaining = await outbox.entryCount()
        XCTAssertEqual(remaining, 5)
    }

    func testABacklogIsAuditedOnConnectBeforeAnyOfItIsPublished() async throws {
        let outbox = makeOutbox()
        let relay = AuditingRelayTransport(answerDelay: .milliseconds(150))
        // Tombstones for tasks the relay doesn't hold, left by an older build, plus one real edit.
        var backlog = try (0..<40).map { try event(task("gone-\($0)", deleted: true), at: 2_000) }
        let realEdit = try event(task("edited", title: "New title"), at: 2_000)
        backlog.append(realEdit)
        try await outbox.enqueue(entries(backlog))

        let engine = await makeEngine(relay: relay, outbox: outbox)
        await engine.configure(boards: [board], auxiliaryRelayURLs: [], inboxRelayURLs: [])
        for _ in 0..<200 where await relay.publishedEventIDs.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }

        let published = await relay.publishedEventIDs
        XCTAssertEqual(published, [realEdit.id], "Only the change the relay lacks goes out")
        let remaining = await outbox.allEntries().map(\.taskID)
        XCTAssertEqual(remaining, ["edited"])
    }

    func testSettlingABatchCompletesOnlyEntriesNoRelayStillNeeds() async throws {
        let outbox = makeOutbox()
        let other = "wss://other.example"
        let first = try event(task("a", deleted: true), at: 2_000)
        let second = try event(task("b", deleted: true), at: 2_000)
        try await outbox.enqueue([
            NostrOutboxEntry(event: first, relayURLs: [relayURL, other], boardLocalID: board.id, taskID: "a"),
            NostrOutboxEntry(event: second, relayURLs: [relayURL], boardLocalID: board.id, taskID: "b"),
        ])

        let here = try await outbox.settleDeliveries(eventIDs: [first.id, second.id, "unknown"], relayURL: relayURL)
        XCTAssertEqual(here.settledEventIDs, [first.id, second.id])
        XCTAssertEqual(here.completed.map(\.taskID), ["b"])
        let again = try await outbox.settleDeliveries(eventIDs: [first.id], relayURL: relayURL)
        XCTAssertTrue(again.settledEventIDs.isEmpty, "Already settled there")
        let there = try await outbox.settleDeliveries(eventIDs: [first.id], relayURL: other)
        XCTAssertEqual(there.completed.map(\.taskID), ["a"])
        let remaining = await outbox.entryCount()
        XCTAssertEqual(remaining, 0)
    }
}

/// Answers one-shot lookups from a fixed set of stored events, like a relay: newest first,
/// optionally capped below the request's limit, and optionally after a network delay.
private actor AuditingRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private let maximumEventsPerRequest: Int
    private let answerDelay: Duration
    private var stored: [NostrEvent] = []
    private(set) var publishedEventIDs: [String] = []

    init(maximumEventsPerRequest: Int = .max, answerDelay: Duration = .zero) {
        self.maximumEventsPerRequest = maximumEventsPerRequest
        self.answerDelay = answerDelay
    }

    func store(_ events: [NostrEvent]) { stored.append(contentsOf: events) }

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
    func request(id: String, filter: NostrRelayFilter) {
        let addresses = Set(filter.dTags ?? [])
        let matches = stored
            .filter {
                filter.kinds.contains($0.kind)
                    && filter.authors.contains($0.publicKey)
                    && addresses.contains($0.firstTagValue(named: "d") ?? "")
            }
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(min(filter.limit, maximumEventsPerRequest))
        let continuation = stream.continuation
        let delay = answerDelay
        Task {
            if delay > .zero { try? await Task.sleep(for: delay) }
            for event in matches {
                continuation.yield(.event(subscriptionID: id, event: event))
            }
            continuation.yield(.endOfStoredEvents(subscriptionID: id))
        }
    }
}

/// A task's publish fingerprint identifies what other clients would see, so an unchanged state
/// is never republished.
final class PublishFingerprintTests: XCTestCase {
    private let board = Board(id: "board", name: "Board", kind: .week, nostrBoardID: "fingerprint-board")

    func testEveryTombstoneReadsTheSame() {
        var a = TaskItem(id: "a", boardID: "board", title: "One")
        var b = TaskItem(id: "a", boardID: "elsewhere", title: "Two", recurrence: .daily())
        a.deleted = true
        b.deleted = true
        XCTAssertEqual(TaskEventCodec.publishFingerprint(task: a, board: board), "deleted")
        XCTAssertEqual(TaskEventCodec.publishFingerprint(task: a, board: board),
                       TaskEventCodec.publishFingerprint(task: b, board: board))
    }

    func testAPublishedTaskAndItsDecodedCopyMatch() throws {
        let task = TaskItem(id: "t", boardID: "board", title: "Buy milk", note: "2%",
                            createdAt: Date(timeIntervalSince1970: 1_780_000_000))
        let decoded = try TaskEventCodec.decodeTaskEvent(
            try TaskEventCodec.taskEvent(task: task, board: board, createdAt: 1_000), board: board
        ).task
        XCTAssertEqual(TaskEventCodec.publishFingerprint(task: task, board: board),
                       TaskEventCodec.publishFingerprint(task: decoded, board: board))
        var edited = task
        edited.title = "Buy oat milk"
        XCTAssertNotEqual(TaskEventCodec.publishFingerprint(task: task, board: board),
                          TaskEventCodec.publishFingerprint(task: edited, board: board))
    }

    func testMergingARelayVersionRecordsItsFingerprint() throws {
        var snapshot = TaskifySnapshot.empty
        snapshot.boards.append(board)
        let remote = TaskItem(id: "t", boardID: "board", title: "From another device")
        XCTAssertTrue(snapshot.mergeRemoteTasks([(task: remote, eventCreatedAt: 1_000)]))
        XCTAssertEqual(snapshot.tasks.first { $0.id == "t" }?.publishedFingerprint,
                       TaskEventCodec.publishFingerprint(task: remote, board: board))
    }
}

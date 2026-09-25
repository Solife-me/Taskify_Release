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

    func testAuditSettlesOnlyTheDeliveriesTheRelayAlreadyHas() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let outbox = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let relay = AuditingRelayTransport()
        let engine = TaskSyncEngine(outbox: outbox, connectionFactory: { _ in relay })
        addTeardownBlock { await engine.stop() }
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
        try await outbox.enqueue([deletedThere, absentThere, liveThere, unchanged, edited].map {
            NostrOutboxEntry(event: $0, relayURLs: [relayURL], boardLocalID: board.id, taskID: $0.firstTagValue(named: "d")!)
        })

        let audit = await engine.reconcileOutboxWithRelays()

        XCTAssertEqual(audit.settledDeliveries, 3)
        let remaining = Set(await outbox.allEntries().map { $0.taskID })
        XCTAssertEqual(remaining, ["live-there", "edited"], "Changes the relay still lacks stay queued")
    }
}

/// Answers one-shot lookups from a fixed set of stored events, like a relay.
private actor AuditingRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private var stored: [NostrEvent] = []

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
    func publish(_ event: NostrEvent) {}
    func authenticate(_ event: NostrEvent) {}
    func request(id: String, filter: NostrRelayFilter) {
        let addresses = Set(filter.dTags ?? [])
        for event in stored where filter.kinds.contains(event.kind)
            && filter.authors.contains(event.publicKey)
            && addresses.contains(event.firstTagValue(named: "d") ?? "") {
            stream.continuation.yield(.event(subscriptionID: id, event: event))
        }
        stream.continuation.yield(.endOfStoredEvents(subscriptionID: id))
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

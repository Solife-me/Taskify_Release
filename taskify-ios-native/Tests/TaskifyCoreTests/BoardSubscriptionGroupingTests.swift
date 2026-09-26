import Foundation
import XCTest
@testable import TaskifyCore

/// Relays cap concurrent REQs per connection (nos.lol: "ERROR: too many concurrent REQs"), and an
/// account with compound boards easily has dozens of boards. Boards share a few REQs, one filter
/// each, so every board keeps its own history cursor.
final class BoardSubscriptionGroupingTests: XCTestCase {
    private let relayURL = "wss://grouping.example"

    private func boards(_ count: Int) -> [Board] {
        (0..<count).map { Board(id: "board-\($0)", name: "Board \($0)", relayURLs: [relayURL]) }
    }

    private func setupEngine(boards: [Board]) async -> (TaskSyncEngine, GroupingRelayTransport) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let relay = GroupingRelayTransport()
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { _ in relay }
        )
        addTeardownBlock { await engine.stop() }
        await engine.configure(boards: boards, auxiliaryRelayURLs: [relayURL], inboxRelayURLs: [])
        return (engine, relay)
    }

    func testManyBoardsShareAFewSubscriptions() async throws {
        let all = boards(25)
        let (_, relay) = await setupEngine(boards: all)
        let requests = await relay.subscriptions
        XCTAssertEqual(requests.count, 3, "25 boards need 3 REQs, not 25")
        XCTAssertTrue(requests.allSatisfy { $0.boards.count <= BoardSubscriptionGrouping.boardsPerSubscription })
        let tags = requests.flatMap { $0.boards.map(\.boardTag) }
        XCTAssertEqual(tags.count, 25)
        XCTAssertEqual(Set(tags), Set(all.map { BoardCrypto.boardTag(for: $0.effectiveNostrBoardID) }))
    }

    func testEventOnAGroupedSubscriptionIsDeliveredAndResumesOnlyItsOwnBoard() async throws {
        let all = boards(12)
        let (engine, relay) = await setupEngine(boards: all)
        let board = all[7]
        let tag = BoardCrypto.boardTag(for: board.effectiveNostrBoardID)
        let first = await relay.subscriptions
        let group = try XCTUnwrap(first.first { $0.boards.contains { $0.boardTag == tag } })

        let createdAt = Int(Date().timeIntervalSince1970) - 60
        let event = try TaskEventCodec.taskEvent(
            task: TaskItem(id: "grouped", boardID: board.id, title: "Grouped"),
            board: board,
            createdAt: createdAt
        )
        let delivered = expectation(description: "event on a grouped REQ is delivered")
        let listener = Task {
            for await update in engine.updates() {
                if case .batch(let tasks, _) = update, tasks.contains(where: { $0.task.id == "grouped" }) {
                    delivered.fulfill()
                    return
                }
            }
        }
        defer { listener.cancel() }
        await engine.handle(.event(subscriptionID: group.id, event: event), from: relayURL)
        for request in first {
            await engine.handle(.endOfStoredEvents(subscriptionID: request.id), from: relayURL)
        }
        await fulfillment(of: [delivered], timeout: 1)

        await relay.reset()
        await engine.retryNow()
        let resumed = await relay.subscriptions
        let since = Dictionary(uniqueKeysWithValues: resumed.flatMap(\.boards).map { ($0.boardTag, $0.since) })
        XCTAssertEqual(since.count, 12)
        let resumedSince = try XCTUnwrap(since[tag] ?? nil, "The board that saw history resumes from its cursor")
        XCTAssertLessThanOrEqual(resumedSince, createdAt)
        for other in all where other.id != board.id {
            let otherTag = BoardCrypto.boardTag(for: other.effectiveNostrBoardID)
            XCTAssertEqual(since[otherTag], .some(nil), "Boards that saw nothing still load their full history")
        }
    }

    func testAnEventOnAnotherGroupsSubscriptionIsIgnored() async throws {
        let all = boards(12)
        let (engine, relay) = await setupEngine(boards: all)
        let board = all[3]
        let tag = BoardCrypto.boardTag(for: board.effectiveNostrBoardID)
        let requests = await relay.subscriptions
        let wrongGroup = try XCTUnwrap(requests.first { !$0.boards.contains { $0.boardTag == tag } })
        let event = try TaskEventCodec.taskEvent(
            task: TaskItem(id: "misrouted", boardID: board.id, title: "Misrouted"),
            board: board,
            createdAt: 100
        )
        let witness = DeliveryWitness()
        let listener = Task {
            for await update in engine.updates() {
                if case .batch(let tasks, _) = update, tasks.contains(where: { $0.task.id == "misrouted" }) {
                    await witness.record()
                }
            }
        }
        defer { listener.cancel() }
        try await Task.sleep(for: .milliseconds(50))
        await engine.handle(.event(subscriptionID: wrongGroup.id, event: event), from: relayURL)
        await engine.handle(.endOfStoredEvents(subscriptionID: wrongGroup.id), from: relayURL)
        try await Task.sleep(for: .milliseconds(300))
        let delivered = await witness.delivered
        XCTAssertFalse(delivered)

        // The same event on its own group's REQ is delivered, so the check above is meaningful.
        let rightGroup = try XCTUnwrap(requests.first { $0.boards.contains { $0.boardTag == tag } })
        await engine.handle(.event(subscriptionID: rightGroup.id, event: event), from: relayURL)
        await engine.handle(.endOfStoredEvents(subscriptionID: rightGroup.id), from: relayURL)
        try await Task.sleep(for: .milliseconds(300))
        let deliveredOnOwnGroup = await witness.delivered
        XCTAssertTrue(deliveredOnOwnGroup)
    }

    func testGroupingIsStableForTheSameBoards() {
        let tags = (0..<23).map { "tag-\($0)" }
        let first = BoardSubscriptionGrouping(relayURL: relayURL, boardTags: tags)
        let again = BoardSubscriptionGrouping(relayURL: relayURL, boardTags: tags.reversed())
        XCTAssertEqual(first, again)
        XCTAssertEqual(first.groups.map(\.boardTags.count), [10, 10, 3])
        // Removing the last board in sort order leaves the earlier groups, and their REQs, as they were.
        let fewer = BoardSubscriptionGrouping(relayURL: relayURL, boardTags: tags.sorted().dropLast())
        XCTAssertEqual(Array(fewer.groups.prefix(2)), Array(first.groups.prefix(2)))
        XCTAssertNotEqual(fewer.groups.last?.id, first.groups.last?.id)
    }
}

private actor GroupingRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private(set) var subscriptions: [(id: String, boards: [BoardSubscriptionFilter])] = []

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {
        subscriptions.append((id, boards))
    }
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) {}
    func authenticate(_ event: NostrEvent) {}
    func reset() { subscriptions.removeAll() }
}

private actor DeliveryWitness {
    private(set) var delivered = false
    func record() { delivered = true }
}

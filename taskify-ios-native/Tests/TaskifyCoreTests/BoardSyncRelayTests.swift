import Foundation
import XCTest
@testable import TaskifyCore

/// Each device keeps its own relay list per board, and those drift apart. Every board also syncs
/// on Taskify's relay, so two devices always share one.
final class BoardSyncRelayTests: XCTestCase {
    private let taskifyRelay = TaskifyRelayDefaults.taskifyRelayURL

    func testEveryBoardAlsoSyncsOnTaskifysRelay() {
        let publicOnly = Board(id: "meal-plan", name: "Meal plan", relayURLs: ["wss://relay.damus.io", "wss://nos.lol"])
        XCTAssertEqual(publicOnly.effectiveRelayURLs, ["wss://relay.damus.io", "wss://nos.lol"], "The board's own list is unchanged")
        XCTAssertEqual(publicOnly.syncRelayURLs, ["wss://relay.damus.io", "wss://nos.lol", taskifyRelay])
        let alreadyListed = Board(id: "b", name: "B", relayURLs: [taskifyRelay + "/", "wss://nos.lol"])
        XCTAssertEqual(alreadyListed.syncRelayURLs, [taskifyRelay, "wss://nos.lol"])
    }

    func testAnEventArrivingOnTaskifysRelayIsAcceptedForABoardThatDoesntListIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let transports = RelayTransportsByURL()
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { url in transports.transport(for: url) }
        )
        addTeardownBlock { await engine.stop() }
        let board = Board(id: "meal-plan", name: "Meal plan", kind: .week, nostrBoardID: "meal-plan-id",
                          relayURLs: ["wss://relay.damus.io"])
        await engine.configure(boards: [board], auxiliaryRelayURLs: [], inboxRelayURLs: [])

        let subscriptions = await transports.transport(for: taskifyRelay).subscriptions
        let subscription = try XCTUnwrap(subscriptions.first, "The board is subscribed on Taskify's relay")

        let event = try TaskEventCodec.taskEvent(
            task: TaskItem(id: "milk", boardID: board.id, title: "Milk"),
            board: board,
            createdAt: Int(Date().timeIntervalSince1970) - 30
        )
        let delivered = expectation(description: "delivered")
        let listener = Task {
            for await update in engine.updates() {
                switch update {
                case .task(let record) where record.task.id == "milk": delivered.fulfill(); return
                case .batch(let tasks, _) where tasks.contains(where: { $0.task.id == "milk" }): delivered.fulfill(); return
                default: continue
                }
            }
        }
        defer { listener.cancel() }
        await engine.handle(.event(subscriptionID: subscription, event: event), from: taskifyRelay)
        await engine.handle(.endOfStoredEvents(subscriptionID: subscription), from: taskifyRelay)
        await fulfillment(of: [delivered], timeout: 1)
    }
}

private final class RelayTransportsByURL: @unchecked Sendable {
    private let lock = NSLock()
    private var transports: [String: SubscriptionRecordingRelay] = [:]
    func transport(for url: String) -> SubscriptionRecordingRelay {
        lock.lock(); defer { lock.unlock() }
        if let existing = transports[url] { return existing }
        let created = SubscriptionRecordingRelay()
        transports[url] = created
        return created
    }
}

private actor SubscriptionRecordingRelay: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private(set) var subscriptions: [String] = []
    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) { subscriptions.append(id) }
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) {}
    func authenticate(_ event: NostrEvent) {}
}

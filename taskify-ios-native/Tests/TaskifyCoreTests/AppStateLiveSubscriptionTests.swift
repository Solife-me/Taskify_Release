import Foundation
import XCTest
@testable import TaskifyCore

/// Another device's read markers and inbox answers reach a running app through the sync engine's
/// live subscription to the account's own app-state records, not only on the next launch.
final class AppStateLiveSubscriptionTests: XCTestCase {
    private let relayURL = "wss://account.example"

    private func makeEngine(relay: AppStateRecordingTransport) -> TaskSyncEngine {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { _ in relay }
        )
        addTeardownBlock { await engine.stop() }
        return engine
    }

    private func identity(_ seed: Int) throws -> NostrIdentity {
        try NostrIdentity(privateKey: Data(hex: String(format: "%064x", seed)))
    }

    private func chatStateEvent(_ identity: NostrIdentity, createdAt: Int = 1_700_000_000) throws -> NostrEvent {
        try AppStateSyncContract.event(
            dTag: AppStateSyncContract.chatStateDTag,
            payload: ChatStateSyncPayload(
                timestamp: createdAt,
                state: ChatSyncState(inboxResponses: ["wrap": ChatInboxResponse(status: .accepted, at: createdAt)])
            ),
            identity: identity,
            createdAt: createdAt
        )
    }

    func testSubscribesToOwnRecordsAndDeliversAnotherDevicesPublish() async throws {
        let account = try identity(1)
        let relay = AppStateRecordingTransport()
        let engine = makeEngine(relay: relay)
        await engine.configure(boards: [], inboxRelayURLs: [])
        await engine.setAppStateSubscription(authorPublicKey: account.publicKeyHex, relayURLs: [relayURL])

        let requests = await relay.requests
        let request = try XCTUnwrap(requests.last)
        XCTAssertEqual(request.filter.kinds, [AppStateSyncContract.eventKind])
        XCTAssertEqual(request.filter.authors, [account.publicKeyHex])
        XCTAssertEqual(request.filter.dTags, AppStateSyncContract.dTags)

        let event = try chatStateEvent(account)
        let delivered = Task { () -> String? in
            for await update in engine.updates() {
                if case .appState(let received) = update { return received.id }
            }
            return nil
        }
        // The same copy again, as a second relay or a reconnect replay would send it.
        relay.send(.event(subscriptionID: request.id, event: event))
        relay.send(.event(subscriptionID: request.id, event: event))
        let receivedID = await delivered.value
        XCTAssertEqual(receivedID, event.id)
    }

    func testIgnoresRecordsSignedByAnotherAccount() async throws {
        let account = try identity(1)
        let stranger = try identity(2)
        let relay = AppStateRecordingTransport()
        let engine = makeEngine(relay: relay)
        await engine.configure(boards: [], inboxRelayURLs: [])
        await engine.setAppStateSubscription(authorPublicKey: account.publicKeyHex, relayURLs: [relayURL])
        let allRequests = await relay.requests
        let request = try XCTUnwrap(allRequests.last)

        let collected = Task {
            var ids: [String] = []
            for await update in engine.updates() {
                if case .appState(let received) = update { ids.append(received.id) }
                if ids.count == 1 { break }
            }
            return ids
        }
        let forged = try chatStateEvent(stranger, createdAt: 1_700_000_001)
        let genuine = try chatStateEvent(account, createdAt: 1_700_000_002)
        relay.send(.event(subscriptionID: request.id, event: forged))
        relay.send(.event(subscriptionID: request.id, event: genuine))
        let ids = await collected.value
        XCTAssertEqual(ids, [genuine.id])
    }

    func testClearingTheAuthorClosesTheSubscription() async throws {
        let account = try identity(1)
        let relay = AppStateRecordingTransport()
        let engine = makeEngine(relay: relay)
        // The relay stays connected for boards, so only the app-state REQ should go.
        let board = Board(
            id: "board",
            name: "Board",
            nostrBoardID: "f1a75d28-1ce5-489a-b53a-1e2a447b0cf7",
            relayURLs: [relayURL]
        )
        await engine.configure(boards: [board], inboxRelayURLs: [])
        await engine.setAppStateSubscription(authorPublicKey: account.publicKeyHex, relayURLs: [relayURL])
        let allRequests = await relay.requests
        let request = try XCTUnwrap(allRequests.last)

        await engine.setAppStateSubscription(authorPublicKey: nil, relayURLs: [])

        let closed = await relay.closedSubscriptionIDs
        XCTAssertEqual(closed, [request.id])
    }

    func testFingerprintAddsAppStateRelaysWithoutWideningTheInbox() throws {
        let author = String(repeating: "a", count: 64)
        let fingerprint = TaskSyncConfigurationFingerprint(
            boards: [],
            auxiliaryRelayURLs: ["wss://inbox.example"],
            inboxPublicKey: author,
            appStateAuthor: author,
            appStateRelayURLs: ["wss://account.example/"]
        )
        let accountPlan = try XCTUnwrap(fingerprint.relayPlans.first { $0.relayURL == "wss://account.example" })
        let inboxPlan = try XCTUnwrap(fingerprint.relayPlans.first { $0.relayURL == "wss://inbox.example" })
        XCTAssertEqual(accountPlan.appStateAuthor, author)
        XCTAssertNil(accountPlan.inboxPublicKey, "The inbox fallback set is unchanged by app-state relays")
        XCTAssertNil(inboxPlan.appStateAuthor)
        XCTAssertEqual(inboxPlan.inboxPublicKey, author)
    }
}

private actor AppStateRecordingTransport: TaskSyncRelayTransport {
    private nonisolated let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private(set) var requests: [(id: String, filter: NostrRelayFilter)] = []
    private(set) var closedSubscriptionIDs: [String] = []

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    nonisolated func send(_ message: NostrRelayMessage) { stream.continuation.yield(message) }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {}
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) { closedSubscriptionIDs.append(id) }
    func authenticate(_ event: NostrEvent) {}
    func publish(_ event: NostrEvent) async {}
    func request(id: String, filter: NostrRelayFilter) async throws {
        requests.append((id, filter))
    }
}

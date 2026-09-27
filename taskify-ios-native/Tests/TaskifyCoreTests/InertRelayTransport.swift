import Foundation
@testable import TaskifyCore

/// A relay connection that never says anything, for the relays a test isn't about. Every board
/// also syncs on Taskify's relay (`Board.syncRelayURLs`), so a test giving one fake to every
/// relay URL would have two connections read, and split, that fake's single message stream.
actor InertRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {}
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) {}
    func authenticate(_ event: NostrEvent) {}
}

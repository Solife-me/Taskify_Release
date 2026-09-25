import Foundation
import XCTest
@testable import TaskifyCore

/// Tests use ordinary, small EVENT payloads and no sockets. A suspended send models either
/// URLSession waiting on a slow relay or that relay's publish-pacing window.
final class RelayOutboxLatencyTests: XCTestCase {
    private let healthyURL = "wss://healthy.example"
    private let slowURL = "wss://slow.example"

    private func event(_ number: Int) -> NostrEvent {
        NostrEvent(id: String(format: "%064x", number), publicKey: String(repeating: "a", count: 64),
            createdAt: number, kind: NIP17GiftWrap.wrapKind, tags: [],
            content: "ordinary-message-\(number)", signature: "fixture")
    }

    private func request(_ number: Int, relayURL: String) -> TaskSyncRelayPublishRequest {
        TaskSyncRelayPublishRequest(event: event(number), relayURLs: [relayURL],
            outboxScope: "chat", recordID: "message-\(number)", acknowledgementPolicy: .anyRelay)
    }

    private func engine(
        transports: [String: SuspensibleRelayTransport],
        publishAcknowledgementTimeout: Duration = .seconds(45)
    ) -> TaskSyncEngine {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { transports[$0]! },
            publishAcknowledgementTimeout: publishAcknowledgementTimeout
        )
        addTeardownBlock { await engine.stop() }
        return engine
    }

    func testQueueDiagnosticsPreservePartialAcceptanceAndRejectionDetails() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let queued = NostrOutboxEntry(event: event(1), relayURLs: [healthyURL, slowURL],
            boardLocalID: "board", taskID: "task", dependsOnEventID: "parent")
        try await outbox.enqueue(queued)
        _ = try await outbox.markAccepted(eventID: queued.id, relayURL: healthyURL)
        let retryAfter = try await outbox.recordRejection(eventID: queued.id, relayURL: slowURL)
        let engine = TaskSyncEngine(outbox: outbox)
        let records = await engine.pendingOutboxRecords()
        let record = try XCTUnwrap(records.first)
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(record.pendingRelayURLs, [slowURL])
        XCTAssertEqual(record.acceptedRelayCount, 1)
        XCTAssertEqual(record.eventKind, queued.event.kind)
        XCTAssertEqual(record.dependsOnEventID, "parent")
        XCTAssertEqual(record.relayRejections[slowURL]?.retryAfter, retryAfter)
        let retainedCount = await outbox.entryCount()
        XCTAssertEqual(retainedCount, 1, "Inspecting a partially delivered change must not clear it")
        await engine.stop()
    }

    /// An acknowledgement is read only after every message the relay sent before it, so after a
    /// reconnect it can wait behind a long history replay. That relay is alive: timing it out
    /// dropped the connection, which replayed the history again, and the queue never drained.
    func testAcknowledgementQueuedBehindIncomingMessagesDoesNotTimeOut() async throws {
        let relay = SuspensibleRelayTransport()
        let engine = engine(transports: [healthyURL: relay], publishAcknowledgementTimeout: .milliseconds(300))
        let timedOut = TimeoutWitness()
        let watcher = Task {
            for await update in engine.updates() {
                guard case .status(let report) = update else { continue }
                if report.relays.contains(where: { $0.message?.contains("acknowledgement timed out") == true }) {
                    await timedOut.record()
                }
            }
        }
        defer { watcher.cancel() }
        await engine.configure(boards: [], auxiliaryRelayURLs: [healthyURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([request(1, relayURL: healthyURL)])
        for _ in 0..<50 where await relay.publishedEventIDs.isEmpty {
            try await Task.sleep(for: .milliseconds(20))
        }
        let sent = await relay.publishedEventIDs
        XCTAssertEqual(sent, [event(1).id])

        // The relay keeps talking for three timeout periods before its acknowledgement arrives.
        for _ in 0..<9 {
            await engine.handle(.notice("history replay in progress"), from: healthyURL)
            try await Task.sleep(for: .milliseconds(100))
        }
        await engine.handle(.acknowledgement(eventID: event(1).id, accepted: true, message: ""), from: healthyURL)
        let pending = await engine.pendingOutboxRecords()
        XCTAssertTrue(pending.isEmpty)
        try await Task.sleep(for: .milliseconds(100))
        let didTimeOut = await timedOut.fired
        XCTAssertFalse(didTimeOut, "A relay still delivering messages must not be timed out and dropped")
    }

    func testBusyRelayThatNeverAcknowledgesStillTimesOutEventually() async throws {
        let relay = SuspensibleRelayTransport()
        let engine = engine(transports: [healthyURL: relay], publishAcknowledgementTimeout: .milliseconds(200))
        let timedOut = TimeoutWitness()
        let watcher = Task {
            for await update in engine.updates() {
                guard case .status(let report) = update else { continue }
                if report.relays.contains(where: { $0.message?.contains("acknowledgement timed out") == true }) {
                    await timedOut.record()
                }
            }
        }
        defer { watcher.cancel() }
        await engine.configure(boards: [], auxiliaryRelayURLs: [healthyURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([request(1, relayURL: healthyURL)])
        // Live traffic for twice the 4x cap, with no acknowledgement for the queued event.
        for _ in 0..<32 {
            await engine.handle(.notice("live traffic"), from: healthyURL)
            try await Task.sleep(for: .milliseconds(50))
        }
        let didTimeOut = await timedOut.fired
        XCTAssertTrue(didTimeOut, "Traffic extends the wait for an acknowledgement, but not indefinitely")
    }

    /// strfry refuses an event forever once it holds a deletion covering it or a newer version of
    /// its address. Retrying on every reconnect left it queued ("Rejected one queued change").
    func testDeletedOrReplacedRejectionSettlesThatRelay() async throws {
        for (number, message) in [(1, "deleted: user requested deletion"), (2, "replaced: have newer event")] {
            let relay = SuspensibleRelayTransport()
            let engine = engine(transports: [healthyURL: relay])
            await engine.configure(boards: [], auxiliaryRelayURLs: [healthyURL], inboxRelayURLs: [])
            try await engine.enqueueForPublish([request(number, relayURL: healthyURL)])
            for _ in 0..<50 where await relay.publishedEventIDs.isEmpty {
                try await Task.sleep(for: .milliseconds(20))
            }
            await engine.handle(.acknowledgement(eventID: event(number).id, accepted: false, message: message), from: healthyURL)
            let pending = await engine.pendingOutboxRecords()
            XCTAssertTrue(pending.isEmpty, "\(message) must not leave the change queued")
        }
    }

    func testOtherRejectionsStayQueued() async throws {
        for (number, message) in [(3, "duplicate: have this event"), (4, "error: database busy")] {
            let relay = SuspensibleRelayTransport()
            let engine = engine(transports: [healthyURL: relay])
            await engine.configure(boards: [], auxiliaryRelayURLs: [healthyURL], inboxRelayURLs: [])
            try await engine.enqueueForPublish([request(number, relayURL: healthyURL)])
            for _ in 0..<50 where await relay.publishedEventIDs.isEmpty {
                try await Task.sleep(for: .milliseconds(20))
            }
            await engine.handle(.acknowledgement(eventID: event(number).id, accepted: false, message: message), from: healthyURL)
            let pending = await engine.pendingOutboxRecords()
            XCTAssertEqual(pending.count, 1, "\(message) is retried")
        }
    }

    func testSilentRelayStillTimesOutAndRetries() async throws {
        let relay = SuspensibleRelayTransport()
        let engine = engine(transports: [healthyURL: relay], publishAcknowledgementTimeout: .milliseconds(300))
        await engine.configure(boards: [], auxiliaryRelayURLs: [healthyURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([request(1, relayURL: healthyURL)])
        for _ in 0..<150 where await relay.publishedEventIDs.count < 2 {
            try await Task.sleep(for: .milliseconds(20))
        }
        let sent = await relay.publishedEventIDs
        XCTAssertGreaterThanOrEqual(sent.count, 2, "With no traffic at all, the send is presumed lost and retried")
    }

    func testRateLimitedSubscriptionPausesPublishingAndDoesNotRetryAfterOneSecond() async throws {
        let relay = SuspensibleRelayTransport()
        let engine = engine(transports: [healthyURL: relay])
        await engine.configure(boards: [], inboxPublicKey: String(repeating: "a", count: 64),
            inboxRelayURLs: [healthyURL])
        let filters = await relay.inboxFilters
        let subscription = try XCTUnwrap(filters.first).id
        await engine.handle(.closed(subscriptionID: subscription, message: "rate-limited: slow down"),
            from: healthyURL)
        try await engine.enqueueForPublish([request(100, relayURL: healthyURL)])
        try await Task.sleep(for: .milliseconds(1_200))
        let count = await relay.inboxSubscriptionCount
        let published = await relay.publishedEventIDs
        XCTAssertEqual(count, 1, "CLOSED rate limits must honor the relay cooldown")
        XCTAssertTrue(published.isEmpty, "A relay-wide rate limit must pause queued publishing too")
        try await Task.sleep(for: .milliseconds(1_200))
        let resumedSubscriptions = await relay.inboxSubscriptionCount
        let resumedPublishes = await relay.publishedEventIDs
        XCTAssertEqual(resumedSubscriptions, 2, "History recovery resumes after the cooldown")
        XCTAssertEqual(resumedPublishes, [event(100).id], "The queued change is preserved and sent once")
    }

    func testNewMessageReachesHealthyRelayWhileAnotherRelaySendRemainsSuspended() async throws {
        let slowStarted = expectation(description: "slow relay starts its send")
        let healthySent = expectation(description: "new chat reaches healthy relay")
        let slow = SuspensibleRelayTransport(suspendsPublishes: true) { _ in slowStarted.fulfill() }
        let healthy = SuspensibleRelayTransport { _ in healthySent.fulfill() }
        let engine = engine(transports: [slowURL: slow, healthyURL: healthy])
        await engine.configure(boards: [], auxiliaryRelayURLs: [slowURL, healthyURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([request(1, relayURL: slowURL)])
        await fulfillment(of: [slowStarted], timeout: 1)

        let start = ContinuousClock.now
        try await engine.enqueueForPublish([request(2, relayURL: healthyURL)])
        await fulfillment(of: [healthySent], timeout: 0.75)
        XCTAssertLessThan(start.duration(to: .now), .milliseconds(750))
        let slowIsSuspended = await slow.suspendedSendCount
        let sent = await healthy.publishedEventIDs
        XCTAssertEqual(slowIsSuspended, 1, "The healthy send must complete before releasing the slow relay")
        XCTAssertEqual(sent, [event(2).id])
        await slow.resumePublishes()
    }

    func testAcknowledgementRefillsHealthyRelayWindowWhileOtherRelayIsSuspended() async throws {
        let slowStarted = expectation(description: "slow relay starts")
        let firstWindow = expectation(description: "four healthy in-flight sends")
        firstWindow.expectedFulfillmentCount = 4
        let refilled = expectation(description: "healthy acknowledgement admits next message")
        let slow = SuspensibleRelayTransport(suspendsPublishes: true) { _ in slowStarted.fulfill() }
        let healthy = SuspensibleRelayTransport { count in
            if count <= 4 { firstWindow.fulfill() } else { refilled.fulfill() }
        }
        let engine = engine(transports: [slowURL: slow, healthyURL: healthy])
        await engine.configure(boards: [], auxiliaryRelayURLs: [slowURL, healthyURL], inboxRelayURLs: [])
        try await engine.enqueueForPublish([request(1, relayURL: slowURL)] +
            (2...7).map { request($0, relayURL: healthyURL) })
        await fulfillment(of: [slowStarted, firstWindow], timeout: 1)
        let before = await healthy.publishedEventIDs
        XCTAssertEqual(before.count, 4)
        let acceptedID = try XCTUnwrap(before.first)
        await engine.handle(.acknowledgement(eventID: acceptedID, accepted: true, message: ""), from: healthyURL)
        await fulfillment(of: [refilled], timeout: 0.75)
        let after = await healthy.publishedEventIDs
        let slowIsSuspended = await slow.suspendedSendCount
        XCTAssertEqual(after.count, 5)
        XCTAssertEqual(Set(after).count, 5, "Coalesced drain requests must not duplicate in-flight events")
        XCTAssertEqual(slowIsSuspended, 1)
        await slow.resumePublishes()
    }

    func testSwitchingChatDeliveryRelaysDoesNotReplayUnchangedInbox() async {
        let inbox = SuspensibleRelayTransport()
        let firstPeer = SuspensibleRelayTransport()
        let secondPeer = SuspensibleRelayTransport()
        let secondPeerURL = "wss://second-peer.example"
        let engine = engine(transports: [healthyURL: inbox, slowURL: firstPeer, secondPeerURL: secondPeer])
        for index in 0..<20 {
            await engine.configure(boards: [],
                auxiliaryRelayURLs: [index.isMultiple(of: 2) ? slowURL : secondPeerURL],
                inboxPublicKey: String(repeating: "a", count: 64), inboxRelayURLs: [healthyURL])
        }
        let subscriptionCount = await inbox.inboxSubscriptionCount
        XCTAssertEqual(subscriptionCount, 1)
    }

    func testHundredMessageChatBecomesIdleAfterItsSendIsAcknowledged() async throws {
        let relay = SuspensibleRelayTransport(automaticallyAcknowledges: true)
        let engine = engine(transports: [healthyURL: relay])
        let publicKey = String(repeating: "a", count: 64)
        await engine.configure(boards: [], inboxPublicKey: publicKey, inboxRelayURLs: [healthyURL])
        let subscription = await engine.beginSharedInboxReplay(relayURL: healthyURL, publicKey: publicKey)
        for number in 1...100 {
            await engine.handle(.event(subscriptionID: subscription, event: event(number)), from: healthyURL)
        }
        await engine.handle(.endOfStoredEvents(subscriptionID: subscription), from: healthyURL)

        let accepted = expectation(description: "outgoing chat acknowledged")
        let observation = Task {
            for await update in engine.updates() {
                if case .publishState(_, .sent) = update { accepted.fulfill(); return }
            }
        }
        defer { observation.cancel() }
        try await engine.enqueueForPublish([request(101, relayURL: healthyURL)])
        await fulfillment(of: [accepted], timeout: 1)
        // Cross the old one-second retry cadence with no user or relay input.
        try await Task.sleep(for: .milliseconds(1_100))
        let pending = await engine.pendingPublishCount()
        let connectionCount = await relay.connectionCount
        let subscriptionCount = await relay.inboxSubscriptionCount
        let published = await relay.publishedEventIDs
        XCTAssertEqual(pending, 0)
        XCTAssertEqual(connectionCount, 1)
        XCTAssertEqual(subscriptionCount, 1)
        XCTAssertEqual(published, [event(101).id])
    }

    func testRepeatedUnchangedRelayStatusesEmitOnlyOneReport() async {
        // Reports are assembled from the relays the engine tracks, so the notice source must
        // be a configured relay; notices from an untracked relay can never change a report.
        let relay = SuspensibleRelayTransport()
        let engine = engine(transports: [healthyURL: relay])
        await engine.configure(boards: [], auxiliaryRelayURLs: [healthyURL], inboxRelayURLs: [])
        for _ in 0..<500 { await engine.handle(.notice("same relay status"), from: healthyURL) }
        await engine.handle(.notice("finished"), from: healthyURL)
        var repeatedReports = 0
        for await update in engine.updates() {
            guard case .status(let report) = update else { continue }
            if report.relays.contains(where: { $0.message == "finished" }) { break }
            if report.relays.contains(where: { $0.message == "same relay status" }) { repeatedReports += 1 }
        }
        XCTAssertEqual(repeatedReports, 1)
    }

    func testRefreshedInboxReceivesBackdatedNewMessageOnceAcrossThreeRelays() async throws {
        let thirdURL = "wss://third-inbox.example"
        let transports = [healthyURL: SuspensibleRelayTransport(), slowURL: SuspensibleRelayTransport(),
                          thirdURL: SuspensibleRelayTransport()]
        let engine = engine(transports: transports)
        let publicKey = String(repeating: "a", count: 64)
        let now = Int(Date().timeIntervalSince1970)
        func wrap(_ number: Int, createdAt: Int) -> NostrEvent {
            try! NostrEvent.signed(privateKey: Data(repeating: 1, count: 32),
                createdAt: createdAt, kind: NIP17GiftWrap.wrapKind,
                tags: [["p", publicKey]], content: "encrypted-\(number)")
        }
        await engine.configure(boards: [], inboxPublicKey: publicKey, inboxRelayURLs: Array(transports.keys))
        for relayURL in transports.keys {
            let subscription = await engine.beginSharedInboxReplay(relayURL: relayURL, publicKey: publicKey)
            for number in 1...100 {
                await engine.handle(.event(subscriptionID: subscription,
                    event: wrap(number, createdAt: now - number)), from: relayURL)
            }
            await engine.handle(.endOfStoredEvents(subscriptionID: subscription), from: relayURL)
        }
        await engine.refreshSharedInboxAfterPush()
        // A message sent right now may have an envelope dated a full two days earlier.
        let newMessage = wrap(101, createdAt: now - 2 * 24 * 60 * 60)
        for (relayURL, transport) in transports {
            let filters = await transport.inboxFilters
            let filter = try XCTUnwrap(filters.last)
            XCTAssertEqual(filters.count, 2)
            XCTAssertLessThanOrEqual(filter.since, newMessage.createdAt)
            XCTAssertGreaterThan(filter.since, now - 3 * 24 * 60 * 60,
                "Warm refreshes should not replay the entire 30-day history")
            for number in 1...100 {
                await engine.handle(.event(subscriptionID: filter.id,
                    event: wrap(number, createdAt: now - number)), from: relayURL)
            }
            // Model the relay applying the actual subscription filter, including to live events.
            if newMessage.createdAt >= filter.since {
                await engine.handle(.event(subscriptionID: filter.id, event: newMessage), from: relayURL)
            }
        }
        await engine.handle(.notice("backdated-message-test-complete"), from: healthyURL)
        var deliveredIDs: [String] = []
        for await update in engine.updates() {
            switch update {
            case .sharedInbox(let event): deliveredIDs.append(event.id)
            case .sharedInboxBatch(let events): deliveredIDs.append(contentsOf: events.map(\.id))
            case .status(let report) where report.relays.contains(where: {
                $0.message == "backdated-message-test-complete"
            }):
                XCTAssertEqual(deliveredIDs, (1...100).map { wrap($0, createdAt: now - $0).id } + [newMessage.id])
                return
            default: break
            }
        }
        XCTFail("The inbox stream ended before the completion marker")
    }

    func testFutureEnvelopeCannotExcludeNormallyBackdatedInboxMessages() async throws {
        let transport = SuspensibleRelayTransport()
        let engine = engine(transports: [healthyURL: transport])
        let publicKey = String(repeating: "a", count: 64)
        let now = Int(Date().timeIntervalSince1970)
        await engine.configure(boards: [], inboxPublicKey: publicKey, inboxRelayURLs: [healthyURL])
        let subscription = await engine.beginSharedInboxReplay(relayURL: healthyURL, publicKey: publicKey)
        let future = NostrEvent(id: event(1).id, publicKey: publicKey,
            createdAt: now + 7 * 24 * 60 * 60, kind: NIP17GiftWrap.wrapKind,
            tags: [["p", publicKey]], content: "untrusted-envelope", signature: "fixture")
        await engine.handle(.event(subscriptionID: subscription, event: future), from: healthyURL)
        await engine.refreshSharedInboxAfterPush()
        let filters = await transport.inboxFilters
        let filter = try XCTUnwrap(filters.last)
        XCTAssertEqual(filters.count, 2)
        XCTAssertLessThanOrEqual(filter.since, now - 2 * 24 * 60 * 60)
    }

    func testOutboxSummaryMatchesPendingTargetsWithoutSortingEntries() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        try await store.enqueue([
            NostrOutboxEntry(event: event(1), relayURLs: [healthyURL, slowURL], boardLocalID: "chat",
                taskID: "first", acceptedRelayURLs: [healthyURL]),
            NostrOutboxEntry(event: event(2), relayURLs: [healthyURL], boardLocalID: "chat", taskID: "second"),
        ])
        let count = await store.entryCount()
        let targets = await store.pendingRelayURLs()
        XCTAssertEqual(count, 2)
        XCTAssertEqual(targets, [healthyURL, slowURL])
        _ = try await store.markAccepted(eventID: event(1).id, relayURL: slowURL)
        let remainingCount = await store.entryCount()
        let remainingTargets = await store.pendingRelayURLs()
        XCTAssertEqual(remainingCount, 1)
        XCTAssertEqual(remainingTargets, [healthyURL])
    }
}

private actor SuspensibleRelayTransport: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private var suspendsPublishes: Bool
    private var suspendedSends: [CheckedContinuation<Void, Never>] = []
    private let onPublish: @Sendable (Int) -> Void
    private let automaticallyAcknowledges: Bool
    private(set) var publishedEventIDs: [String] = []
    private(set) var inboxSubscriptionCount = 0
    private(set) var inboxFilters: [(id: String, since: Int)] = []
    private(set) var connectionCount = 0
    var suspendedSendCount: Int { suspendedSends.count }

    init(
        suspendsPublishes: Bool = false,
        automaticallyAcknowledges: Bool = false,
        onPublish: @escaping @Sendable (Int) -> Void = { _ in }
    ) {
        self.suspendsPublishes = suspendsPublishes
        self.automaticallyAcknowledges = automaticallyAcknowledges
        self.onPublish = onPublish
    }

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() { connectionCount += 1 }
    func disconnect() { resumePublishes() }
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {}
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {
        inboxSubscriptionCount += 1
        inboxFilters.append((id, since))
    }
    func closeSubscription(id: String) {}
    func authenticate(_ event: NostrEvent) {}

    func publish(_ event: NostrEvent) async {
        publishedEventIDs.append(event.id)
        onPublish(publishedEventIDs.count)
        if automaticallyAcknowledges {
            stream.continuation.yield(.acknowledgement(eventID: event.id, accepted: true, message: ""))
        }
        if suspendsPublishes {
            await withCheckedContinuation { suspendedSends.append($0) }
        }
    }

    func resumePublishes() {
        suspendsPublishes = false
        let continuations = suspendedSends
        suspendedSends.removeAll()
        continuations.forEach { $0.resume() }
    }
}

private actor TimeoutWitness {
    private(set) var fired = false
    func record() { fired = true }
}

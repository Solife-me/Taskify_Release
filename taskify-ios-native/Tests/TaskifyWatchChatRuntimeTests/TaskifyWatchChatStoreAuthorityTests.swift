import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyWatchChatRuntime

/// Serves cursor-paged `v1/watch/inbox/query` replies. The i-th request carries cursor
/// `page-(i-1)` (nil for the first) and receives `page-i` plus the configured `hasMore`.
private final class InboxStub: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var sentCursors: [String?] = []
    private static var pageHasMore: [Bool] = []
    private static var delaySeconds: TimeInterval = 0
    private static var eventsByPage: [Int: [TaskifyWatchNostrEvent]] = [:]
    private static var delaysByPage: [Int: TimeInterval] = [:]
    private static var failedPage: Int?
    private static var sentLimits: [Int] = []
    private static var stoppedRequests = 0
    private let stateLock = NSLock()
    private var stopped = false
    private var completed = false

    static func configure(
        pages: [Bool], delay: TimeInterval = 0,
        events: [Int: [TaskifyWatchNostrEvent]] = [:],
        delays: [Int: TimeInterval] = [:], failure: Int? = nil
    ) {
        lock.lock()
        defer { lock.unlock() }
        sentCursors = []
        pageHasMore = pages
        delaySeconds = delay
        eventsByPage = events
        delaysByPage = delays
        failedPage = failure
        sentLimits = []
        stoppedRequests = 0
    }

    static var cursorsSent: [String?] {
        lock.lock()
        defer { lock.unlock() }
        return sentCursors
    }

    static var requestCount: Int { cursorsSent.count }

    static var limitsSent: [Int] {
        lock.lock()
        defer { lock.unlock() }
        return sentLimits
    }

    static var cancellationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return stoppedRequests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private static func pageIndex(forCursor cursor: String?) -> Int {
        guard let cursor, cursor.hasPrefix("page-"), let value = Int(cursor.dropFirst(5)) else {
            return 0
        }
        return value + 1
    }

    override func startLoading() {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let cursor = body["cursor"] as? String
        Self.lock.lock()
        Self.sentCursors.append(cursor)
        Self.sentLimits.append(body["limit"] as? Int ?? 0)
        let index = Self.pageIndex(forCursor: cursor)
        let hasMore = index < Self.pageHasMore.count ? Self.pageHasMore[index] : false
        let delay = Self.delaysByPage[index] ?? Self.delaySeconds
        let events = Self.eventsByPage[index] ?? []
        let fails = Self.failedPage == index
        Self.lock.unlock()
        let encoded = try! JSONSerialization.data(withJSONObject: [
            "events": try! JSONSerialization.jsonObject(with: JSONEncoder().encode(events)),
            "cursor": "page-\(index)",
            "hasMore": hasMore,
        ])
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !stopped else { return }
            completed = true
            if fails {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
            )!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: encoded)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        stateLock.lock()
        let cancelled = !stopped && !completed
        stopped = true
        stateLock.unlock()
        guard cancelled else { return }
        Self.lock.lock()
        Self.stoppedRequests += 1
        Self.lock.unlock()
    }
}

/// The Watch store owns the thread list: summaries are rebuilt locally after every mutation,
/// phone projections only merge display metadata, and relay pulls page the full retained inbox
/// on bootstrap. These tests pin that authority split.
final class TaskifyWatchChatStoreAuthorityTests: XCTestCase {
    private let identityKey = Data(repeating: 2, count: 32)
    private let peerKey = Data(repeating: 1, count: 32)
    private let otherKey = Data(repeating: 3, count: 32)

    private func publicKeyHex(for key: Data) throws -> String {
        try TaskifyWatchNostrCrypto.publicKeyHex(for: key)
    }

    private func makeStore() -> (TaskifyWatchChatStore, URL) {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString).appendingPathComponent("chat.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        return (TaskifyWatchChatStore(fileURL: fileURL), fileURL)
    }

    private func peerWrap(
        to identity: String,
        from peerKey: Data,
        content: String,
        createdAt: Int
    ) throws -> TaskifyWatchNostrEvent {
        let peer = try publicKeyHex(for: peerKey)
        let set = try TaskifyWatchNIP17.createEnvelopeSet(
            content: content,
            senderPrivateKey: peerKey,
            memberPublicKeys: [identity, peer],
            createdAt: createdAt
        )
        return try XCTUnwrap(
            set.wraps.first { $0.recipientPublicKey.lowercased() == identity.lowercased() }
        ).event
    }

    private func ingestPeerMessage(
        _ store: TaskifyWatchChatStore,
        identity: String,
        content: String,
        createdAt: Int,
        cursor: String
    ) async throws {
        let wrap = try peerWrap(
            to: identity, from: peerKey, content: content, createdAt: createdAt
        )
        let inserted = try await store.ingest(
            wraps: [wrap], cursor: cursor, privateKey: identityKey
        )
        XCTAssertEqual(inserted, 1)
    }

    // MARK: - Local summary authority

    func testIngestOfUnknownConversationBuildsALocalSummary() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let created = Int(Date().timeIntervalSince1970)

        try await ingestPeerMessage(
            store, identity: identity, content: "Hello watch", createdAt: created, cursor: "c1"
        )

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.cursor, "c1")
        let summary = try XCTUnwrap(snapshot.threadSummaries?.first)
        XCTAssertEqual(summary.conversationID, peer)
        XCTAssertEqual(summary.memberPublicKeys, [identity, peer].sorted())
        XCTAssertEqual(summary.latestPreview, "Hello watch")
        XCTAssertEqual(summary.latestActivityAt, created)
        XCTAssertEqual(summary.unreadCount, 1)
        XCTAssertNil(summary.readThrough)
        XCTAssertTrue(summary.isRequest, "An unknown peer is a message request")
        XCTAssertEqual(summary.displayName, TaskifyWatchChatIndex.shortPublicKey(peer))
        XCTAssertFalse(summary.isGroup)
    }

    func testMarkReadPersistsReadPositionAndZeroesSummaryUnread() async throws {
        let (store, fileURL) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let now = Int(Date().timeIntervalSince1970)
        try await ingestPeerMessage(
            store, identity: identity, content: "Read me", createdAt: now, cursor: "c1"
        )

        try await store.markRead(conversationID: peer, at: now)

        let persisted = await TaskifyWatchChatStore(fileURL: fileURL).snapshot()
        XCTAssertEqual(persisted.readAt[peer], now)
        let summary = try XCTUnwrap(persisted.threadSummaries?.first)
        XCTAssertEqual(summary.unreadCount, 0)
        XCTAssertEqual(summary.readThrough, now)

        // Re-marking an already-read position must not bump generatedAt or rewrite state.
        let generatedBefore = persisted.generatedAt
        try await TaskifyWatchChatStore(fileURL: fileURL).markRead(conversationID: peer, at: now)
        let after = await TaskifyWatchChatStore(fileURL: fileURL).snapshot()
        XCTAssertEqual(after.generatedAt, generatedBefore)
        XCTAssertEqual(after.readAt[peer], now)
    }

    // MARK: - Projection merging

    func testApplyProjectionMergesPhoneMetadataWithoutReplacingLocalThreads() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let otherPeer = try publicKeyHex(for: otherKey)
        let now = Int(Date().timeIntervalSince1970)
        try await ingestPeerMessage(
            store, identity: identity, content: "Local message", createdAt: now + 100, cursor: "c1"
        )

        let phoneDM = try XCTUnwrap(TaskifyWatchChatThreadSummary(
            conversationID: peer,
            memberPublicKeys: [identity, peer],
            displayName: "Phone Named",
            latestPreview: "From phone",
            latestActivityAt: now - 1_000,
            unreadCount: 9,
            isRequest: false
        ))
        let phoneOnly = try XCTUnwrap(TaskifyWatchChatThreadSummary(
            conversationID: otherPeer,
            memberPublicKeys: [identity, otherPeer],
            displayName: "Phone Only",
            latestPreview: "From phone",
            latestActivityAt: now,
            readThrough: now - 500,
            unreadCount: 3,
            isRequest: false
        ))
        let projection = TaskifyWatchChatProjection(
            threads: [phoneDM, phoneOnly],
            accountPublicKey: identity,
            contacts: [TaskifyWatchContact(publicKey: peer, npub: "", displayName: "Phone Named")],
            generatedAt: Date()
        )

        _ = try await store.applyProjection(projection)

        let snapshot = await store.snapshot()
        let summaries = try XCTUnwrap(snapshot.threadSummaries)
        XCTAssertEqual(
            Set(summaries.map(\.id)),
            Set([peer, otherPeer]),
            "A thread absent from the projection survives locally"
        )
        let merged = try XCTUnwrap(summaries.first { $0.id == peer })
        XCTAssertEqual(merged.displayName, "Phone Named", "Phone display metadata wins")
        XCTAssertEqual(merged.latestPreview, "Local message", "Newer local activity keeps its preview")
        XCTAssertEqual(merged.unreadCount, 1, "Unread is counted locally, not the phone's stale 9")
        XCTAssertEqual(merged.latestActivityAt, now + 100)
        XCTAssertNil(merged.readThrough)
        let imported = try XCTUnwrap(summaries.first { $0.id == otherPeer })
        XCTAssertEqual(imported.unreadCount, 3)
        XCTAssertEqual(imported.readThrough, now - 500)
        XCTAssertEqual(snapshot.readAt[otherPeer], now - 500)
        XCTAssertEqual(snapshot.contacts.first?.displayName, "Phone Named")
    }

    func testProjectionCannotLowerALocalReadPosition() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let now = Int(Date().timeIntervalSince1970)
        try await ingestPeerMessage(
            store, identity: identity, content: "Local message", createdAt: now, cursor: "c1"
        )
        try await store.markRead(conversationID: peer, at: now + 100)

        let stale = try XCTUnwrap(TaskifyWatchChatThreadSummary(
            conversationID: peer,
            memberPublicKeys: [identity, peer],
            displayName: "Phone Named",
            latestPreview: "From phone",
            latestActivityAt: now - 1_000,
            readThrough: now - 1_000,
            unreadCount: 5,
            isRequest: false
        ))
        let projection = TaskifyWatchChatProjection(
            threads: [stale], accountPublicKey: identity, generatedAt: Date()
        )

        _ = try await store.applyProjection(projection)

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.readAt[peer], now + 100)
        let summary = try XCTUnwrap(snapshot.threadSummaries?.first)
        XCTAssertEqual(summary.readThrough, now + 100)
        XCTAssertEqual(summary.unreadCount, 0)
        XCTAssertEqual(summary.latestPreview, "Local message")
        XCTAssertEqual(summary.latestActivityAt, now, "Activity tracks the message, not the read position")
    }

    func testContentEqualProjectionDoesNotBumpGeneratedAt() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let now = Int(Date().timeIntervalSince1970)
        let summary = try XCTUnwrap(TaskifyWatchChatThreadSummary(
            conversationID: peer,
            memberPublicKeys: [identity, peer],
            displayName: "Peer",
            latestPreview: "From phone",
            latestActivityAt: now,
            readThrough: now - 500,
            unreadCount: 2,
            isRequest: false
        ))
        let generated = Date(timeIntervalSince1970: 1_900_000_000)
        let projection = TaskifyWatchChatProjection(
            threads: [summary],
            accountPublicKey: identity,
            contacts: [TaskifyWatchContact(publicKey: peer, npub: "", displayName: "Named")],
            generatedAt: generated
        )

        _ = try await store.applyProjection(projection)
        let applied = await store.snapshot()
        XCTAssertEqual(applied.generatedAt, generated)

        let repeated = TaskifyWatchChatProjection(
            threads: [summary],
            accountPublicKey: identity,
            contacts: [TaskifyWatchContact(publicKey: peer, npub: "", displayName: "Named")],
            generatedAt: generated.addingTimeInterval(60)
        )
        _ = try await store.applyProjection(repeated)
        let repeatedSnapshot = await store.snapshot()
        XCTAssertEqual(
            repeatedSnapshot.generatedAt,
            generated,
            "Content-equal projections are no-ops so read badges cannot ping-pong"
        )
    }

    func testApplyProvisioningMergesInsteadOfReplacing() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let otherPeer = try publicKeyHex(for: otherKey)
        let now = Int(Date().timeIntervalSince1970)
        try await ingestPeerMessage(
            store, identity: identity, content: "Local message", createdAt: now, cursor: "c1"
        )

        let context = TaskifyWatchChatProvisioningContext(
            contacts: [TaskifyWatchContact(publicKey: peer, npub: "", displayName: "Provisioned")],
            threadSummaries: [try XCTUnwrap(TaskifyWatchChatThreadSummary(
                conversationID: otherPeer,
                memberPublicKeys: [identity, otherPeer],
                displayName: "Provisioned Thread",
                latestPreview: "From provisioning",
                latestActivityAt: now,
                readThrough: now - 500,
                unreadCount: 3,
                isRequest: false
            ))],
            discoveryRelayURLs: [],
            pushRelayHTTPSURL: URL(string: "https://gateway.example")!,
            pushRelayWSSURL: "wss://gateway.example"
        )

        try await store.applyProvisioning(context)

        let snapshot = await store.snapshot()
        let summaries = try XCTUnwrap(snapshot.threadSummaries)
        XCTAssertEqual(Set(summaries.map(\.id)), Set([peer, otherPeer]))
        let local = try XCTUnwrap(summaries.first { $0.id == peer })
        XCTAssertEqual(local.unreadCount, 1)
        XCTAssertEqual(local.latestPreview, "Local message")
        XCTAssertEqual(local.displayName, "Provisioned", "The provisioned contact names the thread")
        let imported = try XCTUnwrap(summaries.first { $0.id == otherPeer })
        XCTAssertEqual(imported.unreadCount, 3)
        XCTAssertEqual(snapshot.readAt[otherPeer], now - 500)
        XCTAssertEqual(snapshot.contacts.first?.displayName, "Provisioned")
    }

    // MARK: - Tombstones

    func testDeletedConversationTombstoneRemovesTheThreadAndBlocksReplay() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let wrap = try peerWrap(
            to: identity,
            from: peerKey,
            content: "Delete me",
            createdAt: Int(Date().timeIntervalSince1970)
        )
        _ = try await store.ingest(wraps: [wrap], cursor: "c1", privateKey: identityKey)
        var snapshot = await store.snapshot()
        let rumorID = try XCTUnwrap(snapshot.messages.first?.rumorID)

        let projection = TaskifyWatchChatProjection(
            threads: [],
            accountPublicKey: identity,
            deletedConversationIDs: [peer],
            generatedAt: Date()
        )
        _ = try await store.applyProjection(projection)

        snapshot = await store.snapshot()
        XCTAssertTrue(snapshot.messages.isEmpty)
        XCTAssertTrue(snapshot.threadSummaries?.isEmpty ?? true)
        XCTAssertNil(snapshot.readAt[peer])
        XCTAssertTrue(snapshot.processedWrapIDs.contains(wrap.id.lowercased()))
        XCTAssertTrue(snapshot.processedRumorIDs.contains(rumorID))

        // The same wrap arriving again on a later relay page must not resurrect the thread.
        let replayed = try await store.ingest(
            wraps: [wrap], cursor: "c2", privateKey: identityKey
        )
        XCTAssertEqual(replayed, 0)
        let after = await store.snapshot()
        XCTAssertTrue(after.messages.isEmpty)
        XCTAssertEqual(after.cursor, "c2")
    }

    func testBlockedPeerTombstoneRecordsBlockRemovesDMAndKeepsGroups() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let otherPeer = try publicKeyHex(for: otherKey)
        let now = Int(Date().timeIntervalSince1970)
        try await ingestPeerMessage(
            store, identity: identity, content: "From peer", createdAt: now, cursor: "c1"
        )
        let group = try XCTUnwrap(TaskifyWatchGroupConversation(
            name: "Team", memberPublicKeys: [identity, peer, otherPeer], createdAt: now
        ))
        let groupSummary = try XCTUnwrap(TaskifyWatchChatThreadSummary(
            conversationID: group.groupID,
            memberPublicKeys: group.memberPublicKeys,
            displayName: "Team",
            latestPreview: "Group message",
            latestActivityAt: now,
            unreadCount: 1,
            isRequest: false,
            group: group
        ))

        let projection = TaskifyWatchChatProjection(
            threads: [groupSummary],
            accountPublicKey: identity,
            blockedPublicKeys: [peer.uppercased()],
            generatedAt: Date()
        )
        _ = try await store.applyProjection(projection)

        let snapshot = await store.snapshot()
        XCTAssertTrue(snapshot.blockedPublicKeys.contains(peer), "Tombstone keys normalize case")
        XCTAssertTrue(snapshot.messages.isEmpty, "The blocked peer's messages are removed")
        XCTAssertEqual(
            snapshot.threadSummaries?.map(\.id),
            [group.groupID],
            "The DM thread is dropped but groups the peer belongs to remain"
        )
    }

    // MARK: - Index unread

    func testIndexUnreadMatchesLocallyRebuiltSummaryCounts() async throws {
        let (store, _) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let peer = try publicKeyHex(for: peerKey)
        let now = Int(Date().timeIntervalSince1970)
        try await ingestPeerMessage(
            store, identity: identity, content: "First", createdAt: now, cursor: "c1"
        )
        try await ingestPeerMessage(
            store, identity: identity, content: "Second", createdAt: now + 10, cursor: "c2"
        )
        try await store.markRead(conversationID: peer, at: now)

        let snapshot = await store.snapshot()
        let summary = try XCTUnwrap(snapshot.threadSummaries?.first)
        XCTAssertEqual(summary.unreadCount, 1)
        let index = TaskifyWatchChatIndex(snapshot: snapshot, identity: identity)
        XCTAssertEqual(index.threads.first?.unreadCount, summary.unreadCount)
        XCTAssertEqual(index.unreadCount, 1)
    }

    func testIndexUnreadFallsBackToLocalCountingWithoutSummaries() {
        let snapshot = TaskifyWatchChatSnapshot(
            messages: [
                TaskifyWatchChatMessage(
                    rumorID: "old", wrapID: "w-old", conversationID: "chat",
                    senderPublicKey: "peer", memberPublicKeys: ["me", "peer"],
                    content: "old", createdAt: 10, kind: .text
                ),
                TaskifyWatchChatMessage(
                    rumorID: "new", wrapID: "w-new", conversationID: "chat",
                    senderPublicKey: "peer", memberPublicKeys: ["me", "peer"],
                    content: "new", createdAt: 30, kind: .text
                ),
            ],
            readAt: ["chat": 20],
            generatedAt: Date(timeIntervalSince1970: 1_900_000_000)
        )
        let index = TaskifyWatchChatIndex(snapshot: snapshot, identity: "me")
        XCTAssertEqual(index.threads.first?.unreadCount, 1, "Only the message after readAt counts")
        XCTAssertEqual(index.unreadCount, 1)
    }

    func testIndexUnreadUsesTheSummaryCountForSummaryBackedThreads() throws {
        let chat = String(repeating: "b", count: 64)
        let me = String(repeating: "a", count: 64)
        let peer = String(repeating: "c", count: 64)
        let summary = try XCTUnwrap(TaskifyWatchChatThreadSummary(
            conversationID: chat,
            memberPublicKeys: [me, peer],
            displayName: "Chat",
            latestPreview: "From phone",
            latestActivityAt: 20,
            readThrough: 20,
            unreadCount: 5,
            isRequest: false
        ))
        let snapshot = TaskifyWatchChatSnapshot(
            threadSummaries: [summary],
            messages: [
                TaskifyWatchChatMessage(
                    rumorID: "new", wrapID: "w-new", conversationID: chat,
                    senderPublicKey: peer, memberPublicKeys: [me, peer],
                    content: "new", createdAt: 30, kind: .text
                ),
            ],
            readAt: [chat: 20],
            generatedAt: Date(timeIntervalSince1970: 1_900_000_000)
        )
        let index = TaskifyWatchChatIndex(snapshot: snapshot, identity: me)
        // The summary is locally rebuilt and already counts the message after readAt; the
        // previous formula double-counted such messages as a "newer local" term.
        XCTAssertEqual(index.threads.first?.unreadCount, 5)
        XCTAssertEqual(index.unreadCount, 5)
    }

    // MARK: - Inbox paging

    private func configuredCoordinator(wallClock: TimeInterval = 20, fileURL suppliedURL: URL? = nil) async throws
        -> TaskifyWatchChatCoordinator {
        let fileURL = suppliedURL ?? FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString).appendingPathComponent("chat.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [InboxStub.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let coordinator = TaskifyWatchChatCoordinator(
            fileURL: fileURL, session: session, bootstrapWallClockSeconds: wallClock
        )
        _ = try await coordinator.configure(TaskifyWatchChatProvisioningContext(
            discoveryRelayURLs: [],
            pushRelayHTTPSURL: URL(string: "https://gateway.example")!,
            pushRelayWSSURL: "wss://gateway.example"
        ))
        return coordinator
    }

    private func assertRequestWasCancelled() async throws {
        // URLSession resumes its async caller before URLProtocol receives stopLoading.
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while InboxStub.cancellationCount == 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(InboxStub.cancellationCount, 1)
    }

    func testBootstrapRefreshPagesUntilHasMoreEnds() async throws {
        InboxStub.configure(pages: [true, true, false])
        let coordinator = try await configuredCoordinator()

        _ = try await coordinator.refreshInbox(privateKey: identityKey)

        XCTAssertEqual(InboxStub.cursorsSent, [nil, "page-0", "page-1"])
        let ended = await coordinator.snapshot()
        XCTAssertEqual(ended.cursor, "page-2")
    }

    func testBootstrapStopsAtTwentyFivePagesAndSteadyStateAtFive() async throws {
        InboxStub.configure(pages: Array(repeating: true, count: 60))
        let coordinator = try await configuredCoordinator()

        _ = try await coordinator.refreshInbox(privateKey: identityKey)
        XCTAssertEqual(InboxStub.requestCount, 25, "Bootstrap pages the whole retained inbox")
        let bootstrapped = await coordinator.snapshot()
        XCTAssertEqual(bootstrapped.cursor, "page-24")

        // Steady state: a stored cursor limits the pull even while more pages remain, and
        // whatever a bounded bootstrap left over continues on the next refresh.
        _ = try await coordinator.refreshInbox(privateKey: identityKey)
        XCTAssertEqual(InboxStub.cursorsSent.count, 30)
        XCTAssertEqual(
            Array(InboxStub.cursorsSent.suffix(5)),
            ["page-24", "page-25", "page-26", "page-27", "page-28"]
        )
        let steady = await coordinator.snapshot()
        XCTAssertEqual(steady.cursor, "page-29")
    }

    func testBootstrapWallClockBoundStopsThePullEarly() async throws {
        InboxStub.configure(pages: Array(repeating: true, count: 60), delay: 0.3)
        let coordinator = try await configuredCoordinator(wallClock: 0.55)

        _ = try await coordinator.refreshInbox(privateKey: identityKey)

        let count = InboxStub.requestCount
        XCTAssertTrue(
            count >= 2 && count <= 6,
            "Wall clock stopped the pull well before the page bound; got \(count)"
        )
        let cursor = await coordinator.snapshot().cursor
        XCTAssertNotNil(cursor)
    }

    func testBackgroundSavesDecryptedPageBeforeLaterRequestTimesOutAndResumesAfterRelaunch() async throws {
        let (_, fileURL) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let wrap = try peerWrap(to: identity, from: peerKey, content: "Ready before opening",
                                createdAt: Int(Date().timeIntervalSince1970))
        InboxStub.configure(pages: [true, false], events: [0: [wrap]], delays: [1: 3])
        let coordinator = try await configuredCoordinator(fileURL: fileURL)
        do {
            _ = try await coordinator.refreshInbox(
                privateKey: identityKey, backgroundDeadline: .now.advanced(by: .seconds(0.3))
            )
            XCTFail("The second request must time out")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
        let disk = await TaskifyWatchChatStore(fileURL: fileURL).snapshot()
        XCTAssertEqual(disk.cursor, "page-0")
        XCTAssertEqual(disk.messages.map(\.content), ["Ready before opening"])
        try await assertRequestWasCancelled()

        // Replay the same wrap on the next page to verify durable dedupe as well as the cursor.
        InboxStub.configure(pages: [true, false], events: [1: [wrap]])
        let relaunched = try await configuredCoordinator(fileURL: fileURL)
        let resumed = try await relaunched.refreshInbox(
            privateKey: identityKey, backgroundDeadline: .now.advanced(by: .seconds(2))
        )
        XCTAssertEqual(InboxStub.cursorsSent, ["page-0"])
        XCTAssertEqual(resumed.cursor, "page-1")
        XCTAssertEqual(resumed.messages.count, 1)
    }

    func testBackgroundDeadlineCancelsSlowFirstRequestWithoutAdvancingCursor() async throws {
        InboxStub.configure(pages: [false], delay: 3)
        let coordinator = try await configuredCoordinator()
        let start = ContinuousClock.now
        do {
            _ = try await coordinator.refreshInbox(
                privateKey: identityKey, backgroundDeadline: start.advanced(by: .seconds(0.3))
            )
            XCTFail("Slow request must time out")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
        XCTAssertLessThan(start.duration(to: .now), .seconds(2))
        let snapshot = await coordinator.snapshot()
        XCTAssertNil(snapshot.cursor)
        try await assertRequestWasCancelled()
    }

    func testExpiredBackgroundDeadlineDoesNotStartARequest() async throws {
        InboxStub.configure(pages: [true])
        let coordinator = try await configuredCoordinator()
        let snapshot = try await coordinator.refreshInbox(
            privateKey: identityKey, backgroundDeadline: .now.advanced(by: .seconds(-1))
        )
        XCTAssertNil(snapshot.cursor)
        XCTAssertEqual(InboxStub.requestCount, 0)
    }

    func testBackgroundUsesSmallPagesAndBoundedPageCount() async throws {
        InboxStub.configure(pages: Array(repeating: true, count: 30))
        let coordinator = try await configuredCoordinator()
        let snapshot = try await coordinator.refreshInbox(
            privateKey: identityKey, backgroundDeadline: .now.advanced(by: .seconds(5))
        )
        XCTAssertEqual(InboxStub.requestCount, 10)
        XCTAssertEqual(InboxStub.limitsSent, Array(repeating: 20, count: 10))
        XCTAssertEqual(snapshot.cursor, "page-9")
    }

    func testForegroundRetainsPendingPagesWhenNextFetchFails() async throws {
        let (_, fileURL) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        let wrap = try peerWrap(to: identity, from: peerKey, content: "Keep partial progress",
                                createdAt: Int(Date().timeIntervalSince1970))
        InboxStub.configure(pages: [true, false], events: [0: [wrap]], failure: 1)
        let coordinator = try await configuredCoordinator(fileURL: fileURL)
        do {
            _ = try await coordinator.refreshInbox(privateKey: identityKey)
            XCTFail("Second page must fail")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        }
        let disk = await TaskifyWatchChatStore(fileURL: fileURL).snapshot()
        XCTAssertEqual(disk.cursor, "page-0")
        XCTAssertEqual(disk.messages.map(\.content), ["Keep partial progress"])
    }

    func testCancelledBackgroundFetchDoesNotWaitForDeadline() async throws {
        InboxStub.configure(pages: [false], delay: 3)
        let coordinator = try await configuredCoordinator()
        let operation = Task {
            try await coordinator.refreshInbox(
                privateKey: identityKey, backgroundDeadline: .now.advanced(by: .seconds(18))
            )
        }
        // Wait only until the stub has observed the request, then emulate watchOS expiration.
        let waitDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while InboxStub.requestCount == 0, ContinuousClock.now < waitDeadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(InboxStub.requestCount, 1)
        let cancelledAt = ContinuousClock.now
        operation.cancel()
        do {
            _ = try await operation.value
            XCTFail("Cancelled refresh must throw")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        XCTAssertLessThan(cancelledAt.duration(to: .now), .seconds(2))
        let snapshot = await coordinator.snapshot()
        XCTAssertNil(snapshot.cursor)
        try await assertRequestWasCancelled()
    }

    func testFailedCacheWriteRollsBackMessagesCursorAndDedupeLedger() async throws {
        let (store, fileURL) = makeStore()
        let directory = fileURL.deletingLastPathComponent()
        // Make the intended cache directory a file so the write fails deterministically.
        try Data().write(to: directory)
        let identity = try publicKeyHex(for: identityKey)
        let wrap = try peerWrap(to: identity, from: peerKey, content: "Retry after storage unlocks",
                                createdAt: Int(Date().timeIntervalSince1970))
        do {
            _ = try await store.ingest(wraps: [wrap], cursor: "saved", privateKey: identityKey)
            XCTFail("Write must fail")
        } catch { }
        let failed = await store.snapshot()
        XCTAssertNil(failed.cursor)
        XCTAssertTrue(failed.messages.isEmpty)
        XCTAssertTrue(failed.processedWrapIDs.isEmpty)
        try FileManager.default.removeItem(at: directory)
        let inserted = try await store.ingest(wraps: [wrap], cursor: "saved", privateKey: identityKey)
        XCTAssertEqual(inserted, 1)
        let disk = await TaskifyWatchChatStore(fileURL: fileURL).snapshot()
        XCTAssertEqual(disk.messages.count, 1)
        XCTAssertEqual(disk.cursor, "saved")
    }

    func testBackgroundRejectsOversizedPageWithoutAdvancingCursor() async throws {
        let identity = try publicKeyHex(for: identityKey)
        let wrap = try peerWrap(to: identity, from: peerKey, content: "Bound crypto work",
                                createdAt: Int(Date().timeIntervalSince1970))
        InboxStub.configure(pages: [false], events: [0: Array(repeating: wrap, count: 21)])
        let coordinator = try await configuredCoordinator()
        do {
            _ = try await coordinator.refreshInbox(
                privateKey: identityKey, backgroundDeadline: .now.advanced(by: .seconds(2))
            )
            XCTFail("Oversized page must fail")
        } catch { }
        let snapshot = await coordinator.snapshot()
        XCTAssertNil(snapshot.cursor)
        XCTAssertTrue(snapshot.messages.isEmpty)
    }

    func testUnreadableCacheIsNotOverwrittenAndReloadsWhenAvailable() async throws {
        let (seed, fileURL) = makeStore()
        let identity = try publicKeyHex(for: identityKey)
        try await ingestPeerMessage(seed, identity: identity, content: "Already saved",
                                    createdAt: Int(Date().timeIntervalSince1970), cursor: "saved")
        let savedData = try Data(contentsOf: fileURL)
        // A directory at the file path deterministically simulates a read error on macOS;
        // physical-device testing covers the actual watchOS data-protection transition.
        try FileManager.default.removeItem(at: fileURL)
        try FileManager.default.createDirectory(at: fileURL, withIntermediateDirectories: false)
        let store = TaskifyWatchChatStore(fileURL: fileURL)
        let wrap = try peerWrap(to: identity, from: peerKey, content: "Do not overwrite",
                                createdAt: Int(Date().timeIntervalSince1970))
        do {
            _ = try await store.ingest(wraps: [wrap], cursor: "incorrect", privateKey: identityKey)
            XCTFail("Unreadable cache must not be replaced")
        } catch { }
        try FileManager.default.removeItem(at: fileURL)
        try savedData.write(to: fileURL)
        let reloaded = await store.snapshot()
        XCTAssertEqual(reloaded.cursor, "saved")
        XCTAssertEqual(reloaded.messages.map(\.content), ["Already saved"])
        let inserted = try await store.ingest(wraps: [wrap], cursor: "next", privateKey: identityKey)
        XCTAssertEqual(inserted, 1)
        let disk = await TaskifyWatchChatStore(fileURL: fileURL).snapshot()
        XCTAssertEqual(disk.messages.count, 2)
        XCTAssertEqual(disk.cursor, "next")
    }
}

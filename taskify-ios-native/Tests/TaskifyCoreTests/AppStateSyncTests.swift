import Foundation
import XCTest
@testable import TaskifyCore

final class AppStateSyncTests: XCTestCase {
    /// Inputs and the PWA's merge results, produced by running `taskify-core`'s
    /// `appStateSync.ts` on them. The native merge must produce the same states.
    private let pwaParityFixture = #"""
{"input":{"sBase":{"entries":[{"id":"a","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0},{"id":"b","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0},{"id":"c","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0}]},"sLocal":{"entries":[{"id":"a","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":2,"totalReviews":2,"lastReviewISO":"2026-09-03T08:00:00.250Z"},{"id":"c","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0},{"id":"d","bookId":"gen","chapter":1,"startVerse":null,"endVerse":null,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0}]},"sRemote":{"entries":[{"id":"a","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":1,"totalReviews":1,"lastReviewISO":"2026-09-02T08:00:00Z","scheduledAtISO":"2026-09-02T09:00:00Z"},{"id":"b","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0},{"id":"c","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0,"scheduledAtISO":"2026-09-04T00:00:00.000Z"},{"id":"x","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0}],"lastReviewISO":"2026-09-02T08:00:00Z"},"bBase":{"lastResetISO":"2026-01-01T00:00:00.000Z","progress":{"gen":[1,2],"exo":[1]},"verses":{"gen":{"3":[1,2]}},"verseCounts":{"gen":{"3":24}},"completedBooks":{"oba":{"completedAtISO":"2026-02-01T00:00:00.000Z"}},"archive":[{"id":"a1","savedAtISO":"2025-12-31T00:00:00.000Z","lastResetISO":"2025-01-01T00:00:00.000Z","progress":{"gen":[1]},"verses":{},"verseCounts":{},"completedBooks":{}}]},"bLocal":{"lastResetISO":"2026-01-01T00:00:00.000Z","progress":{"gen":[1,2,3],"exo":[1],"oba":[1]},"verses":{"gen":{"3":[1,2,4]}},"verseCounts":{"gen":{"3":24}},"completedBooks":{"oba":{"completedAtISO":"2026-02-01T00:00:00.000Z"},"jud":{"completedAtISO":"2026-03-01T00:00:00.000Z"}},"archive":[{"id":"a1","savedAtISO":"2025-12-31T00:00:00.000Z","lastResetISO":"2025-01-01T00:00:00.000Z","progress":{"gen":[1]},"verses":{},"verseCounts":{},"completedBooks":{}}]},"bRemote":{"lastResetISO":"2026-01-01T00:00:00.000Z","progress":{"gen":[2],"lev":[5]},"verses":{"gen":{"3":[2,9]},"lev":{"1":[3]}},"verseCounts":{"gen":{"3":24},"lev":{"1":17}},"completedBooks":{"jud":{"completedAtISO":"2026-02-15T00:00:00.000Z"}},"archive":[{"id":"a1","savedAtISO":"2025-12-31T00:00:00.000Z","lastResetISO":"2025-01-01T00:00:00.000Z","progress":{"gen":[1]},"verses":{},"verseCounts":{},"completedBooks":{}},{"id":"a2","savedAtISO":"2026-01-01T00:00:00.000Z","lastResetISO":"2025-01-01T00:00:00.000Z","progress":{"gen":[1]},"verses":{},"verseCounts":{},"completedBooks":{}}]}},"out":{"scripture":{"entries":[{"id":"a","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":2,"totalReviews":2,"lastReviewISO":"2026-09-03T08:00:00.250Z"},{"id":"c","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0,"scheduledAtISO":"2026-09-04T00:00:00.000Z"},{"id":"d","bookId":"gen","chapter":1,"startVerse":null,"endVerse":null,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0},{"id":"x","bookId":"jhn","chapter":3,"startVerse":16,"endVerse":16,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":0,"totalReviews":0}],"lastReviewISO":"2026-09-03T08:00:00.250Z"},"bible":{"lastResetISO":"2026-01-01T00:00:00.000Z","progress":{"gen":[2,3],"oba":[1],"lev":[5]},"verses":{"gen":{"3":[2,4,9]},"lev":{"1":[3]}},"verseCounts":{"gen":{"3":24},"lev":{"1":17}},"completedBooks":{"jud":{"completedAtISO":"2026-02-15T00:00:00.000Z"}},"archive":[{"id":"a2","savedAtISO":"2026-01-01T00:00:00.000Z","lastResetISO":"2025-01-01T00:00:00.000Z","progress":{"gen":[1]},"verses":{},"verseCounts":{},"completedBooks":{}},{"id":"a1","savedAtISO":"2025-12-31T00:00:00.000Z","lastResetISO":"2025-01-01T00:00:00.000Z","progress":{"gen":[1]},"verses":{},"verseCounts":{},"completedBooks":{}}]},"chat":{"readThrough":{"p":8,"q":9},"inboxResponses":{"w":{"status":"declined","at":3},"v":{"status":"deleted","at":7}}}}}
"""#

    private struct Fixture: Decodable {
        struct Input: Decodable {
            let sBase, sLocal, sRemote: ScriptureMemoryState
            let bBase, bLocal, bRemote: BibleTrackerState
        }
        struct Output: Decodable {
            let scripture: ScriptureMemoryState
            let bible: BibleTrackerState
            let chat: ChatSyncState
        }
        let input: Input
        let out: Output
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(pwaParityFixture.utf8))
    }

    func testScriptureMergeMatchesPWA() throws {
        let f = try fixture()
        let merged = f.input.sLocal.merged(with: f.input.sRemote, base: f.input.sBase)
        XCTAssertEqual(merged, f.out.scripture)
    }

    func testBibleMergeMatchesPWA() throws {
        let f = try fixture()
        let merged = f.input.bLocal.merged(with: f.input.bRemote, base: f.input.bBase)
        XCTAssertEqual(merged, f.out.bible)
    }

    func testChatMergeMatchesPWAAndIsSymmetric() throws {
        let a = ChatSyncState(
            readThrough: ["p": 5, "q": 9],
            inboxResponses: ["w": .init(status: .accepted, at: 3), "v": .init(status: .deleted, at: 7)]
        )
        let b = ChatSyncState(
            readThrough: ["p": 8],
            inboxResponses: ["w": .init(status: .declined, at: 3), "v": .init(status: .accepted, at: 6)]
        )
        XCTAssertEqual(a.merged(with: b), try fixture().out.chat)
        XCTAssertEqual(a.merged(with: b), b.merged(with: a))
    }

    func testMergesConvergeWhenEachDeviceMergesTheOther() throws {
        let f = try fixture()
        let onLocal = f.input.sLocal.merged(with: f.input.sRemote, base: f.input.sBase)
        let onRemote = f.input.sRemote.merged(with: f.input.sLocal, base: f.input.sBase)
        XCTAssertTrue(onLocal.syncEquivalent(to: onRemote))
        let bibleOnLocal = f.input.bLocal.merged(with: f.input.bRemote, base: f.input.bBase)
        let bibleOnRemote = f.input.bRemote.merged(with: f.input.bLocal, base: f.input.bBase)
        XCTAssertTrue(bibleOnLocal.syncEquivalent(to: bibleOnRemote))
    }

    func testNewerResetWinsAndArchivesMerge() {
        let archived = BibleTrackerArchiveEntry(
            id: "arch", savedAtISO: "2026-06-01T00:00:00.000Z", lastResetISO: "2026-01-01T00:00:00.000Z",
            progress: ["gen": [1]], verses: [:], verseCounts: [:], completedBooks: [:]
        )
        let local = BibleTrackerState(lastResetISO: "2026-01-01T00:00:00.000Z", progress: ["gen": [1, 2]])
        let remote = BibleTrackerState(lastResetISO: "2026-06-01T00:00:00.000Z", archive: [archived])
        let merged = local.merged(with: remote, base: BibleTrackerState(lastResetISO: "2026-01-01T00:00:00.000Z"))
        XCTAssertEqual(merged.lastResetISO, "2026-06-01T00:00:00.000Z")
        XCTAssertEqual(merged.progress, [:])
        XCTAssertEqual(merged.archive.map(\.id), ["arch"])
    }

    /// A PWA payload carries its device-only `expandedBooks` and may omit empty maps.
    func testDecodesPWABibleTrackerPayload() throws {
        let json = Data(#"{"version":1,"timestamp":1790000000,"bibleTracker":{"lastResetISO":"2026-01-01T00:00:00.000Z","progress":{"gen":[1,2]},"archive":[],"expandedBooks":{"gen":true},"verses":{"gen":{"3":[1]}},"verseCounts":{"gen":{"3":24}},"completedBooks":{}}}"#.utf8)
        let payload = try JSONDecoder().decode(BibleTrackerSyncPayload.self, from: json)
        XCTAssertEqual(payload.bibleTracker.progress["gen"], [1, 2])
        XCTAssertEqual(payload.bibleTracker.verses["gen"]?["3"], [1])
        let sparse = Data(#"{"version":1,"timestamp":1,"bibleTracker":{"lastResetISO":"2026-01-01T00:00:00.000Z","progress":{}}}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(BibleTrackerSyncPayload.self, from: sparse).bibleTracker.archive, [])
    }

    func testChatStateDecodingIsLenientAndLowercases() throws {
        let json = Data(#"{"version":1,"timestamp":5,"readThrough":{"ABC":12,"bad":-1},"inboxResponses":{"W1":{"status":"accepted","at":3},"w2":{"status":"read","at":3}}}"#.utf8)
        let payload = try JSONDecoder().decode(ChatStateSyncPayload.self, from: json)
        XCTAssertEqual(payload.readThrough, ["abc": 12])
        XCTAssertEqual(payload.inboxResponses, ["w1": .init(status: .accepted, at: 3)])
    }

    func testCoversAndPrune() {
        let remote = ChatSyncState(readThrough: ["p": 100], inboxResponses: ["w": .init(status: .accepted, at: 10)])
        XCTAssertTrue(remote.covers(ChatSyncState(readThrough: ["p": 90], inboxResponses: ["w": .init(status: .accepted, at: 10)])))
        XCTAssertFalse(remote.covers(ChatSyncState(readThrough: ["p": 101])))
        XCTAssertFalse(remote.covers(ChatSyncState(inboxResponses: ["x": .init(status: .deleted, at: 1)])))
        let pruned = ChatSyncState(
            readThrough: ["old": 1, "a": 1000, "b": 999],
            inboxResponses: ["old": .init(status: .deleted, at: 1), "n": .init(status: .accepted, at: 1000)]
        ).pruned(nowSeconds: 1000, maxAgeSeconds: 100, maxEntries: 1)
        XCTAssertEqual(pruned.readThrough, ["a": 1000])
        XCTAssertEqual(Array(pruned.inboxResponses.keys), ["n"])
    }

    func testEventRoundTripsAndRejectsOtherIdentities() throws {
        let identity = try NostrIdentity(privateKey: Data(hex: String(repeating: "0", count: 63) + "1"))
        let other = try NostrIdentity(privateKey: Data(hex: String(repeating: "0", count: 63) + "2"))
        let payload = ChatStateSyncPayload(timestamp: 1_790_000_000, state: ChatSyncState(readThrough: ["p": 5]))
        let event = try AppStateSyncContract.event(
            dTag: AppStateSyncContract.chatStateDTag, payload: payload, identity: identity, createdAt: 1_790_000_000
        )
        let decrypted = try AppStateSyncContract.decrypt(event: event, identity: identity)
        XCTAssertEqual(decrypted.dTag, AppStateSyncContract.chatStateDTag)
        XCTAssertEqual(try JSONDecoder().decode(ChatStateSyncPayload.self, from: decrypted.plaintext), payload)
        XCTAssertThrowsError(try AppStateSyncContract.decrypt(event: event, identity: other))
    }

    func testSnapshotBridgeDerivesAndAppliesChatState() {
        var snapshot = TaskifySnapshot.empty
        snapshot.directMessageReadAt = ["PeerA": 100]
        snapshot.sharedBoardInboxItems = [
            SharedBoardInboxItem(
                wrapEventID: "WRAP-1", rumorEventID: "r1",
                sender: SharedInboxSender(publicKey: String(repeating: "a", count: 64)),
                board: SharedBoardDelivery(boardID: "b1"), receivedAt: Date(timeIntervalSince1970: 1)
            ),
            SharedBoardInboxItem(
                wrapEventID: "wrap-2", rumorEventID: "r2",
                sender: SharedInboxSender(publicKey: String(repeating: "a", count: 64)),
                board: SharedBoardDelivery(boardID: "b2"), receivedAt: Date(timeIntervalSince1970: 1),
                status: .accepted, respondedAt: Date(timeIntervalSince1970: 50.9)
            ),
        ]
        XCTAssertEqual(snapshot.chatSyncState, ChatSyncState(
            readThrough: ["peera": 100],
            inboxResponses: ["wrap-2": .init(status: .accepted, at: 50)]
        ))

        XCTAssertTrue(snapshot.applySyncedInboxResponses(["wrap-1": .init(status: .deleted, at: 70)]))
        XCTAssertEqual(snapshot.sharedBoardInboxItems?.first?.status, .deleted)
        XCTAssertEqual(snapshot.chatSyncState.inboxResponses["wrap-1"], .init(status: .deleted, at: 70))
        // An item already answered here is left alone.
        XCTAssertFalse(snapshot.applySyncedInboxResponses(["wrap-2": .init(status: .deleted, at: 90)]))

        XCTAssertTrue(snapshot.applySyncedReadThrough(["peerb": 5]))
        XCTAssertFalse(snapshot.applySyncedReadThrough(["peerb": 4]))
    }
}

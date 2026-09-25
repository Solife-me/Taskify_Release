import Foundation
import XCTest
@testable import TaskifyCore

/// "Clear queued republish" stops sending a board's republished records to public relays while
/// they still reach Taskify's own relay, since an entry can hold the only copy of an edit.
final class QueuedRepublishLimitTests: XCTestCase {
    private let firstParty = "wss://relay.solife.me"
    private let damus = "wss://relay.damus.io"
    private let nos = "wss://nos.lol"
    private var counter = 0

    private func entry(
        board: String = "board",
        relays: [String]? = nil,
        accepted: [String]? = nil,
        republish: Bool? = true,
        queuedAt: Date = Date(timeIntervalSince1970: 1_790_000_000)
    ) -> NostrOutboxEntry {
        counter += 1
        let event = NostrEvent(id: String(format: "%064x", counter), publicKey: String(repeating: "a", count: 64),
            createdAt: 1_790_000_000 + counter, kind: 30_301, tags: [["d", "task-\(counter)"]],
            content: "c", signature: "s")
        var entry = NostrOutboxEntry(event: event, relayURLs: relays ?? [nos, damus, firstParty],
            boardLocalID: board, taskID: "task-\(counter)", queuedAt: queuedAt,
            acceptedRelayURLs: accepted)
        entry.isRepublish = republish
        return entry
    }

    private func store(_ entries: [NostrOutboxEntry]) async throws -> NostrOutboxStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        try await store.enqueue(entries)
        return store
    }

    func testRepublishedEntriesKeepOnlyTaskifyRelays() async throws {
        let pending = entry()
        let partlyPublic = entry(accepted: [nos])
        let store = try await store([pending, partlyPublic])

        let changed = try await store.limitRepublishedEntries(boardLocalID: "board", toRelays: [firstParty])

        XCTAssertEqual(changed, 2)
        let remaining = await store.allEntries()
        XCTAssertEqual(remaining.map(\.pendingRelayURLs), [[firstParty], [firstParty]])
        XCTAssertEqual(remaining.last?.relayURLs, [nos, firstParty], "An acceptance already recorded is kept")
    }

    func testAnEntryAlreadyOnTaskifysRelayIsComplete() async throws {
        let delivered = entry(accepted: [firstParty])
        let store = try await store([delivered])
        let changed = try await store.limitRepublishedEntries(boardLocalID: "board", toRelays: [firstParty])
        XCTAssertEqual(changed, 1)
        let remaining = await store.entryCount()
        XCTAssertEqual(remaining, 0)
    }

    func testOrdinaryChangesAndEntriesWithoutATaskifyRelayAreUntouched() async throws {
        let edit = entry(republish: false)
        let publicOnly = entry(relays: [nos, damus])
        let otherBoard = entry(board: "other")
        let store = try await store([edit, publicOnly, otherBoard])

        let changed = try await store.limitRepublishedEntries(boardLocalID: "board", toRelays: [firstParty])

        XCTAssertEqual(changed, 0)
        let remaining = await store.allEntries()
        XCTAssertEqual(remaining.map(\.pendingRelayURLs), [[nos, damus, firstParty], [nos, damus], [nos, damus, firstParty]])
    }

    func testOutboxesFromBeforeTheFlagTreatABoardSizedBurstAsARepublish() async throws {
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        let burst = (0..<60).map { entry(republish: nil, queuedAt: start.addingTimeInterval(Double($0) * 0.01)) }
        let scattered = (1...3).map { entry(republish: nil, queuedAt: start.addingTimeInterval(Double($0) * 3_600)) }
        let store = try await store(burst + scattered)

        let changed = try await store.limitRepublishedEntries(boardLocalID: "board", toRelays: [firstParty])

        XCTAssertEqual(changed, 60)
        let byID = Dictionary(uniqueKeysWithValues: await store.allEntries().map { ($0.id, $0.pendingRelayURLs) })
        XCTAssertTrue(burst.allSatisfy { byID[$0.id] == [firstParty] })
        XCTAssertTrue(scattered.allSatisfy { byID[$0.id] == [nos, damus, firstParty] }, "Ordinary edits keep every relay")
    }

    func testTheFlagSurvivesSavingAndOldFilesDecodeWithoutIt() throws {
        let flagged = entry()
        let decoded = try JSONDecoder().decode(NostrOutboxEntry.self, from: JSONEncoder().encode(flagged))
        XCTAssertEqual(decoded.isRepublish, true)

        var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(flagged)) as! [String: Any]
        legacy.removeValue(forKey: "isRepublish")
        let old = try JSONDecoder().decode(NostrOutboxEntry.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertNil(old.isRepublish)

        let ordinary = NostrOutboxEntry(event: flagged.event, relayURLs: [firstParty], boardLocalID: "b", taskID: "t")
        XCTAssertEqual(ordinary.isRepublish, false, "New ordinary entries say so, so they never look like old bursts")
    }
}

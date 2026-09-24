import Foundation
import XCTest
@testable import TaskifyCore

/// A relay that refuses an event outright (`blocked:`, `restricted:`, `invalid:`) must not be sent
/// that event again on every reconnect, yet the change must stay queued: it may be the only copy.
final class RelayRejectionBackoffTests: XCTestCase {
    private let relayURL = "wss://strict.example"
    private let otherURL = "wss://other.example"

    private func store() -> NostrOutboxStore {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
    }

    private func entry(_ number: Int, relays: [String]) -> NostrOutboxEntry {
        NostrOutboxEntry(
            event: NostrEvent(
                id: String(format: "%064x", number),
                publicKey: String(repeating: "a", count: 64),
                createdAt: number,
                kind: 30078,
                tags: [],
                content: "change-\(number)",
                signature: "fixture"
            ),
            relayURLs: relays,
            boardLocalID: "scope",
            taskID: "record-\(number)"
        )
    }

    func testRefusedEventStaysQueuedButWaitsBeforeGoingBackToThatRelay() async throws {
        let outbox = store()
        let queued = entry(1, relays: [relayURL, otherURL])
        try await outbox.enqueue(queued)
        let now = Date(timeIntervalSince1970: 1_790_000_000)

        let retryAfter = try await outbox.recordRejection(eventID: queued.id, relayURL: relayURL, now: now)
        XCTAssertEqual(retryAfter, now.addingTimeInterval(3600))

        let count = await outbox.entryCount()
        XCTAssertEqual(count, 1, "A refusal never discards the change")
        let forStrict = await outbox.pendingEntries(for: relayURL, now: now.addingTimeInterval(60))
        XCTAssertEqual(forStrict, [], "Not resent to the relay that refused it before the retry time")
        let forOther = await outbox.pendingEntries(for: otherURL, now: now.addingTimeInterval(60))
        XCTAssertEqual(forOther.map(\.id), [queued.id], "Other relays are unaffected")
        let later = await outbox.pendingEntries(for: relayURL, now: now.addingTimeInterval(3601))
        XCTAssertEqual(later.map(\.id), [queued.id])
    }

    func testRepeatedRefusalsBackOffExponentiallyUpToAWeek() async throws {
        let outbox = store()
        let queued = entry(2, relays: [relayURL])
        try await outbox.enqueue(queued)
        var now = Date(timeIntervalSince1970: 1_790_000_000)
        var delays: [TimeInterval] = []
        for _ in 0..<10 {
            let retryAfter = try await outbox.recordRejection(eventID: queued.id, relayURL: relayURL, now: now)
            delays.append(try XCTUnwrap(retryAfter).timeIntervalSince(now))
            now = try XCTUnwrap(retryAfter)
        }
        XCTAssertEqual(Array(delays.prefix(4)), [3600, 7200, 14_400, 28_800])
        XCTAssertEqual(delays.last, 7 * 24 * 3600)
    }

    func testRefusalScheduleSurvivesRelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("outbox.json")
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let queued = entry(3, relays: [relayURL])
        do {
            let outbox = NostrOutboxStore(fileURL: url)
            try await outbox.enqueue(queued)
            _ = try await outbox.recordRejection(eventID: queued.id, relayURL: relayURL, now: now)
        }
        let reopened = NostrOutboxStore(fileURL: url)
        let pending = await reopened.pendingEntries(for: relayURL, now: now.addingTimeInterval(60))
        XCTAssertEqual(pending, [])
    }

    func testRejectionPrefixes() {
        XCTAssertTrue(NostrRelayRejection.isRateLimited("rate-limit: you note too much"))
        XCTAssertEqual(NostrRelayRejection.kind(of: "blocked: nope"), .refused)
        XCTAssertEqual(NostrRelayRejection.kind(of: "restricted: paid relay"), .refused)
        XCTAssertEqual(NostrRelayRejection.kind(of: "invalid: too large"), .refused)
        XCTAssertEqual(NostrRelayRejection.kind(of: "duplicate: already have it"), .delivered)
        XCTAssertEqual(NostrRelayRejection.kind(of: "error: db busy"), .transient)
        XCTAssertEqual(NostrRelayRejection.kind(of: "pow: difficulty 28"), .transient)
    }
}

import Foundation
import XCTest
@testable import TaskifyCore

final class ScriptureMemorySyncTests: XCTestCase {
    /// Native completion times carry sub-second precision, but the entry's `lastReviewISO` is
    /// written at second precision. The review must still count as applied, or every reconcile
    /// pass would bump the stage and review count again.
    func testReviewWrittenAtSecondPrecisionCountsAsApplied() {
        let completedAt = Date(timeIntervalSince1970: 1_790_000_000.567)
        let written = ISO8601DateFormatter().string(from: completedAt)
        XCTAssertTrue(ScriptureMemoryAlgorithm.reviewAlreadyApplied(
            completedAt: completedAt,
            entryLastReviewISO: written
        ))
    }

    /// The PWA writes millisecond timestamps; they must parse, both for the applied check and
    /// for due-date stats (otherwise a PWA-reviewed passage looks never reviewed).
    func testPWAMillisecondTimestampsParse() {
        let completedAt = Date(timeIntervalSince1970: 1_790_244_000.123)
        XCTAssertTrue(ScriptureMemoryAlgorithm.reviewAlreadyApplied(
            completedAt: completedAt,
            entryLastReviewISO: "2026-09-24T10:00:00.123Z"
        ))
        let entry = ScriptureMemoryEntry(
            bookID: "jhn", chapter: 3, startVerse: 16, endVerse: 16,
            addedAtISO: "2026-09-01T00:00:00.000Z",
            lastReviewISO: "2026-09-24T10:00:00.123Z",
            stage: 1, totalReviews: 1
        )
        let stats = ScriptureMemoryAlgorithm.stats(
            for: entry, baseDays: 1, totalEntries: 1,
            now: Date(timeIntervalSince1970: 1_790_244_060)
        )
        XCTAssertLessThan(stats.daysSinceReview, 1)
    }

    func testNewerCompletionIsNotTreatedAsApplied() {
        XCTAssertFalse(ScriptureMemoryAlgorithm.reviewAlreadyApplied(
            completedAt: Date(timeIntervalSince1970: 1_790_244_001),
            entryLastReviewISO: "2026-09-24T10:00:00.123Z"
        ))
        XCTAssertFalse(ScriptureMemoryAlgorithm.reviewAlreadyApplied(
            completedAt: Date(), entryLastReviewISO: nil
        ))
    }

    /// The PWA and the sync payload spell the key `bookId`; older native storage used `bookID`.
    func testEntryDecodesBothKeySpellingsAndEncodesPWASpelling() throws {
        let pwa = Data(#"{"id":"a","bookId":"jhn","chapter":3,"startVerse":null,"endVerse":null,"addedAtISO":"2026-09-01T00:00:00.000Z","stage":2,"totalReviews":4}"#.utf8)
        let legacy = Data(#"{"id":"b","bookID":"gen","chapter":1,"addedAtISO":"2026-09-01T00:00:00Z","stage":0,"totalReviews":0}"#.utf8)
        let decodedPWA = try JSONDecoder().decode(ScriptureMemoryEntry.self, from: pwa)
        let decodedLegacy = try JSONDecoder().decode(ScriptureMemoryEntry.self, from: legacy)
        XCTAssertEqual(decodedPWA.bookID, "jhn")
        XCTAssertNil(decodedPWA.startVerse)
        XCTAssertEqual(decodedPWA.totalReviews, 4)
        XCTAssertEqual(decodedLegacy.bookID, "gen")

        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decodedPWA)) as? [String: Any]
        XCTAssertEqual(encoded?["bookId"] as? String, "jhn")
        XCTAssertNil(encoded?["bookID"])
    }

    /// Must equal the PWA's `recurringInstanceId("scripture-memory", dueISO)` for the same local day.
    func testBootstrapTaskIDMatchesPWARecurringInstanceID() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let lateEvening = Date(timeIntervalSince1970: 1_790_302_000) // 2026-09-24 21:06 CDT, already 09-25 in UTC
        XCTAssertEqual(
            ScriptureMemoryAlgorithm.bootstrapTaskID(dueDate: lateEvening, calendar: calendar),
            "recurrence:scripture-memory:2026-09-24"
        )
    }
}

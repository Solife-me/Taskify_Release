import Foundation
import XCTest
@testable import TaskifyCore

/// Series cutoffs ("delete this and future") never end the Scripture Memory review series. A
/// cutoff recorded once for it deleted every review arriving from other devices on arrival, on
/// that device only, while the relays (and the Watch) still showed them open.
final class ScriptureReviewSeriesCutoffTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private func day(_ value: Int, month: Int = 11) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: month, day: value))!
    }

    private func review(_ dayOfMonth: Int, boardID: String, until: Date? = nil, deleted: Bool = false) -> TaskItem {
        TaskItem(
            id: String(format: "recurrence:scripture-memory:2026-11-%02d", dayOfMonth),
            boardID: boardID,
            title: "Review John 3:16",
            dueDate: day(dayOfMonth),
            dueDateEnabled: true,
            dueTimeZone: "UTC",
            recurrence: .daily(until: until),
            seriesID: ScriptureMemoryAlgorithm.seriesID,
            scriptureMemoryID: "e1",
            deleted: deleted
        )
    }

    func testIncomingReviewIsKeptDespiteAStoredCutoff() {
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.boards[0].id
        snapshot.recurringTaskSeriesCutoffs = [boardID: [ScriptureMemoryAlgorithm.seriesID: day(13, month: 8)]]
        XCTAssertTrue(snapshot.mergeRemoteTasks([(task: review(2, boardID: boardID), eventCreatedAt: 1_900_000_000)]))
        XCTAssertEqual(snapshot.tasks.filter { !$0.isDeleted }.map(\.id), ["recurrence:scripture-memory:2026-11-02"])
    }

    func testReviewTombstoneWithAnEndDateRecordsNoCutoff() {
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.boards[0].id
        let tombstone = review(1, boardID: boardID, until: day(31, month: 10), deleted: true)
        _ = snapshot.mergeRemoteTasks([(task: tombstone, eventCreatedAt: 1_900_000_000)])
        XCTAssertNil(snapshot.recurringTaskSeriesCutoffs?[boardID]?[ScriptureMemoryAlgorithm.seriesID])
        _ = snapshot.mergeRemoteTasks([(task: review(2, boardID: boardID), eventCreatedAt: 1_900_000_100)])
        XCTAssertEqual(snapshot.tasks.first { $0.id.hasSuffix("2026-11-02") }?.isDeleted, false)
    }

    func testLoadPurgesStoredReviewCutoffsAndKeepsOthers() {
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.boards[0].id
        snapshot.recurringTaskSeriesCutoffs = [boardID: [
            ScriptureMemoryAlgorithm.seriesID: day(13, month: 8),
            "other-series": day(13, month: 8),
        ]]
        snapshot.repairSelection()
        XCTAssertEqual(snapshot.recurringTaskSeriesCutoffs, [boardID: ["other-series": day(13, month: 8)]])
    }

    func testDeletingThisAndFutureDeletesOnlyTheReview() {
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.boards[0].id
        snapshot.tasks = [review(2, boardID: boardID), review(3, boardID: boardID)]
        XCTAssertFalse(snapshot.tasks[0].canEndRecurringSeries)
        let changes = snapshot.deleteTask(taskID: snapshot.tasks[0].id, scope: .thisAndFuture)
        XCTAssertEqual(changes.deletedTaskIDs, ["recurrence:scripture-memory:2026-11-02"])
        XCTAssertNil(snapshot.recurringTaskSeriesCutoffs)
        XCTAssertEqual(snapshot.tasks.filter { !$0.isDeleted }.map(\.id), ["recurrence:scripture-memory:2026-11-03"])
    }

    func testCompletingAReviewWithAnEndDateStillSchedulesTheNext() throws {
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.boards[0].id
        var done = review(2, boardID: boardID, until: day(13, month: 8))
        done.completed = true
        done.completedAt = day(2)
        snapshot.tasks = [done]
        let next = try XCTUnwrap(snapshot.ensureNextRecurrence(afterCompleted: done.id, now: day(2)))
        XCTAssertNil(next.recurrence?.untilDate)
        XCTAssertFalse(next.completed)
    }

    func testRestoresTheLatestReviewACutoffDeletedFromTodayOn() {
        let boardID = "b1"
        let tasks = [
            review(1, boardID: boardID, until: day(13, month: 8), deleted: true),
            review(2, boardID: boardID, until: day(13, month: 8), deleted: true),
            review(3, boardID: boardID, deleted: true),
        ]
        let restored = ScriptureMemoryAlgorithm.reviewDeletedByCutoffToRestore(tasks, today: day(2), calendar: calendar)
        XCTAssertEqual(restored?.id, "recurrence:scripture-memory:2026-11-02",
                       "A plain deletion is not restored; a cutoff deletion from today on is")
        XCTAssertNil(
            ScriptureMemoryAlgorithm.reviewDeletedByCutoffToRestore(Array(tasks.prefix(1)), today: day(2), calendar: calendar),
            "Overdue reviews stay deleted; a fresh one is created for today instead"
        )
    }
}

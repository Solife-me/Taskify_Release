import Foundation
import XCTest
@testable import TaskifyCore

/// Task ids must be unique in a snapshot: lookups such as `moveTask` build id-keyed dictionaries
/// that trap on a duplicate. Recurring occurrences have date-derived ids, so the next one can
/// collide with a deleted record of the same occurrence (deleted here or synced from another
/// device), which completing the previous occurrence used to append a second copy beside.
final class DuplicateTaskIDTests: XCTestCase {
    private func daily(_ id: String, day: Int) -> TaskItem {
        TaskItem(
            id: id, boardID: "week-default", title: "Daily",
            dueDate: Date(timeIntervalSince1970: TimeInterval(1_790_000_000 + day * 86_400)),
            dueDateEnabled: true, recurrence: .daily(), seriesID: "series",
            columnID: WeekdayColumn.containing(
                Date(timeIntervalSince1970: TimeInterval(1_790_000_000 + day * 86_400))
            ).rawValue
        )
    }

    private func nextOccurrenceID() -> String {
        var probe = TaskifySnapshot.empty
        probe.tasks = [daily("series", day: 0)]
        XCTAssertTrue(probe.toggleCompletion(taskID: "series"))
        let next = probe.tasks.first { $0.id != "series" }
        XCTAssertNotNil(next)
        return next?.id ?? ""
    }

    func testCompletingReusesADeletedRecordOfTheNextOccurrence() {
        let nextID = nextOccurrenceID()
        var deleted = daily(nextID, day: 1)
        deleted.deleted = true
        deleted.nostrUpdatedAt = 1_790_000_100

        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [daily("series", day: 0), deleted]
        XCTAssertTrue(snapshot.toggleCompletion(taskID: "series"))

        let copies = snapshot.tasks.filter { $0.id == nextID }
        XCTAssertEqual(copies.count, 1, "the next occurrence must not be appended beside its deleted record")
        XCTAssertEqual(copies.first?.isDeleted, false)
        XCTAssertEqual(copies.first?.completed, false)
    }

    func testMovingATaskAfterCompletingOverADeletedOccurrenceDoesNotTrap() {
        let nextID = nextOccurrenceID()
        var deleted = daily(nextID, day: 1)
        deleted.deleted = true

        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [daily("series", day: 0), deleted]
        XCTAssertTrue(snapshot.toggleCompletion(taskID: "series"))
        let target = WeekdayColumn.containing(Date(timeIntervalSince1970: 1_790_000_000 + 3 * 86_400))
        XCTAssertNotNil(snapshot.moveTask(taskID: nextID, toBoardID: "week-default", columnID: target.rawValue))
    }

    func testLoadRepairCollapsesDuplicateTaskIDs() {
        var tombstone = daily("dup", day: 1)
        tombstone.deleted = true
        tombstone.nostrUpdatedAt = 100
        var live = daily("dup", day: 1)
        live.nostrUpdatedAt = 200
        var stale = daily("other", day: 2)
        stale.title = "Stale"
        stale.nostrUpdatedAt = 50
        var fresh = daily("other", day: 2)
        fresh.title = "Fresh"
        fresh.nostrUpdatedAt = 60

        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [tombstone, fresh, live, stale]
        snapshot.repairSelection()

        XCTAssertEqual(snapshot.tasks.filter { $0.id == "dup" }.count, 1)
        XCTAssertEqual(snapshot.tasks.first { $0.id == "dup" }?.isDeleted, false)
        XCTAssertEqual(snapshot.tasks.filter { $0.id == "other" }.map(\.title), ["Fresh"])
    }

    func testLoadRepairPrefersAnUnpublishedLocalCopyOverAPublishedTombstone() {
        var tombstone = daily("dup", day: 1)
        tombstone.deleted = true
        tombstone.nostrUpdatedAt = 100
        let local = daily("dup", day: 1)

        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [tombstone, local]
        snapshot.repairSelection()

        XCTAssertEqual(snapshot.tasks.filter { $0.id == "dup" }.map(\.isDeleted), [false])
    }
}

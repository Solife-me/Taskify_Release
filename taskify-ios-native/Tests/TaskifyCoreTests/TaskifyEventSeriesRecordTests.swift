import Foundation
import XCTest
@testable import TaskifyCore

/// A recurring calendar event is published as one series record (its seed). Every client
/// generates the occurrences locally with the same ids, so creating, editing or ending a series
/// no longer publishes one record per occurrence.
final class TaskifyEventSeriesRecordTests: XCTestCase {
    private func seed(title: String = "Daily standup", start: String = "2026-07-27") -> TaskifyEvent {
        TaskifyEvent(
            id: "event-seed",
            boardID: "week-default",
            title: title,
            schedule: .date,
            startDateValue: start,
            recurrence: .daily(),
            seriesID: "event-seed",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 7, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted
        )
    }

    private func now() throws -> Date { try XCTUnwrap(TaskifyEvent.dateOnly("2026-07-28")) }

    func testGeneratedOccurrencesAreMarkedAndOnlyTheSeedIsPublished() throws {
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [seed()]
        _ = snapshot.rebuildTaskifyEventSeries(seedID: "event-seed")
        let occurrences = (snapshot.taskifyEvents ?? []).filter { $0.id != "event-seed" }
        XCTAssertEqual(occurrences.count, 23)
        XCTAssertTrue(occurrences.allSatisfy(\.isGenerated))
        XCTAssertFalse(snapshot.taskifyEvents![0].isGenerated)
    }

    func testAnotherDeviceGeneratesTheSameOccurrencesFromTheSeedAlone() throws {
        var sender = TaskifySnapshot.empty
        sender.taskifyEvents = [seed()]
        _ = sender.rebuildTaskifyEventSeries(seedID: "event-seed")

        var receiver = TaskifySnapshot.empty
        XCTAssertTrue(receiver.mergeRemoteTaskifyEvent(seed(), eventCreatedAt: 1_900_000_000))
        _ = receiver.ensureTaskifyEventRecurrenceWindow(now: try now())

        let senderIDs = Set((sender.taskifyEvents ?? []).map(\.id))
        let receiverIDs = Set((receiver.taskifyEvents ?? []).map(\.id))
        XCTAssertTrue(senderIDs.isSubset(of: receiverIDs), "Same deterministic occurrence ids on both devices")
        XCTAssertTrue((receiver.taskifyEvents ?? []).filter { $0.id != "event-seed" }.allSatisfy(\.isGenerated))
    }

    func testARemoteSeedEditRefreshesGeneratedOccurrencesButNotPublishedOnes() throws {
        var receiver = TaskifySnapshot.empty
        _ = receiver.mergeRemoteTaskifyEvent(seed(), eventCreatedAt: 1_900_000_000)
        _ = receiver.ensureTaskifyEventRecurrenceWindow(now: try now())
        // An occurrence someone edited on its own arrives as a published record.
        var exception = try XCTUnwrap(receiver.taskifyEvents?.first { $0.id == "recurrence_event-seed_2026-07-30" })
        exception.generated = nil
        exception.title = "Moved standup"
        _ = receiver.mergeRemoteTaskifyEvent(exception, eventCreatedAt: 1_900_000_100)

        _ = receiver.mergeRemoteTaskifyEvent(seed(title: "Team sync"), eventCreatedAt: 1_900_000_200)
        let changes = receiver.ensureTaskifyEventRecurrenceWindow(now: try now())
        XCTAssertFalse(changes.allEventIDs.isEmpty)

        let events = receiver.taskifyEvents ?? []
        XCTAssertEqual(events.first { $0.id == "recurrence_event-seed_2026-07-29" }?.title, "Team sync")
        XCTAssertEqual(events.first { $0.id == "recurrence_event-seed_2026-07-30" }?.title, "Moved standup")
        XCTAssertTrue(receiver.ensureTaskifyEventRecurrenceWindow(now: try now()).allEventIDs.isEmpty,
                      "A settled series refreshes to nothing")
    }

    func testDeletingOneGeneratedOccurrencePublishesATombstoneThatStaysDeleted() throws {
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [seed()]
        _ = snapshot.rebuildTaskifyEventSeries(seedID: "event-seed")
        let id = "recurrence_event-seed_2026-07-29"
        let changes = snapshot.deleteTaskifyEvent(eventID: id, scope: .single)
        XCTAssertEqual(changes.deletedEventIDs, [id])
        let tombstone = try XCTUnwrap(snapshot.taskifyEvents?.first { $0.id == id })
        XCTAssertTrue(tombstone.isDeleted)
        XCTAssertFalse(tombstone.isGenerated, "An exception is published")
        _ = snapshot.ensureTaskifyEventRecurrenceWindow(now: try now())
        XCTAssertEqual(snapshot.taskifyEvents?.filter { $0.id == id }.map(\.isDeleted), [true])
    }

    func testDeletingOnlyTheFirstOccurrenceMovesTheSeedForward() throws {
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [seed()]
        _ = snapshot.rebuildTaskifyEventSeries(seedID: "event-seed")
        let changes = snapshot.deleteTaskifyEvent(eventID: "event-seed", scope: .single)

        XCTAssertEqual(changes.updatedEventIDs, ["event-seed"])
        XCTAssertTrue(changes.deletedEventIDs.isEmpty)
        let events = snapshot.taskifyEvents ?? []
        let movedSeed = try XCTUnwrap(events.first { $0.id == "event-seed" })
        XCTAssertFalse(movedSeed.isDeleted, "The series continues")
        XCTAssertEqual(movedSeed.startDateValue, "2026-07-28")
        XCTAssertNil(events.first { $0.id == "recurrence_event-seed_2026-07-28" },
                     "The occurrence the seed now stands for is not duplicated")
        XCTAssertNotNil(events.first { $0.id == "recurrence_event-seed_2026-07-29" })
    }
}

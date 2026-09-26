import Foundation
import XCTest
@testable import TaskifyCore

/// A recurring series that fell behind: missed occurrences piling up on a week board, a Scripture
/// Memory review left overdue since July, and devices that disagree about what is still open.
final class RecurringCatchUpTests: XCTestCase {
    private let calendar = Calendar.current
    private let board = Board.week(id: "week")

    private func day(_ month: Int, _ day: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: month, day: day))!
    }

    private func occurrence(_ seriesID: String, _ date: Date, title: String = "Stretch", completed: Bool = false) -> TaskItem {
        let key = String(format: "%04d-%02d-%02d",
                         calendar.component(.year, from: date), calendar.component(.month, from: date),
                         calendar.component(.day, from: date))
        var task = TaskItem(
            id: "recurrence:\(seriesID):\(key)",
            boardID: board.id,
            title: title,
            dueDate: date,
            dueDateEnabled: true,
            recurrence: .daily(),
            seriesID: seriesID,
            columnID: WeekdayColumn.containing(date, calendar: calendar).rawValue
        )
        task.completed = completed
        return task
    }

    private var now: Date { day(9, 26).addingTimeInterval(11 * 3600) }

    // MARK: - Catch up

    func testCatchingUpLeavesOneTaskDueToday() throws {
        let missed = [day(9, 12), day(9, 19), day(9, 23)].map { occurrence("stretch", $0) }
        var snapshot = TaskifySnapshot(
            boards: [board],
            tasks: missed + [occurrence("stretch", day(9, 11), completed: true)],
            selectedBoardID: board.id
        )
        XCTAssertEqual(snapshot.missedOccurrences(ofSeriesContaining: missed[0].id, now: now).count, 3)

        let changes = snapshot.catchUpRecurringSeries(taskID: missed[0].id, now: now)

        XCTAssertEqual(Set(changes.deletedTaskIDs), Set(missed.map(\.id)))
        let open = snapshot.tasks.filter { !$0.isDeleted && !$0.completed }
        XCTAssertEqual(open.count, 1)
        let today = try XCTUnwrap(open.first)
        XCTAssertEqual(today.id, "recurrence:stretch:2026-09-26", "Every device derives the same id for today")
        XCTAssertEqual(today.dueDate, day(9, 26))
        XCTAssertEqual(today.columnID, WeekdayColumn.containing(day(9, 26), calendar: calendar).rawValue)
        XCTAssertEqual(changes.updatedTaskIDs, [today.id])
        XCTAssertTrue(snapshot.missedOccurrences(ofSeriesContaining: today.id, now: now).isEmpty)
        XCTAssertTrue(snapshot.tasks.contains { $0.completed }, "History is untouched")
    }

    func testCatchingUpKeepsTodaysOccurrenceWhenTheWeekAlreadyHasIt() {
        let missed = occurrence("stretch", day(9, 19))
        let today = occurrence("stretch", day(9, 26))
        var snapshot = TaskifySnapshot(boards: [board], tasks: [missed, today], selectedBoardID: board.id)

        let changes = snapshot.catchUpRecurringSeries(taskID: missed.id, now: now)

        XCTAssertEqual(changes.deletedTaskIDs, [missed.id])
        XCTAssertTrue(changes.updatedTaskIDs.isEmpty)
        XCTAssertEqual(snapshot.tasks.filter { !$0.isDeleted }.map(\.id), [today.id])
    }

    func testAScriptureReviewCaughtUpStillReviewsItsPassage() throws {
        var review = occurrence(ScriptureMemoryAlgorithm.seriesID, day(7, 31), title: "Review Titus 1:1-4")
        review.scriptureMemoryID = "titus-1-1"
        var snapshot = TaskifySnapshot(boards: [board], tasks: [review], selectedBoardID: board.id)

        snapshot.catchUpRecurringSeries(taskID: review.id, now: now)

        let caughtUp = try XCTUnwrap(snapshot.tasks.first { !$0.isDeleted })
        XCTAssertEqual(caughtUp.id, "recurrence:scripture-memory:2026-09-26")
        XCTAssertEqual(caughtUp.title, "Review Titus 1:1-4")
        XCTAssertEqual(caughtUp.scriptureMemoryID, "titus-1-1")
    }

    func testAnEndedSeriesIsNotCaughtUp() {
        var ended = occurrence("bible", day(8, 12))
        ended.recurrence = .daily(until: day(8, 11))
        var snapshot = TaskifySnapshot(boards: [board], tasks: [ended], selectedBoardID: board.id)
        XCTAssertTrue(snapshot.missedOccurrences(ofSeriesContaining: ended.id, now: now).isEmpty)
        XCTAssertTrue(snapshot.catchUpRecurringSeries(taskID: ended.id, now: now).allTaskIDs.isEmpty)
    }

    func testATaskDueTodayHasNothingToCatchUp() {
        let today = occurrence("stretch", day(9, 26))
        let snapshot = TaskifySnapshot(boards: [board], tasks: [today], selectedBoardID: board.id)
        XCTAssertTrue(snapshot.missedOccurrences(ofSeriesContaining: today.id, now: now).isEmpty)
    }

    // MARK: - Scripture Memory

    func testCompletingAnOverdueReviewSchedulesTheNextFromToday() throws {
        var review = occurrence(ScriptureMemoryAlgorithm.seriesID, day(7, 26), title: "Review Titus 1:1-4")
        review.scriptureMemoryID = "titus-1-1"
        var snapshot = TaskifySnapshot(boards: [board], tasks: [review], selectedBoardID: board.id)

        XCTAssertTrue(snapshot.toggleCompletion(taskID: review.id, now: now))

        let next = try XCTUnwrap(snapshot.tasks.first { !$0.completed && !$0.isDeleted })
        XCTAssertEqual(next.dueDate.map { calendar.startOfDay(for: $0) }, day(9, 27),
                       "Not July 27: a review is spaced from when it was done")
        XCTAssertEqual(next.id, "recurrence:scripture-memory:2026-09-27")
    }

    func testCompletingAnOrdinaryOverdueOccurrenceKeepsItsSchedule() throws {
        let missed = occurrence("stretch", day(9, 19))
        var snapshot = TaskifySnapshot(boards: [board], tasks: [missed], selectedBoardID: board.id)
        XCTAssertTrue(snapshot.toggleCompletion(taskID: missed.id, now: now))
        let next = try XCTUnwrap(snapshot.tasks.first { !$0.completed && !$0.isDeleted })
        XCTAssertEqual(next.dueDate, day(9, 20))
    }

    func testEveryDeviceKeepsTheSameOpenReview() {
        let stale = occurrence(ScriptureMemoryAlgorithm.seriesID, day(7, 31), title: "Review Titus 1:1-4")
        var current = occurrence(ScriptureMemoryAlgorithm.seriesID, day(9, 23), title: "Review Isaiah 56:6-8")
        // The stale copy was moved to this board last night, so it looks newer by creation time.
        current.createdAt = day(9, 20)
        var movedStale = stale
        movedStale.createdAt = day(9, 26)
        XCTAssertEqual(ScriptureMemoryAlgorithm.reviewToKeep([movedStale, current])?.id, current.id)
        XCTAssertEqual(ScriptureMemoryAlgorithm.reviewToKeep([current, movedStale])?.id, current.id)
        XCTAssertNil(ScriptureMemoryAlgorithm.reviewToKeep([current]))
    }

    // MARK: - Full-week generation

    func testTheWeekGeneratorDoesNotDuplicateAnOccurrenceMovedToAnotherDay() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let sunday = utc.date(from: DateComponents(year: 2026, month: 7, day: 19))!
        let monday = utc.date(from: DateComponents(year: 2026, month: 7, day: 20))!
        let tuesday = utc.date(from: DateComponents(year: 2026, month: 7, day: 21))!
        let seed = TaskItem(id: "read", boardID: board.id, title: "Read", dueDate: sunday, dueDateEnabled: true,
                            recurrence: .daily(), seriesID: "read", columnID: WeekdayColumn.sunday.rawValue)
        // Monday's occurrence, postponed to Tuesday: it keeps Monday's id.
        let moved = TaskItem(id: "recurrence:read:2026-07-20", boardID: board.id, title: "Read", dueDate: tuesday,
                             dueDateEnabled: true, recurrence: .daily(), seriesID: "read",
                             columnID: WeekdayColumn.tuesday.rawValue)
        var snapshot = TaskifySnapshot(boards: [board], tasks: [seed, moved], selectedBoardID: board.id)

        snapshot.ensureCurrentWeekTaskRecurrences(weekStartsOn: .sunday, newTaskPosition: .bottom,
                                                  now: monday.addingTimeInterval(3600), calendar: utc)

        let onTuesday = snapshot.tasks.filter {
            !$0.isDeleted && $0.dueDate.map { utc.isDate($0, inSameDayAs: tuesday) } == true
        }
        XCTAssertEqual(onTuesday.map(\.id), [moved.id])
    }
}

/// A device that synced past a change which reached the relays late never has it replayed; it
/// asks the relays for the current version of the tasks it shows as open.
final class LatestTaskRecordsTests: XCTestCase {
    private let relayURL = "wss://latest.example"
    private lazy var board = Board(id: "board", name: "Board", kind: .week, nostrBoardID: "latest-board-id", relayURLs: [relayURL])

    func testTheRelaysNewestVersionOfEachTaskIsReturned() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let relay = StoredEventsRelay()
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            connectionFactory: { _ in relay }
        )
        addTeardownBlock { await engine.stop() }
        await engine.configure(boards: [board], auxiliaryRelayURLs: [], inboxRelayURLs: [])

        var open = TaskItem(id: "missed", boardID: board.id, title: "Listen", createdAt: Date(timeIntervalSince1970: 1_780_000_000))
        var deleted = open
        deleted.deleted = true
        open.title = "Listen"
        let stillOpen = TaskItem(id: "fine", boardID: board.id, title: "Fine", createdAt: Date(timeIntervalSince1970: 1_780_000_000))
        await relay.store([
            try TaskEventCodec.taskEvent(task: open, board: board, createdAt: 1_000),
            try TaskEventCodec.taskEvent(task: deleted, board: board, createdAt: 2_000),
            try TaskEventCodec.taskEvent(task: stillOpen, board: board, createdAt: 1_500),
        ])

        let latest = await engine.latestTaskRecords([board.id: ["missed", "fine", "unknown"]])

        XCTAssertEqual(latest.answeredRelays, 1)
        let byID = Dictionary(uniqueKeysWithValues: latest.records.map { ($0.task.id, $0) })
        XCTAssertEqual(byID["missed"]?.task.isDeleted, true, "The deletion that reached the relay late is found")
        XCTAssertEqual(byID["missed"]?.eventCreatedAt, 2_000)
        XCTAssertEqual(byID["fine"]?.task.isDeleted, false)
        XCTAssertNil(byID["unknown"])

        var snapshot = TaskifySnapshot(boards: [board], tasks: [open, stillOpen], selectedBoardID: board.id)
        snapshot.tasks[0].nostrUpdatedAt = 1_000
        XCTAssertTrue(snapshot.mergeRemoteTasks(latest.records.map { ($0.task, $0.eventCreatedAt) }))
        XCTAssertTrue(snapshot.tasks.first { $0.id == "missed" }?.isDeleted == true)
    }
}

private actor StoredEventsRelay: TaskSyncRelayTransport {
    private let stream = AsyncStream<NostrRelayMessage>.makeStream()
    private var stored: [NostrEvent] = []

    func store(_ events: [NostrEvent]) { stored.append(contentsOf: events) }

    nonisolated func messages() -> AsyncStream<NostrRelayMessage> { stream.stream }
    func connect() {}
    func disconnect() {}
    func isResponsive(timeout: Duration) -> Bool { true }
    func subscribe(id: String, kinds: [Int], boards: [BoardSubscriptionFilter], limit: Int) {
        stream.continuation.yield(.endOfStoredEvents(subscriptionID: id))
    }
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) {}
    func closeSubscription(id: String) {}
    func publish(_ event: NostrEvent) {}
    func authenticate(_ event: NostrEvent) {}
    func request(id: String, filter: NostrRelayFilter) {
        let addresses = Set(filter.dTags ?? [])
        for event in stored where filter.kinds.contains(event.kind)
            && filter.authors.contains(event.publicKey)
            && addresses.contains(event.firstTagValue(named: "d") ?? "") {
            stream.continuation.yield(.event(subscriptionID: id, event: event))
        }
        stream.continuation.yield(.endOfStoredEvents(subscriptionID: id))
    }
}

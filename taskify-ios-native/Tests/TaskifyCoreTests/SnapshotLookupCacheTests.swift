import Foundation
import XCTest

@testable import TaskifyCore

final class SnapshotLookupCacheTests: XCTestCase {
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 0)!
        return value
    }

    private var now: Date { Date(timeIntervalSince1970: 1_783_339_200) }  // 2026-07-06 noon UTC

    private func fixture() -> TaskifySnapshot {
        var snapshot = TaskifySnapshot.empty
        snapshot.boards = [
            Board(
                id: "board", name: "Board", kind: .list,
                columns: [BoardColumn(id: "list", name: "List", order: 0)])
        ]
        snapshot.tasks = [
            TaskItem(
                id: "future", boardID: "board", title: "Zebra", dueDate: now.addingTimeInterval(86_400),
                dueDateEnabled: true, columnID: "list"),
            TaskItem(id: "done", boardID: "board", title: "Apple", columnID: "list", completed: true),
        ]
        snapshot.taskifyEvents = [event(id: "event", boardID: "board")]
        return snapshot
    }

    private func event(id: String, boardID: String) -> TaskifyEvent {
        TaskifyEvent(
            id: id, boardID: boardID, columnID: "list", title: id, schedule: .time,
            startISO: ISO8601DateFormatter().string(from: now.addingTimeInterval(86_400)),
            canonicalAddress: "", viewAddress: "", eventKey: "key", inviteToken: "", rsvpStatus: .accepted)
    }

    func testSecondaryViewsReuseProjectionsAcrossReadsAndMessagingWrites() {
        let cache = SnapshotLookupCache()
        let snapshot = fixture()
        var updated = snapshot
        updated.directMessageReadAt = ["peer": 123]
        for current in [snapshot, snapshot, updated] {
            cache.invalidate(from: snapshot, to: current)
            XCTAssertEqual(
                cache.boardUpcomingGroups(boardID: "board", snapshot: current, now: now, calendar: calendar)
                    .flatMap(\.tasks).map(\.id), ["future"])
            XCTAssertEqual(cache.boardCompletedTasks(boardID: "board", snapshot: current).map(\.id), ["done"])
        }
        XCTAssertEqual(cache.upcomingBuildCount, 1)
        XCTAssertEqual(cache.completedBuildCount, 1)
    }

    func testColumnEventSlicesAndCustomTaskOrderAreReused() {
        let cache = SnapshotLookupCache()
        let snapshot = fixture()
        for _ in 0..<3 {
            XCTAssertEqual(
                cache.boardEvents(
                    boardID: "board", columnID: "list", snapshot: snapshot, weekStartsOn: .monday, now: now,
                    calendar: calendar
                ).map(\.id), ["event"])
            XCTAssertEqual(
                cache.tasks(
                    boardID: "board", columnID: "list", includeCompleted: true, sortMode: .title,
                    sortDirection: .ascending, snapshot: snapshot, weekStartsOn: .monday, now: now,
                    calendar: calendar
                ).map(\.id), ["future", "done"])
        }
        XCTAssertEqual(cache.eventSliceBuildCount, 1)
        XCTAssertEqual(cache.taskSortBuildCount, 1)
    }

    func testRelevantWritesAndDateBoundariesRefreshSecondaryViews() {
        let cache = SnapshotLookupCache()
        let snapshot = fixture()
        _ = cache.boardUpcomingGroups(boardID: "board", snapshot: snapshot, now: now, calendar: calendar)
        _ = cache.boardCompletedTasks(boardID: "board", snapshot: snapshot)
        var updated = snapshot
        updated.tasks[0].completed = true
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertTrue(
            cache.boardUpcomingGroups(boardID: "board", snapshot: updated, now: now, calendar: calendar)
                .flatMap(\.tasks).isEmpty)
        XCTAssertEqual(cache.boardCompletedTasks(boardID: "board", snapshot: updated).count, 2)
        XCTAssertTrue(
            cache.boardUpcomingGroups(
                boardID: "board", snapshot: updated, now: now.addingTimeInterval(86_400), calendar: calendar
            ).isEmpty)
    }

    func testCompoundMembershipAndTaskMovesInvalidateScope() {
        let cache = SnapshotLookupCache()
        var snapshot = fixture()
        snapshot.boards += [
            Board(id: "child", name: "Child", kind: .list),
            Board(id: "compound", name: "Compound", kind: .compound, children: ["board"]),
        ]
        XCTAssertEqual(cache.boardCompletedTasks(boardID: "compound", snapshot: snapshot).map(\.id), ["done"])
        var updated = snapshot
        updated.boards[2].children = ["child"]
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertTrue(cache.boardCompletedTasks(boardID: "compound", snapshot: updated).isEmpty)
        XCTAssertTrue(
            cache.boardUpcomingGroups(boardID: "compound", snapshot: updated, now: now, calendar: calendar)
                .isEmpty)
        let beforeMove = updated
        updated.tasks[1].boardID = "child"
        cache.invalidate(from: beforeMove, to: updated)
        XCTAssertEqual(cache.boardCompletedTasks(boardID: "compound", snapshot: updated).map(\.id), ["done"])
        XCTAssertTrue(cache.boardCompletedTasks(boardID: "board", snapshot: updated).isEmpty)
    }

    func testEventWritesRefreshOnlyEventDependentProjections() {
        let cache = SnapshotLookupCache()
        let snapshot = fixture()
        _ = cache.boardCompletedTasks(boardID: "board", snapshot: snapshot)
        _ = cache.boardUpcomingRows(boardID: "board", snapshot: snapshot, now: now, calendar: calendar)
        XCTAssertEqual(
            cache.boardEvents(
                boardID: "board", columnID: "list", snapshot: snapshot, weekStartsOn: .monday, now: now,
                calendar: calendar
            ).count, 1)
        var updated = snapshot
        updated.taskifyEvents = []
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertTrue(
            cache.boardEvents(
                boardID: "board", columnID: "list", snapshot: updated, weekStartsOn: .monday, now: now,
                calendar: calendar
            ).isEmpty)
        XCTAssertEqual(
            cache.boardUpcomingRows(boardID: "board", snapshot: updated, now: now, calendar: calendar).count,
            2)  // header + task
        XCTAssertEqual(cache.boardCompletedTasks(boardID: "board", snapshot: updated).count, 1)
        XCTAssertEqual(cache.completedBuildCount, 1)
        XCTAssertEqual(cache.taskIndexBuildCount, 1)
    }

    func testEventSlicesMatchOrganizersAcrossWeekStartMidnightAndTimeZoneChanges() {
        let cache = SnapshotLookupCache()
        let snapshot = fixture()
        var shifted = calendar
        shifted.timeZone = TimeZone(secondsFromGMT: -10 * 3_600)!
        for date in [now, now.addingTimeInterval(86_400), now.addingTimeInterval(7 * 86_400)] {
            for currentCalendar in [calendar, shifted] {
                for weekStart in [WeekdayColumn.sunday, .monday] {
                    for weekday in WeekdayColumn.allCases {
                        let actual = cache.boardEvents(
                            boardID: "board", columnID: weekday.rawValue, weekday: weekday,
                            snapshot: snapshot, weekStartsOn: weekStart, now: date, calendar: currentCalendar)
                        let expected = TaskifyEventBoardOrganizer.events(
                            snapshot.acceptedTaskifyEvents, boardID: "board", weekday: weekday,
                            weekStartsOn: weekStart, now: date, calendar: currentCalendar)
                        XCTAssertEqual(actual, expected)
                    }
                    XCTAssertEqual(
                        cache.boardEvents(
                            boardID: "board", columnID: "list", snapshot: snapshot, weekStartsOn: weekStart,
                            now: date, calendar: currentCalendar),
                        TaskifyEventBoardOrganizer.events(
                            snapshot.acceptedTaskifyEvents, boardID: "board", columnID: "list",
                            weekStartsOn: weekStart, now: date, calendar: currentCalendar)
                    )
                }
                XCTAssertEqual(
                    cache.boardUpcomingGroups(
                        boardID: "board", snapshot: snapshot, now: date, calendar: currentCalendar),
                    BoardUpcomingOrganizer.groups(
                        tasks: snapshot.tasks, events: snapshot.acceptedTaskifyEvents,
                        includedBoardIDs: ["board"], now: date, calendar: currentCalendar)
                )
            }
        }
    }

    func testTaskSortAndVisibilityKeysMatchUncachedOrganizer() {
        let cache = SnapshotLookupCache()
        var snapshot = fixture()
        snapshot.tasks += [
            TaskItem(
                id: "second", boardID: "board", title: "Banana", dueDate: now, dueDateEnabled: true,
                columnID: "list")
        ]
        var shifted = calendar
        shifted.timeZone = TimeZone(secondsFromGMT: 10 * 3_600)!
        for currentCalendar in [calendar, shifted] {
            for includeCompleted in [true, false] {
                for mode in UpcomingSortMode.allCases {
                    for direction in [UpcomingSortDirection.ascending, .descending] {
                        let actual = cache.tasks(
                            boardID: "board", columnID: "list", includeCompleted: includeCompleted,
                            sortMode: mode, sortDirection: direction, snapshot: snapshot,
                            weekStartsOn: .monday, now: now, calendar: currentCalendar)
                        let raw = BoardTaskOrganizer.tasks(
                            snapshot.tasks, boardID: "board", columnID: "list", boardKind: .list,
                            includeCompleted: includeCompleted, weekStartsOn: .monday, now: now,
                            calendar: currentCalendar)
                        let expected =
                            mode == .manual
                            ? raw
                            : UpcomingTaskOrganizer.sortBoardTasks(raw, mode: mode, direction: direction)
                        XCTAssertEqual(actual, expected)
                    }
                }
            }
        }
        let old = snapshot
        snapshot.tasks[0].title = "Aardvark"
        cache.invalidate(from: old, to: snapshot)
        XCTAssertEqual(
            cache.tasks(
                boardID: "board", columnID: "list", includeCompleted: false, sortMode: .title,
                snapshot: snapshot, weekStartsOn: .monday, now: now, calendar: calendar
            ).map(\.id), ["future", "second"])
    }

    func testFlatTimelinePreservesOrderAndDistinctMultiDayEventIdentity() {
        let tasks = (0..<500).map { TaskItem(id: "\($0)", boardID: "board", title: "Task \($0)") }
        let event = event(id: "0", boardID: "board")
        let nextDate = now.addingTimeInterval(86_400)
        let rows = BoardUpcomingRow.rows(from: [
            BoardUpcomingGroup(date: now, tasks: tasks, events: [event]),
            BoardUpcomingGroup(date: nextDate, tasks: [], events: [event]),
        ])
        XCTAssertEqual(rows.count, 504)
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
        XCTAssertEqual(rows[0], .header(now))
        XCTAssertEqual(rows[1], .event(now, event))
        XCTAssertEqual(rows[2], .task(now, tasks[0]))
        XCTAssertEqual(rows.last, .event(nextDate, event))
    }

    func testPopulatedBoardProjectionsStayWarmDuringUnrelatedWrites() {
        let cache = SnapshotLookupCache()
        var snapshot = fixture()
        let now = now
        snapshot.taskifyEvents = (0..<400).map {
            event(id: "event-\($0)", boardID: $0.isMultiple(of: 2) ? "board" : "other")
        }
        snapshot.tasks += (0..<5_000).map { index in
            TaskItem(
                id: "large-\(index)", boardID: index.isMultiple(of: 2) ? "board" : "other",
                title: "Task \(index)", dueDate: now.addingTimeInterval(86_400), dueDateEnabled: true,
                columnID: "list", completed: index.isMultiple(of: 3))
        }
        for index in 0..<50 {
            let old = snapshot
            snapshot.directMessageReadAt = ["peer": index]
            cache.invalidate(from: old, to: snapshot)
            _ = cache.boardUpcomingRows(boardID: "board", snapshot: snapshot, now: now, calendar: calendar)
            _ = cache.boardCompletedTasks(boardID: "board", snapshot: snapshot)
            _ = cache.boardEvents(
                boardID: "board", columnID: "list", snapshot: snapshot, weekStartsOn: .monday, now: now,
                calendar: calendar)
            _ = cache.tasks(
                boardID: "board", columnID: "list", includeCompleted: true, sortMode: .title,
                snapshot: snapshot, weekStartsOn: .monday, now: now, calendar: calendar)
        }
        XCTAssertEqual(cache.taskIndexBuildCount, 1)
        XCTAssertEqual(cache.upcomingBuildCount, 1)
        XCTAssertEqual(cache.completedBuildCount, 1)
        XCTAssertEqual(cache.eventSliceBuildCount, 1)
        XCTAssertEqual(cache.taskSortBuildCount, 1)
    }

    func testMessagingAndSelectionWritesPreserveTaskIndex() {
        let cache = SnapshotLookupCache()
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [TaskItem(id: "task", boardID: "board", title: "Task")]
        XCTAssertEqual(cache.taskCount(boardID: "board", snapshot: snapshot), 1)
        var updated = snapshot
        updated.directMessageReadAt = ["peer": 123]
        updated.selectedBoardID = "another-board"
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertEqual(cache.taskCount(boardID: "board", snapshot: updated), 1)
        XCTAssertEqual(cache.taskIndexBuildCount, 1, "Unrelated writes must not rebuild the task index")
    }

    func testMinuteBoundaryRefreshesHiddenTasksWithoutRebuildingIndex() {
        let cache = SnapshotLookupCache()
        var snapshot = fixture()
        snapshot.tasks[0].hiddenUntilDate = now.addingTimeInterval(60)
        XCTAssertTrue(
            cache.tasks(
                boardID: "board", columnID: "list", includeCompleted: false, sortMode: .title,
                snapshot: snapshot, weekStartsOn: .monday, now: now, calendar: calendar
            ).isEmpty)
        XCTAssertEqual(
            cache.tasks(
                boardID: "board", columnID: "list", includeCompleted: false, sortMode: .title,
                snapshot: snapshot, weekStartsOn: .monday, now: now.addingTimeInterval(60), calendar: calendar
            ).map(\.id), ["future"])
        XCTAssertEqual(cache.taskIndexBuildCount, 1)
        XCTAssertEqual(cache.taskSortBuildCount, 2)
    }

    func testMessageReadContentAndArchiveChangesRefreshTheirCachedResults() {
        let cache = SnapshotLookupCache()
        let peer = String(repeating: "a", count: 64)
        var snapshot = fixture()
        snapshot.directMessages = [
            NostrDirectMessage(
                rumorEventID: "message", wrapEventID: "wrap", peerPublicKey: peer,
                senderPublicKey: peer, content: "Before", createdAt: 100, isIncoming: true
            )
        ]
        XCTAssertEqual(cache.directMessageThreads(snapshot: snapshot).first?.unreadCount, 1)
        XCTAssertEqual(cache.directMessages(with: peer, snapshot: snapshot).first?.content, "Before")
        var updated = snapshot
        updated.directMessageReadAt = [peer: 100]
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertEqual(cache.directMessageThreads(snapshot: updated).first?.unreadCount, 0)
        snapshot = updated
        updated.directMessages?[0].content = "After"
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertEqual(cache.directMessages(with: peer, snapshot: updated).first?.content, "After")
        XCTAssertEqual(cache.directMessageThreads(snapshot: updated).first?.messages.first?.content, "After")
        snapshot = updated
        updated.directMessageArchivedAt = [peer: 100]
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertTrue(cache.directMessageThreads(snapshot: updated).isEmpty)
    }

    func testTaskWritesRefreshIndexAndCounts() {
        let cache = SnapshotLookupCache()
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [TaskItem(id: "task", boardID: "board", title: "Task")]
        XCTAssertEqual(cache.completedTaskCount(boardIDs: ["board"], snapshot: snapshot), 0)
        var updated = snapshot
        updated.tasks[0].completed = true
        cache.invalidate(from: snapshot, to: updated)
        XCTAssertEqual(cache.completedTaskCount(boardIDs: ["board"], snapshot: updated), 1)
        XCTAssertEqual(cache.taskIndexBuildCount, 2)
    }
}

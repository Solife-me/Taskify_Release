import Foundation
import XCTest
@testable import TaskifyCore

final class BoardUpcomingOrganizerTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    func testGroupsOnlyFutureBoardItemsAndExpandsAllDayEventAcrossFutureDates() throws {
        let now = try date(year: 2026, month: 8, day: 5, hour: 12)
        let today = task(id: "today", boardID: "board", dueDate: try date(year: 2026, month: 8, day: 5))
        let tomorrow = task(id: "tomorrow", boardID: "board", dueDate: try date(year: 2026, month: 8, day: 6, hour: 14))
        let nextDay = task(id: "next-day", boardID: "board", dueDate: try date(year: 2026, month: 8, day: 7))
        let completed = task(
            id: "completed",
            boardID: "board",
            dueDate: try date(year: 2026, month: 8, day: 6),
            completed: true
        )
        let otherBoard = task(id: "other", boardID: "other", dueDate: try date(year: 2026, month: 8, day: 6))

        let spanningEvent = event(
            id: "trip",
            boardID: "board",
            schedule: .date,
            startDate: "2026-08-05",
            endDate: "2026-08-07"
        )
        let timedEvent = event(
            id: "call",
            boardID: "board",
            schedule: .time,
            start: "2026-08-06T16:00:00Z",
            end: "2026-08-06T17:00:00Z"
        )
        let deletedEvent = event(
            id: "deleted",
            boardID: "board",
            schedule: .date,
            startDate: "2026-08-06",
            endDate: "2026-08-06",
            deleted: true
        )

        let groups = BoardUpcomingOrganizer.groups(
            tasks: [today, tomorrow, nextDay, completed, otherBoard],
            events: [spanningEvent, timedEvent, deletedEvent],
            includedBoardIDs: ["board"],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(groups.map { calendar.component(.day, from: $0.date) }, [6, 7])
        XCTAssertEqual(groups[0].tasks.map(\.id), ["tomorrow"])
        XCTAssertEqual(groups[0].events.map(\.id), ["trip", "call"])
        XCTAssertEqual(groups[1].tasks.map(\.id), ["next-day"])
        XCTAssertEqual(groups[1].events.map(\.id), ["trip"])
    }

    func testIncludesCompoundChildBoardsAndSortsTasksByDueTime() throws {
        let now = try date(year: 2026, month: 8, day: 5, hour: 12)
        let later = task(id: "later", boardID: "child-b", dueDate: try date(year: 2026, month: 8, day: 6, hour: 17))
        let earlier = task(id: "earlier", boardID: "child-a", dueDate: try date(year: 2026, month: 8, day: 6, hour: 9))
        let parent = task(id: "parent", boardID: "compound", dueDate: try date(year: 2026, month: 8, day: 6, hour: 8))
        let excluded = task(id: "excluded", boardID: "other", dueDate: try date(year: 2026, month: 8, day: 6, hour: 7))

        let groups = BoardUpcomingOrganizer.groups(
            tasks: [later, excluded, earlier, parent],
            events: [],
            includedBoardIDs: ["compound", "child-a", "child-b"],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].tasks.map(\.id), ["parent", "earlier", "later"])
    }

    private func date(year: Int, month: Int, day: Int, hour: Int = 0) throws -> Date {
        try XCTUnwrap(calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour)))
    }

    private func task(
        id: String,
        boardID: String,
        dueDate: Date,
        completed: Bool = false
    ) -> TaskItem {
        TaskItem(
            id: id,
            boardID: boardID,
            title: id,
            dueDate: dueDate,
            dueDateEnabled: true,
            dueTimeEnabled: true,
            createdAt: dueDate,
            completed: completed
        )
    }

    private func event(
        id: String,
        boardID: String,
        schedule: TaskifyEventSchedule,
        startDate: String? = nil,
        endDate: String? = nil,
        start: String? = nil,
        end: String? = nil,
        deleted: Bool = false
    ) -> TaskifyEvent {
        TaskifyEvent(
            id: id,
            boardID: boardID,
            title: id,
            schedule: schedule,
            startDateValue: startDate,
            endDateValue: endDate,
            startISO: start,
            endISO: end,
            canonicalAddress: "",
            viewAddress: "",
            eventKey: "key-\(id)",
            inviteToken: "",
            rsvpStatus: .accepted,
            deleted: deleted
        )
    }
}

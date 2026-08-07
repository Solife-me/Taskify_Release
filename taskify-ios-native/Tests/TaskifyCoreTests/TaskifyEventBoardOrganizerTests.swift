import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyEventBoardOrganizerTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    func testWeekBoardOnlyShowsEventsOverlappingTheVisibleWeekday() throws {
        let now = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 8,
            day: 5,
            hour: 12
        )))
        let mondayEvent = event(
            id: "monday",
            boardID: "week",
            schedule: .time,
            start: "2026-08-03T15:00:00Z",
            end: "2026-08-03T16:00:00Z"
        )
        let multiDayEvent = event(
            id: "trip",
            boardID: "week",
            schedule: .date,
            startDate: "2026-08-04",
            endDate: "2026-08-06"
        )
        let nextWeekEvent = event(
            id: "next-week",
            boardID: "week",
            schedule: .time,
            start: "2026-08-10T15:00:00Z",
            end: "2026-08-10T16:00:00Z"
        )
        let otherBoard = event(
            id: "other-board",
            boardID: "other",
            schedule: .time,
            start: "2026-08-05T15:00:00Z",
            end: "2026-08-05T16:00:00Z"
        )

        let events = [mondayEvent, multiDayEvent, nextWeekEvent, otherBoard]

        XCTAssertEqual(
            TaskifyEventBoardOrganizer.events(
                events,
                boardID: "week",
                weekday: .monday,
                weekStartsOn: .monday,
                now: now,
                calendar: calendar
            ).map(\.id),
            ["monday"]
        )
        XCTAssertEqual(
            TaskifyEventBoardOrganizer.events(
                events,
                boardID: "week",
                weekday: .wednesday,
                weekStartsOn: .monday,
                now: now,
                calendar: calendar
            ).map(\.id),
            ["trip"]
        )
        XCTAssertEqual(
            TaskifyEventBoardOrganizer.events(
                events,
                boardID: "week",
                weekday: .thursday,
                weekStartsOn: .monday,
                now: now,
                calendar: calendar
            ).map(\.id),
            ["trip"]
        )
    }

    func testListBoardShowsCurrentAndFutureEventsInTheirAssignedColumn() throws {
        let now = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 8,
            day: 5,
            hour: 12
        )))
        let events = [
            event(
                id: "future",
                boardID: "list",
                columnID: "todo",
                order: 2,
                schedule: .date,
                startDate: "2026-09-01",
                endDate: "2026-09-01"
            ),
            event(
                id: "this-week",
                boardID: "list",
                columnID: "todo",
                order: 1,
                schedule: .time,
                start: "2026-08-06T17:00:00Z",
                end: "2026-08-06T18:00:00Z"
            ),
            event(
                id: "past",
                boardID: "list",
                columnID: "todo",
                order: 0,
                schedule: .date,
                startDate: "2026-07-01",
                endDate: "2026-07-01"
            ),
            event(
                id: "other-column",
                boardID: "list",
                columnID: "done",
                order: 0,
                schedule: .date,
                startDate: "2026-08-05",
                endDate: "2026-08-05"
            )
        ]

        XCTAssertEqual(
            TaskifyEventBoardOrganizer.events(
                events,
                boardID: "list",
                columnID: "todo",
                weekStartsOn: .monday,
                now: now,
                calendar: calendar
            ).map(\.id),
            ["this-week", "future"]
        )
    }

    private func event(
        id: String,
        boardID: String,
        columnID: String? = nil,
        order: Int = 0,
        schedule: TaskifyEventSchedule,
        startDate: String? = nil,
        endDate: String? = nil,
        start: String? = nil,
        end: String? = nil
    ) -> TaskifyEvent {
        TaskifyEvent(
            id: id,
            boardID: boardID,
            columnID: columnID,
            order: order,
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
            rsvpStatus: .accepted
        )
    }
}

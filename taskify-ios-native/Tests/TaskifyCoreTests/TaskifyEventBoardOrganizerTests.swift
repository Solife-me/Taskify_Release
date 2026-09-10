import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyEventBoardOrganizerTests: XCTestCase {
    func testEventTimestampParsingPreservesOffsetsAndFractionalSeconds() throws {
        let date = try XCTUnwrap(TaskifyEvent.isoDate("2026-09-03T12:30:45Z"))
        XCTAssertEqual(TaskifyEvent.isoDate("2026-09-03T07:30:45-05:00"), date)
        let fractional = try XCTUnwrap(TaskifyEvent.isoDate("2026-09-03T12:30:45.125Z"))
        XCTAssertEqual(fractional.timeIntervalSince(date), 0.125, accuracy: 0.0001)
        XCTAssertNil(TaskifyEvent.isoDate("not-a-date"))
        XCTAssertEqual(TaskifyEvent.isoDate("2026-09-03T12:30:45Z"), date)
    }

    func testEventTimestampParserSupportsConcurrentReaders() throws {
        let base = try XCTUnwrap(TaskifyEvent.isoDate("2026-09-03T12:30:45Z"))
        DispatchQueue.concurrentPerform(iterations: 500) { index in
            let fractional = index.isMultiple(of: 2)
            let text = fractional ? "2026-09-03T07:30:45.125-05:00" : "2026-09-03T12:30:45Z"
            XCTAssertEqual(TaskifyEvent.isoDate(text), base.addingTimeInterval(fractional ? 0.125 : 0))
        }
    }

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

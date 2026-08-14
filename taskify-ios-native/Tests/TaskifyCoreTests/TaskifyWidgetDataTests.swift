import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifyWidgetDataTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_785_600_000) // 2026-08-02 12:00 UTC
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func snapshot(_ tasks: [(title: String, due: Date?, completed: Bool, deleted: Bool)]) -> TaskifySnapshot {
        let board = Board(name: "Work", kind: .list, columns: [BoardColumn(id: "col", name: "To do", order: 0)])
        var snapshot = TaskifySnapshot(boards: [board], tasks: [], selectedBoardID: board.id)
        for (offset, spec) in tasks.enumerated() {
            let task = TaskItem(
                boardID: board.id,
                title: spec.title,
                dueDate: spec.due,
                dueDateEnabled: spec.due != nil,
                createdAt: Date(timeIntervalSince1970: 1_000_000 + Double(offset)),
                order: offset,
                columnID: "col",
                completed: spec.completed,
                deleted: spec.deleted ? true : nil
            )
            snapshot.tasks.append(task)
        }
        return snapshot
    }

    private func at(_ hoursFromNow: Double) -> Date {
        now.addingTimeInterval(hoursFromNow * 3600)
    }

    private func widgetEvent(
        id: String,
        boardID: String,
        columnID: String,
        start: Date,
        end: Date,
        deleted: Bool = false
    ) -> TaskifyEvent {
        let formatter = ISO8601DateFormatter()
        return TaskifyEvent(
            id: id,
            boardID: boardID,
            columnID: columnID,
            title: id,
            schedule: .time,
            startISO: formatter.string(from: start),
            endISO: formatter.string(from: end),
            canonicalAddress: "",
            viewAddress: "",
            eventKey: "key-\(id)",
            inviteToken: "",
            rsvpStatus: .accepted,
            deleted: deleted
        )
    }

    private func widgetAllDayEvent(
        id: String,
        boardID: String,
        startDate: String,
        endDate: String
    ) -> TaskifyEvent {
        TaskifyEvent(
            id: id,
            boardID: boardID,
            title: id,
            schedule: .date,
            startDateValue: startDate,
            endDateValue: endDate,
            canonicalAddress: "",
            viewAddress: "",
            eventKey: "key-\(id)",
            inviteToken: "",
            rsvpStatus: .accepted
        )
    }

    // MARK: - Today

    func testIncludesTasksDueLaterToday() {
        let data = snapshot([("Standup", at(2), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.map(\.title), ["Standup"])
    }

    func testIncludesTasksDueEarlierToday() {
        // Earlier today is still today; only a previous day is excluded.
        let data = snapshot([("Email", at(-3), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.map(\.title), ["Email"])
    }

    func testTomorrowIsUpcomingButNotToday() {
        let data = snapshot([("Later", at(30), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.today.isEmpty)
        XCTAssertEqual(data.todayCount, 0)
        XCTAssertEqual(data.upcoming.map(\.title), ["Later"])
    }

    func testExcludesCompletedAndDeletedTasks() {
        let data = snapshot([
            ("Done", at(1), true, false),
            ("Gone", at(1), false, true),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.isEmpty)
    }

    func testExcludesTasksWithNoDueDate() {
        let data = snapshot([("Someday", nil, false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.today.isEmpty)
    }

    // MARK: - Overdue is not the widget's business

    /// Upcoming filters to `dueDate >= startOfToday`, so overdue work appears nowhere in the app.
    /// Week-board tasks are all created with a due date, so unfinished ones accumulate forever --
    /// counting them here produced a widget reporting a dozen tasks against an Upcoming view
    /// showing none.
    func testExcludesOverdueTasksEntirely() {
        let data = snapshot([
            ("Yesterday", at(-30), false, false),
            ("Last week", at(-24 * 7), false, false),
            ("Today", at(2), false, false),
        ]).widgetData(now: now, calendar: calendar)

        XCTAssertEqual(data.today.map(\.title), ["Today"])
        XCTAssertEqual(data.todayCount, 1)
    }

    func testShowsNothingWhenOnlyOverdueWorkExists() {
        let data = snapshot([("Yesterday", at(-30), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.isEmpty)
        XCTAssertNil(data.nextTask)
        XCTAssertEqual(data.todayCount, 0)
    }

    // MARK: - Upcoming vs Today

    /// The Upcoming widget looks ahead; the Today widget doesn't.
    func testUpcomingLooksBeyondTodayButTodayDoesNot() {
        let data = snapshot([
            ("Today", at(2), false, false),
            ("Tomorrow", at(26), false, false),
            ("Next week", at(24 * 7), false, false),
        ]).widgetData(now: now, calendar: calendar)

        XCTAssertEqual(data.today.map(\.title), ["Today"])
        XCTAssertEqual(data.upcoming.map(\.title), ["Today", "Tomorrow", "Next week"])
        XCTAssertEqual(data.todayCount, 1)
    }

    func testUpcomingExcludesOverdueToo() {
        let data = snapshot([
            ("Yesterday", at(-30), false, false),
            ("Tomorrow", at(26), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.upcoming.map(\.title), ["Tomorrow"])
    }

    func testUpcomingWidgetTakesTheNextFourItemsAcrossDates() {
        let items = [
            TaskifyWidgetTask(id: "5", title: "Later", boardID: "b", boardName: "Work", dueDate: at(72)),
            TaskifyWidgetTask(id: "2", title: "Today second", boardID: "b", boardName: "Work", dueDate: at(2)),
            TaskifyWidgetTask(id: "4", title: "Day after", boardID: "b", boardName: "Work", dueDate: at(50)),
            TaskifyWidgetTask(id: "1", title: "Today first", boardID: "b", boardName: "Work", dueDate: at(1)),
            TaskifyWidgetTask(id: "3", title: "Tomorrow", boardID: "b", boardName: "Work", dueDate: at(26)),
        ]

        let visible = items.upcomingWidgetItems(after: now, calendar: calendar, limit: 4)

        XCTAssertEqual(visible.map(\.title), ["Today first", "Today second", "Tomorrow", "Day after"])
    }

    func testUpcomingWidgetExcludesPastTimedItemsButKeepsTodayAllDayAndOngoingEvents() {
        let midnight = calendar.startOfDay(for: now)
        let items = [
            TaskifyWidgetTask(
                id: "yesterday",
                title: "Yesterday all-day",
                boardID: "b",
                boardName: "Work",
                dueDate: at(-24),
                isAllDay: true
            ),
            TaskifyWidgetTask(
                id: "past-task",
                title: "Past task",
                boardID: "b",
                boardName: "Work",
                dueDate: at(-1)
            ),
            TaskifyWidgetTask(
                id: "ended-event",
                title: "Ended event",
                boardID: "b",
                boardName: "Work",
                dueDate: at(-2),
                endDate: at(-1),
                kind: .event
            ),
            TaskifyWidgetTask(
                id: "today",
                title: "Today all-day",
                boardID: "b",
                boardName: "Work",
                dueDate: midnight,
                isAllDay: true
            ),
            TaskifyWidgetTask(
                id: "ongoing-event",
                title: "Ongoing event",
                boardID: "b",
                boardName: "Work",
                dueDate: at(-1),
                endDate: at(1),
                kind: .event
            ),
        ]

        let visible = items.upcomingWidgetItems(after: now, calendar: calendar, limit: 10)

        XCTAssertEqual(visible.map(\.title), ["Today all-day", "Ongoing event"])
    }

    func testUpcomingWidgetWithZeroCapacityIsEmpty() {
        let item = TaskifyWidgetTask(
            id: "future",
            title: "Future",
            boardID: "b",
            boardName: "Work",
            dueDate: at(1)
        )
        XCTAssertTrue([item].upcomingWidgetItems(after: now, calendar: calendar, limit: 0).isEmpty)
    }

    /// With today clear, the Lock Screen should still name whatever is actually next.
    func testNextTaskLooksAheadWhenTodayIsEmpty() {
        let data = snapshot([("Thursday", at(48), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertTrue(data.today.isEmpty)
        XCTAssertEqual(data.nextTask?.title, "Thursday")
    }

    func testNextTaskIsTodaysEarliest() {
        let data = snapshot([
            ("Afternoon", at(5), false, false),
            ("Morning", at(1), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.nextTask?.title, "Morning")
    }

    // MARK: - Ordering, limits, boards

    func testTasksAreOrderedByDueDate() {
        let data = snapshot([
            ("Third", at(6), false, false),
            ("First", at(1), false, false),
            ("Second", at(3), false, false),
        ]).widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.map(\.title), ["First", "Second", "Third"])
    }

    func testHonoursTheRowLimit() {
        let many = (1...20).map { ("Task \($0)", at(Double($0) * 0.1), false, false) }
        let data = snapshot(many).widgetData(now: now, calendar: calendar, limit: 5)
        XCTAssertEqual(data.today.count, 5)
        XCTAssertEqual(data.today.first?.title, "Task 1")
    }

    func testCarriesTheBoardNameForEachTask() {
        let data = snapshot([("Standup", at(1), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.first?.boardName, "Work")
    }

    func testBoardSummariesCountOnlyOpenTasks() {
        let data = snapshot([
            ("Open", at(1), false, false),
            ("Done", at(1), true, false),
            ("Deleted", at(1), false, true),
        ]).widgetData(now: now, calendar: calendar)

        XCTAssertEqual(data.boards.map(\.name), ["Work"])
        XCTAssertEqual(data.boards.first?.openTaskCount, 1)
    }

    func testBoardWidgetFiltersAListBoardByColumn() {
        let todo = BoardColumn(id: "todo", name: "To Do", order: 0)
        let doing = BoardColumn(id: "doing", name: "Doing", order: 1)
        let board = Board(id: "board", name: "Work", kind: .list, columns: [todo, doing])
        let tasks = [
            TaskItem(id: "a", boardID: board.id, title: "First", order: 0, columnID: todo.id),
            TaskItem(id: "b", boardID: board.id, title: "Second", order: 0, columnID: doing.id),
            TaskItem(id: "c", boardID: board.id, title: "Done", order: 1, columnID: todo.id, completed: true),
        ]
        let snapshot = TaskifySnapshot(boards: [board], tasks: tasks, selectedBoardID: board.id)

        let data = snapshot.boardWidgetData(
            boardID: board.id,
            scope: .column(todo.id),
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(data?.scopeName, "To Do")
        XCTAssertEqual(data?.destinationColumnID, todo.id)
        XCTAssertEqual(data?.board.openTaskCount, 1)
        XCTAssertEqual(data?.tasks.map(\.title), ["First"])
    }

    func testBoardWidgetAllListScopeCountsAcrossColumnsAndTargetsTheFirstColumn() {
        let later = BoardColumn(id: "later", name: "Later", order: 2)
        let inbox = BoardColumn(id: "inbox", name: "Inbox", order: 0)
        let board = Board(id: "board", name: "Work", kind: .list, columns: [later, inbox])
        let tasks = [
            TaskItem(id: "a", boardID: board.id, title: "Inbox task", order: 0, columnID: inbox.id),
            TaskItem(id: "b", boardID: board.id, title: "Later task", order: 1, columnID: later.id),
        ]
        let snapshot = TaskifySnapshot(boards: [board], tasks: tasks, selectedBoardID: board.id)

        let data = snapshot.boardWidgetData(boardID: board.id, scope: .all, now: now, calendar: calendar)

        XCTAssertEqual(data?.scopeName, "All")
        XCTAssertEqual(data?.destinationColumnID, inbox.id)
        XCTAssertEqual(data?.board.openTaskCount, 2)
        XCTAssertEqual(data?.tasks.map(\.title), ["Inbox task", "Later task"])
    }

    func testBoardWidgetWeekTodayScopeShowsOnlyToday() {
        let board = Board.week(id: "week", name: "Week")
        let tasks = [
            TaskItem(
                id: "today",
                boardID: board.id,
                title: "Today",
                dueDate: now,
                dueDateEnabled: true,
                columnID: WeekdayColumn.containing(now, calendar: calendar).rawValue
            ),
            TaskItem(
                id: "yesterday",
                boardID: board.id,
                title: "Yesterday",
                dueDate: at(-24),
                dueDateEnabled: true,
                columnID: WeekdayColumn.containing(at(-24), calendar: calendar).rawValue
            ),
        ]
        let snapshot = TaskifySnapshot(boards: [board], tasks: tasks, selectedBoardID: board.id)

        let data = snapshot.boardWidgetData(boardID: board.id, scope: .today, now: now, calendar: calendar)

        XCTAssertEqual(data?.scopeName, "Today")
        XCTAssertEqual(data?.destinationColumnID, WeekdayColumn.containing(now, calendar: calendar).rawValue)
        XCTAssertEqual(data?.tasks.map(\.title), ["Today"])
    }

    func testBoardWidgetWeekAllScopeIncludesUpcomingWeeks() {
        let board = Board.week(id: "week", name: "Week")
        let nextWeek = at(24 * 8)
        let tasks = [
            TaskItem(
                id: "today",
                boardID: board.id,
                title: "Current week",
                dueDate: now,
                dueDateEnabled: true,
                columnID: WeekdayColumn.containing(now, calendar: calendar).rawValue
            ),
            TaskItem(
                id: "future",
                boardID: board.id,
                title: "Future week",
                dueDate: nextWeek,
                dueDateEnabled: true,
                columnID: WeekdayColumn.containing(nextWeek, calendar: calendar).rawValue
            ),
        ]
        let snapshot = TaskifySnapshot(boards: [board], tasks: tasks, selectedBoardID: board.id)

        let data = snapshot.boardWidgetData(boardID: board.id, scope: .all, now: now, calendar: calendar)

        XCTAssertEqual(data?.board.openTaskCount, 2)
        XCTAssertEqual(data?.itemCount, 2)
        XCTAssertEqual(data?.tasks.map(\.title), ["Current week", "Future week"])
    }

    func testBoardWidgetIncludesCurrentAndUpcomingEventsInTheSelectedList() {
        let todo = BoardColumn(id: "todo", name: "To Do", order: 0)
        let later = BoardColumn(id: "later", name: "Later", order: 1)
        let board = Board(id: "board", name: "Work", kind: .list, columns: [todo, later])
        let task = TaskItem(id: "task", boardID: board.id, title: "Open task", order: 0, columnID: todo.id)
        var snapshot = TaskifySnapshot(boards: [board], tasks: [task], selectedBoardID: board.id)
        snapshot.taskifyEvents = [
            widgetEvent(id: "meeting", boardID: board.id, columnID: todo.id, start: at(2), end: at(3)),
            widgetEvent(id: "other", boardID: board.id, columnID: later.id, start: at(1), end: at(2)),
            widgetEvent(id: "ended", boardID: board.id, columnID: todo.id, start: at(-2), end: at(-1)),
            widgetEvent(id: "deleted", boardID: board.id, columnID: todo.id, start: at(4), end: at(5), deleted: true),
        ]

        let data = snapshot.boardWidgetData(
            boardID: board.id,
            scope: .column(todo.id),
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(data?.itemCount, 2)
        XCTAssertEqual(data?.board.openTaskCount, 1)
        XCTAssertEqual(data?.items.map(\.title), ["meeting", "Open task"])
        XCTAssertEqual(data?.items.map(\.kind), [.event, .task])
    }

    func testBoardWidgetTodayScopeIncludesAnEventSpanningToday() {
        let board = Board.week(id: "week", name: "Week")
        var snapshot = TaskifySnapshot(boards: [board], tasks: [], selectedBoardID: board.id)
        snapshot.taskifyEvents = [
            widgetAllDayEvent(
                id: "conference",
                boardID: board.id,
                startDate: "2026-08-01",
                endDate: "2026-08-03"
            ),
        ]

        let data = snapshot.boardWidgetData(
            boardID: board.id,
            scope: .today,
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(data?.itemCount, 1)
        XCTAssertEqual(data?.items.first?.title, "conference")
        XCTAssertEqual(data?.items.first?.kind, .event)
        XCTAssertTrue(data?.items.first?.isAllDay == true)
    }

    // MARK: - Kinds

    func testTasksAreMarkedAsTasksAndAreCompletable() {
        let data = snapshot([("Standup", at(1), false, false)])
            .widgetData(now: now, calendar: calendar)
        XCTAssertEqual(data.today.first?.kind, .task)
        XCTAssertEqual(data.today.first?.isAllDay, true)
        XCTAssertNil(data.today.first?.endDate)
        XCTAssertTrue(TaskifyWidgetItemKind.task.isCompletable)
    }

    func testCalendarMetadataSurvivesAJSONRoundTrip() throws {
        let start = at(2)
        let end = at(3)
        let event = TaskifyWidgetTask(
            id: "event",
            title: "Team lunch",
            boardID: "",
            boardName: "Calendar",
            dueDate: start,
            endDate: end,
            isAllDay: false,
            kind: .calendar
        )

        let decoded = try JSONDecoder().decode(
            TaskifyWidgetTask.self,
            from: JSONEncoder().encode(event)
        )

        XCTAssertEqual(decoded.endDate, end)
        XCTAssertFalse(decoded.isAllDay)
        XCTAssertEqual(decoded.kind, .calendar)
    }

    /// Only tasks can be ticked off from a widget -- the rest belong to other apps.
    func testOnlyTasksAreCompletable() {
        for kind in [TaskifyWidgetItemKind.event, .calendar, .reminder] {
            XCTAssertFalse(kind.isCompletable, "\(kind)")
        }
    }

    func testEveryKindHasADistinctGlyph() {
        let symbols = [TaskifyWidgetItemKind.task, .event, .calendar, .reminder].map(\.symbolName)
        XCTAssertEqual(Set(symbols).count, symbols.count)
    }

    func testSurvivesAJSONRoundTrip() throws {
        let data = snapshot([("Standup", at(1), false, false)])
            .widgetData(now: now, calendar: calendar)
        let decoded = try JSONDecoder().decode(
            TaskifyWidgetData.self,
            from: JSONEncoder().encode(data)
        )
        XCTAssertEqual(decoded, data)
    }
}

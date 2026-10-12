import Foundation
import Testing
@testable import TaskifyCore

private let fixedNow = Date(timeIntervalSince1970: 1_760_000_000) // 2025-10-09, a Thursday

private func listAndWeekSnapshot(listTaskDue: Date?) -> TaskifySnapshot {
    let list = Board(
        id: "list-board", name: "Errands", kind: .list,
        columns: [BoardColumn(id: "todo", name: "To do", order: 0)]
    )
    let week = Board.week()
    return TaskifySnapshot(
        boards: [week, list],
        tasks: [
            TaskItem(
                id: "task", boardID: list.id, title: "Renew passport",
                dueDate: listTaskDue, dueDateEnabled: listTaskDue != nil, columnID: "todo"
            ),
        ],
        selectedBoardID: list.id
    )
}

@Test func movingAListTaskOntoAWeekDayLandsInTheCurrentWeek() throws {
    // Due far out on the list board; on the week board it belongs to the chosen day this week.
    var snapshot = listAndWeekSnapshot(listTaskDue: fixedNow.addingTimeInterval(90 * 86_400))
    let result = snapshot.moveTask(
        taskID: "task",
        toBoardID: "week-default",
        columnID: WeekdayColumn.monday.rawValue,
        now: fixedNow
    )
    let move = try #require(result)
    #expect(move.crossedBoards)
    let moved = try #require(snapshot.tasks.first { $0.id == "task" })
    #expect(moved.boardID == "week-default")
    #expect(moved.columnID == WeekdayColumn.monday.rawValue)
    #expect(moved.dueDateEnabled)
    #expect(moved.dueDate == WeekDateResolver.date(for: .monday, inWeekContaining: fixedNow))
}

@Test func movingAnUndatedListTaskOntoAWeekDayGivesItThatDate() throws {
    var snapshot = listAndWeekSnapshot(listTaskDue: nil)
    let result = snapshot.moveTask(
        taskID: "task",
        toBoardID: "week-default",
        columnID: WeekdayColumn.friday.rawValue,
        now: fixedNow
    )
    #expect(result != nil)
    let moved = try #require(snapshot.tasks.first { $0.id == "task" })
    #expect(moved.dueDate == WeekDateResolver.date(for: .friday, inWeekContaining: fixedNow))
}

@Test func movingOntoAWeekBoardStillRejectsANonDayColumn() {
    var snapshot = listAndWeekSnapshot(listTaskDue: nil)
    let result = snapshot.moveTask(taskID: "task", toBoardID: "week-default", columnID: "todo", now: fixedNow)
    #expect(result == nil)
    #expect(snapshot.tasks.first { $0.id == "task" }?.boardID == "list-board")
}

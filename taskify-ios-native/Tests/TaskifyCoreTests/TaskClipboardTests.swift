import Foundation
import Testing
@testable import TaskifyCore

private let clipboardNow = Date(timeIntervalSince1970: 1_760_000_000) // 2025-10-09, a Thursday

private func boards() -> TaskifySnapshot {
    TaskifySnapshot(
        boards: [
            Board.week(),
            Board(id: "list", name: "Errands", kind: .list, columns: [BoardColumn(id: "todo", name: "To do", order: 0)]),
        ],
        tasks: [],
        selectedBoardID: "list"
    )
}

@Test func copiedTaskRoundTripsThroughTheClipboard() throws {
    let due = Date(timeIntervalSince1970: 1_765_000_000)
    let task = TaskItem(
        id: "source", boardID: "list", title: "Renew passport", note: "Bring **photos**",
        dueDate: due, dueDateEnabled: true, priority: .high,
        subtasks: [TaskSubtask(id: "s1", title: "Forms", completed: true)], columnID: "todo"
    )
    let text = try #require(TaskClipboard.string(for: task))
    #expect(!text.contains("\"relays\""))
    let pasted = try #require(TaskClipboard.tasks(in: text)?.first)
    #expect(pasted.title == "Renew passport")
    #expect(pasted.note == "Bring **photos**")
    #expect(pasted.priority == 3)
    #expect(pasted.dueDate == due)
    #expect(pasted.subtasks?.map(\.title) == ["Forms"])
}

@Test func pastingThePWAsCopyTaskJSONKeepsWhatDecodes() throws {
    // The PWA copies its whole task object: ids, board fields, and keys iOS doesn't model.
    let pwa = """
    {"id":"abc","boardId":"b1","order":3,"title":"Call the bank","note":"Ask about fees",
     "dueISO":"2025-10-20T15:00:00.000Z","dueDateEnabled":true,"dueTimeEnabled":true,
     "dueTimeZone":"America/Chicago","priority":2,"completed":false,"createdAt":1760000000000,
     "subtasks":[{"id":"x","title":"Account number","completed":false}],
     "reminders":{"unexpected":"shape"},"bounty":null}
    """
    let pasted = try #require(TaskClipboard.tasks(in: pwa)?.first)
    #expect(pasted.title == "Call the bank")
    #expect(pasted.note == "Ask about fees")
    #expect(pasted.priority == 2)
    #expect(pasted.dueTimeEnabled == true)
    #expect(pasted.subtasks?.map(\.title) == ["Account number"])
    #expect(pasted.reminders == nil)
}

@Test func ordinaryTitlesAreNotTreatedAsPastedTasks() {
    #expect(TaskClipboard.tasks(in: "Buy milk") == nil)
    #expect(TaskClipboard.tasks(in: "{not json}") == nil)
    #expect(TaskClipboard.tasks(in: "{\"note\":\"no title\"}") == nil)
    #expect(TaskClipboard.tasks(in: "[]") == nil)
}

@Test func pastingOntoAWeekDayUsesThatDayAndKeepsTheTime() throws {
    var snapshot = boards()
    let delivery = try #require(TaskClipboard.tasks(in: """
    {"title":"Standup","dueISO":"2025-12-01T14:30:00.000Z","dueDateEnabled":true,"dueTimeEnabled":true,"dueTimeZone":"UTC",
     "subtasks":[{"id":"x","title":"Notes","completed":true}]}
    """)?.first)
    let added = snapshot.addPastedTask(
        delivery, boardID: "week-default", columnID: WeekdayColumn.tuesday.rawValue, now: clipboardNow
    )
    let pasted = try #require(added)
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let tuesday = WeekDateResolver.date(for: .tuesday, inWeekContaining: clipboardNow, calendar: utc)
    #expect(pasted.columnID == WeekdayColumn.tuesday.rawValue)
    #expect(pasted.dueDate == utc.date(bySettingHour: 14, minute: 30, second: 0, of: tuesday))
    #expect(pasted.dueTimeEnabled)
    #expect(pasted.subtasks?.first?.completed == true)
    #expect(pasted.subtasks?.first?.id != "x")
}

@Test func pastingIntoAListKeepsTheTasksOwnDate() throws {
    var snapshot = boards()
    let delivery = SharedTaskDelivery(title: "Undated", dueDateEnabled: false)
    let added = snapshot.addPastedTask(delivery, boardID: "list", columnID: "todo", now: clipboardNow)
    let pasted = try #require(added)
    #expect(!pasted.dueDateEnabled)
    #expect(pasted.dueDate == nil)
    #expect(pasted.columnID == "todo")
}

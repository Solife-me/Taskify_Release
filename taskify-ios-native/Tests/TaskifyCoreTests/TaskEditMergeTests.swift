import XCTest
@testable import TaskifyCore

/// C8-2: saving the task editor applies only what the user changed, so a change that arrived
/// while the editor was open (another device, the widget, Siri) is not reverted.
final class TaskEditMergeTests: XCTestCase {
    private func task() -> TaskItem {
        var task = TaskItem(id: "t1", boardID: "b1", title: "Pack for the trip")
        task.note = "Passport first"
        task.subtasks = [
            TaskSubtask(id: "s1", title: "Passport"),
            TaskSubtask(id: "s2", title: "Charger"),
        ]
        return task
    }

    func testASubtaskTickedElsewhereSurvivesSavingAPriorityChange() {
        let opened = TaskEditorFields(task: task())
        var edited = opened
        edited.priority = .high
        var current = task()
        current.subtasks?[0].completed = true // ticked on another device meanwhile

        let merged = TaskEditorFields.merging(opened: opened, edited: edited, current: TaskEditorFields(task: current))
        XCTAssertEqual(merged.priority, .high)
        XCTAssertEqual(merged.subtasks.map(\.completed), [true, false])
    }

    func testSubtasksMergeItemByItem() {
        let opened = TaskEditorFields(task: task())
        var edited = opened
        edited.subtasks.append(TaskSubtask(id: "s3", title: "Snacks")) // added here
        edited.subtasks.removeAll { $0.id == "s2" } // removed here
        var current = task()
        current.subtasks?[0].completed = true // ticked elsewhere
        current.subtasks?.append(TaskSubtask(id: "s4", title: "Umbrella")) // added elsewhere

        let merged = TaskEditorFields.merging(opened: opened, edited: edited, current: TaskEditorFields(task: current))
        XCTAssertEqual(merged.subtasks.map(\.id), ["s1", "s3", "s4"])
        XCTAssertEqual(merged.subtasks.first?.completed, true)
    }

    func testAFieldChangedHereWinsOverTheSameFieldChangedElsewhere() {
        let opened = TaskEditorFields(task: task())
        var edited = opened
        edited.note = "Passport and visa"
        var current = task()
        current.note = "Passport, tickets"
        current.title = "Pack for Lisbon"

        let merged = TaskEditorFields.merging(opened: opened, edited: edited, current: TaskEditorFields(task: current))
        XCTAssertEqual(merged.note, "Passport and visa")
        XCTAssertEqual(merged.title, "Pack for Lisbon", "untouched here, so the newer title stays")
    }

    func testTheScheduleMovesAsOneGroup() {
        let opened = TaskEditorFields(task: task())
        var edited = opened
        edited.schedule.dueDate = Date(timeIntervalSince1970: 1_792_000_000)
        edited.schedule.dueDateEnabled = true
        var current = task()
        current.dueTimeZone = "Europe/Lisbon"

        let merged = TaskEditorFields.merging(opened: opened, edited: edited, current: TaskEditorFields(task: current))
        XCTAssertEqual(merged.schedule, edited.schedule, "a date with another device's time zone would be a time nobody chose")
    }
}

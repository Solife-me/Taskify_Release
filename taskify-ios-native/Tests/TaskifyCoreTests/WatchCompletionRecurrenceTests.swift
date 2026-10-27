import Foundation
import XCTest
@testable import TaskifyCore

/// C10-2: away from the iPhone, the Watch publishes a completion without the next occurrence. When
/// its command reaches the iPhone, the task is already completed; the series must still continue.
final class WatchCompletionRecurrenceTests: XCTestCase {
    private func completedByWatch() -> TaskifySnapshot {
        var task = TaskItem(
            id: "standup", boardID: "week-default", title: "Standup",
            dueDate: Date(timeIntervalSince1970: 1_790_000_000),
            dueDateEnabled: true, recurrence: .daily()
        )
        // What the Watch's relay event carries: completed, and nothing else.
        task.completed = true
        task.completedAt = Date(timeIntervalSince1970: 1_790_000_100)
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [task]
        return snapshot
    }

    func testTheWatchsCompletionGetsExactlyOneNextOccurrence() throws {
        var snapshot = completedByWatch()
        let next = try XCTUnwrap(snapshot.ensureNextRecurrence(afterCompleted: "standup"))
        XCTAssertFalse(next.completed)
        XCTAssertEqual(snapshot.tasks.filter { !$0.completed }.count, 1)

        // The command can be replayed, and another device may have created the same occurrence.
        XCTAssertNil(snapshot.ensureNextRecurrence(afterCompleted: "standup"))
        XCTAssertEqual(snapshot.tasks.count, 2)
    }

    func testTheOccurrenceMatchesAnInAppCompletion() throws {
        var inApp = completedByWatch()
        inApp.tasks[0].completed = false
        inApp.tasks[0].completedAt = nil
        XCTAssertTrue(inApp.toggleCompletion(taskID: "standup", streaksEnabled: false))
        var watch = completedByWatch()
        let next = try XCTUnwrap(watch.ensureNextRecurrence(afterCompleted: "standup"))
        XCTAssertEqual(next.id, inApp.tasks.first { !$0.completed }?.id)
        XCTAssertEqual(next.dueDate, inApp.tasks.first { !$0.completed }?.dueDate)
    }

    func testADeletedNextOccurrenceStaysDeleted() throws {
        var snapshot = completedByWatch()
        let next = try XCTUnwrap(snapshot.ensureNextRecurrence(afterCompleted: "standup"))
        XCTAssertTrue(snapshot.deleteTask(taskID: next.id))
        XCTAssertNil(snapshot.ensureNextRecurrence(afterCompleted: "standup"))
        XCTAssertEqual(snapshot.tasks.filter { !$0.isDeleted && !$0.completed }.count, 0)
    }

    func testAnOpenOrOneOffTaskGetsNothing() {
        var snapshot = completedByWatch()
        snapshot.tasks[0].completed = false
        XCTAssertNil(snapshot.ensureNextRecurrence(afterCompleted: "standup"))
        snapshot = completedByWatch()
        snapshot.tasks[0].recurrence = nil
        XCTAssertNil(snapshot.ensureNextRecurrence(afterCompleted: "standup"))
    }
}

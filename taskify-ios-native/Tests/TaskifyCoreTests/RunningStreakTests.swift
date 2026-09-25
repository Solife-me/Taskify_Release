import Foundation
import XCTest
@testable import TaskifyCore

/// An open instance of a recurring series carries the streak it had when it was generated, which
/// is stale in full-week mode. Its running streak comes from the latest completed earlier
/// instance, matching the PWA's `buildRunningStreakLookup`.
final class RunningStreakTests: XCTestCase {
    private func instance(_ id: String, day: Int, completed: Bool, streak: Int?) -> TaskItem {
        var task = TaskItem(
            id: id, boardID: "week-default", title: "Daily",
            dueDate: Date(timeIntervalSince1970: TimeInterval(1_790_000_000 + day * 86_400)),
            dueDateEnabled: true, recurrence: .daily(), seriesID: "s"
        )
        task.completed = completed
        task.streak = streak
        return task
    }

    func testOpenInstanceShowsTheSeriesRunningStreak() {
        let tasks = [
            instance("mon", day: 1, completed: true, streak: 5),
            instance("sun", day: 0, completed: true, streak: 4),
            instance("tue", day: 2, completed: false, streak: 2),
        ]
        let running = TaskifySnapshot.runningStreakLookup(tasks)
        XCTAssertEqual(running(tasks[2]), 5)
        XCTAssertEqual(running(tasks[0]), 5)
    }

    func testCompletingAPregeneratedInstanceContinuesTheStreak() {
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [
            instance("mon", day: 1, completed: true, streak: 5),
            instance("tue", day: 2, completed: false, streak: 2),
        ]
        XCTAssertTrue(snapshot.toggleCompletion(taskID: "tue", streaksEnabled: true))
        XCTAssertEqual(snapshot.tasks.first { $0.id == "tue" }?.streak, 6)
    }
}

import Foundation
import XCTest
@testable import TaskifyCore

/// C10-7: Spotlight finds open tasks, and each update sends only what changed.
final class SpotlightIndexTests: XCTestCase {
    private func snapshot() -> TaskifySnapshot {
        var snapshot = TaskifySnapshot.empty
        var archived = Board.week(id: "archived", name: "Old week")
        archived.archived = true
        snapshot.boards.append(archived)
        let board = snapshot.boards[0].id
        var done = TaskItem(id: "done", boardID: board, title: "Done already")
        done.completed = true
        var deleted = TaskItem(id: "deleted", boardID: board, title: "Deleted")
        deleted.deleted = true
        snapshot.tasks = [
            TaskItem(id: "milk", boardID: board, title: "Buy milk"),
            TaskItem(id: "dentist", boardID: board, title: "Call the dentist",
                     dueDate: Date(timeIntervalSince1970: 1_790_000_000), dueDateEnabled: true),
            done, deleted,
            TaskItem(id: "old", boardID: archived.id, title: "On an archived board"),
        ]
        return snapshot
    }

    func testOnlyOpenTasksOnLiveBoardsAreIndexed() {
        let items = TaskifySpotlightIndex.items(in: snapshot())
        XCTAssertEqual(items.map(\.id), ["milk", "dentist"])
        XCTAssertEqual(items[0].boardName, snapshot().boards[0].name)
        XCTAssertNil(items[0].dueDate)
        XCTAssertNotNil(items[1].dueDate)
    }

    func testUpdatesSendOnlyWhatChanged() {
        var tasks = snapshot()
        let first = TaskifySpotlightIndex.changes(from: [:], to: TaskifySpotlightIndex.items(in: tasks))
        XCTAssertEqual(first.upserts.map(\.id), ["milk", "dentist"])
        XCTAssertEqual(first.removals, [])

        let unchanged = TaskifySpotlightIndex.changes(from: first.fingerprints, to: TaskifySpotlightIndex.items(in: tasks))
        XCTAssertEqual(unchanged.upserts, [])
        XCTAssertEqual(unchanged.removals, [])

        tasks.tasks[0].title = "Buy oat milk"
        tasks.tasks[1].completed = true
        let next = TaskifySpotlightIndex.changes(from: first.fingerprints, to: TaskifySpotlightIndex.items(in: tasks))
        XCTAssertEqual(next.upserts.map(\.title), ["Buy oat milk"])
        XCTAssertEqual(next.removals, ["dentist"])
        XCTAssertEqual(Set(next.fingerprints.keys), ["milk"])
    }
}

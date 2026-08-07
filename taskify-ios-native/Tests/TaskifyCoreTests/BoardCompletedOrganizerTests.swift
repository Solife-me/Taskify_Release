import Foundation
import XCTest
@testable import TaskifyCore

final class BoardCompletedOrganizerTests: XCTestCase {
    func testFiltersToCompletedTasksInBoardScopeAndSortsNewestFirst() {
        let old = task(id: "old", boardID: "board", completedAt: Date(timeIntervalSince1970: 100))
        let newest = task(id: "newest", boardID: "child", completedAt: Date(timeIntervalSince1970: 300))
        let middle = task(id: "middle", boardID: "board", completedAt: Date(timeIntervalSince1970: 200))
        let incomplete = task(id: "incomplete", boardID: "board", completedAt: nil, completed: false)
        let deleted = task(id: "deleted", boardID: "board", completedAt: Date(timeIntervalSince1970: 400), deleted: true)
        let other = task(id: "other", boardID: "other", completedAt: Date(timeIntervalSince1970: 500))

        XCTAssertEqual(
            BoardCompletedOrganizer.tasks(
                [old, incomplete, other, newest, deleted, middle],
                includedBoardIDs: ["board", "child"]
            ).map(\.id),
            ["newest", "middle", "old"]
        )
    }

    func testTasksWithoutCompletionTimestampUseCreationDateAsDeterministicFallback() {
        let newer = task(
            id: "newer",
            boardID: "board",
            completedAt: nil,
            createdAt: Date(timeIntervalSince1970: 200)
        )
        let older = task(
            id: "older",
            boardID: "board",
            completedAt: nil,
            createdAt: Date(timeIntervalSince1970: 100)
        )

        XCTAssertEqual(
            BoardCompletedOrganizer.tasks(
                [older, newer],
                includedBoardIDs: ["board"]
            ).map(\.id),
            ["newer", "older"]
        )
    }

    private func task(
        id: String,
        boardID: String,
        completedAt: Date?,
        completed: Bool = true,
        deleted: Bool = false,
        createdAt: Date = Date(timeIntervalSince1970: 0)
    ) -> TaskItem {
        TaskItem(
            id: id,
            boardID: boardID,
            title: id,
            createdAt: createdAt,
            completed: completed,
            completedAt: completedAt,
            deleted: deleted
        )
    }
}

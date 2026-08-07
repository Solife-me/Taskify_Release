import Foundation

/// Produces the board-scoped Completed timeline used when the PWA-style completed tab is enabled.
/// Compound callers include their child board IDs in `includedBoardIDs` so linked tasks appear in
/// the same view.
public enum BoardCompletedOrganizer {
    public static func tasks(
        _ tasks: [TaskItem],
        includedBoardIDs: Set<String>
    ) -> [TaskItem] {
        tasks.filter { task in
            includedBoardIDs.contains(task.boardID) &&
                !task.isDeleted &&
                task.completed
        }
        .sorted(by: completedSort)
    }

    private static func completedSort(_ lhs: TaskItem, _ rhs: TaskItem) -> Bool {
        switch (lhs.completedAt, rhs.completedAt) {
        case let (lhsDate?, rhsDate?) where lhsDate != rhsDate:
            return lhsDate > rhsDate
        case (.some, .none):
            return true
        case (.none, .some):
            return false
        default:
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
            return lhs.id < rhs.id
        }
    }
}

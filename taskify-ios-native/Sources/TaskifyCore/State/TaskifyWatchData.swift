import Foundation
import TaskifyWatchShared

public extension TaskifySnapshot {
    /// Produces the deliberately compact, non-secret state cached by the Watch app.
    /// Completed, deleted, hidden, archived, and not-yet-revealed tasks are excluded so the
    /// transfer remains useful on a constrained device even for large accounts.
    func watchData(
        now: Date = Date(),
        calendar: Calendar = .current,
        taskLimit: Int = 500
    ) -> TaskifyWatchSnapshot {
        // Board array position is the user's local board order on iPhone. Preserve it exactly on
        // Watch rather than reconstructing a creation-date order that diverges after reordering.
        let visibleBoards = boards
            .filter { $0.isVisible && $0.kind != .bible }
        let boardByID = Dictionary(uniqueKeysWithValues: visibleBoards.map { ($0.id, $0) })

        let eligibleTasks = tasks.filter { task in
            guard boardByID[task.boardID] != nil,
                  !task.completed,
                  !task.isDeleted else { return false }
            if let hiddenUntilDate = task.hiddenUntilDate, hiddenUntilDate > now { return false }
            return true
        }
        let sortedTasks = eligibleTasks.sorted { lhs, rhs in
            switch (lhs.dueDateEnabled ? lhs.dueDate : nil, rhs.dueDateEnabled ? rhs.dueDate : nil) {
            case let (left?, right?) where left != right:
                return left < right
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            default:
                if lhs.order != rhs.order { return lhs.order < rhs.order }
                if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
                return lhs.id < rhs.id
            }
        }
        let boundedTasks = Array(sortedTasks.prefix(max(0, taskLimit)))

        let watchTasks = boundedTasks.compactMap { task -> TaskifyWatchTask? in
            guard let board = boardByID[task.boardID] else { return nil }
            return TaskifyWatchTask(
                id: task.id,
                title: task.title,
                boardID: board.id,
                boardName: board.name,
                columnName: board.columns.first(where: { $0.id == task.columnID })?.name,
                dueDate: task.dueDateEnabled ? task.dueDate : nil,
                dueTimeEnabled: task.dueTimeEnabled,
                priority: task.priority?.rawValue,
                order: task.order
            )
        }
        let watchBoards = visibleBoards.map { board in
            TaskifyWatchBoard(
                id: board.id,
                name: board.name,
                openTaskCount: eligibleTasks.lazy.filter { $0.boardID == board.id }.count
            )
        }

        return TaskifyWatchSnapshot(
            tasks: watchTasks,
            boards: watchBoards,
            selectedBoardID: boardByID[selectedBoardID] == nil ? visibleBoards.first?.id : selectedBoardID,
            generatedAt: now
        )
    }
}

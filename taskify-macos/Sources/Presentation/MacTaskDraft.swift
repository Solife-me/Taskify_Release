import Foundation
import TaskifyCore

/// UI draft placement only; date arithmetic and saved mutations remain in TaskifyCore.
public enum MacTaskDraft {
    public static func place(_ task: TaskItem, on board: Board, now: Date = Date(),
                             weekStartsOn: WeekdayColumn, calendar: Calendar = .current) -> TaskItem {
        var draft = task
        draft.boardID = board.id
        if board.kind == .week {
            let day = WeekdayColumn.containing(now, calendar: calendar)
            draft.columnID = day.rawValue
            draft.dueDateEnabled = true
            draft.dueDate = WeekDateResolver.date(for: day, inWeekContaining: now, weekStartsOn: weekStartsOn, calendar: calendar)
        } else {
            draft.columnID = board.columns.sorted { $0.order < $1.order }.first?.id
        }
        return draft
    }
}

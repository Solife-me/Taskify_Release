import Foundation

public struct BoardTaskColumnKey: Hashable, Sendable {
    public let boardID: String
    public let columnID: String

    public init(boardID: String, columnID: String) {
        self.boardID = boardID
        self.columnID = columnID
    }
}

/// Builds the board-column task index used by the native board pager.
///
/// Apart from avoiding one full task-array scan per visible column, this is also the final
/// visibility guard for old or imported week-board payloads that omitted `hiddenUntilISO`.
/// Upcoming intentionally does not use this organizer, so future tasks remain available there.
public enum BoardTaskOrganizer {
    public static func groupedTasks(
        _ tasks: [TaskItem],
        boards: [Board],
        includedBoardIDs: Set<String>? = nil,
        includeCompleted: Bool,
        weekStartsOn: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [BoardTaskColumnKey: [TaskItem]] {
        let scopedBoards = includedBoardIDs.map { included in
            boards.filter { included.contains($0.id) }
        } ?? boards
        let boardKinds = Dictionary(
            scopedBoards.map { ($0.id, $0.kind) },
            uniquingKeysWith: { _, newest in newest }
        )
        var result: [BoardTaskColumnKey: [TaskItem]] = [:]
        result.reserveCapacity(scopedBoards.reduce(0) { $0 + $1.columns.count })

        for task in tasks {
            guard boardKinds[task.boardID] != nil,
                  let columnID = task.columnID,
                  isVisibleOnBoard(
                      task,
                      boardKind: boardKinds[task.boardID],
                      includeCompleted: includeCompleted,
                      weekStartsOn: weekStartsOn,
                      now: now,
                      calendar: calendar
                  ) else { continue }
            result[BoardTaskColumnKey(boardID: task.boardID, columnID: columnID), default: []]
                .append(task)
        }

        for key in Array(result.keys) {
            result[key]?.sort(by: boardOrder)
        }
        return result
    }

    public static func tasks(
        _ tasks: [TaskItem],
        boardID: String,
        columnID: String,
        boardKind: BoardKind?,
        includeCompleted: Bool,
        weekStartsOn: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskItem] {
        tasks
            .filter {
                $0.boardID == boardID &&
                    $0.columnID == columnID &&
                    isVisibleOnBoard(
                        $0,
                        boardKind: boardKind,
                        includeCompleted: includeCompleted,
                        weekStartsOn: weekStartsOn,
                        now: now,
                        calendar: calendar
                    )
            }
            .sorted(by: boardOrder)
    }

    private static func isVisibleOnBoard(
        _ task: TaskItem,
        boardKind: BoardKind?,
        includeCompleted: Bool,
        weekStartsOn: WeekdayColumn,
        now: Date,
        calendar: Calendar
    ) -> Bool {
        guard !task.isDeleted, includeCompleted || !task.completed else { return false }
        if let hiddenUntilDate = task.hiddenUntilDate, hiddenUntilDate > now { return false }
        guard boardKind == .week,
              task.dueDateEnabled,
              let dueDate = task.dueDate else { return true }

        var dueCalendar = calendar
        if task.dueTimeEnabled,
           let dueTimeZone = task.dueTimeZone,
           let timeZone = TimeZone(identifier: dueTimeZone) {
            dueCalendar.timeZone = timeZone
        }
        let currentWeekStart = WeekDateResolver.startOfWeek(
            containing: now,
            startingOn: weekStartsOn,
            calendar: dueCalendar
        )
        let dueWeekStart = WeekDateResolver.startOfWeek(
            containing: dueDate,
            startingOn: weekStartsOn,
            calendar: dueCalendar
        )
        return dueWeekStart <= currentWeekStart
    }

    private static func boardOrder(_ lhs: TaskItem, _ rhs: TaskItem) -> Bool {
        if lhs.completed != rhs.completed { return !lhs.completed }
        if lhs.order != rhs.order { return lhs.order < rhs.order }
        return lhs.createdAt < rhs.createdAt
    }
}

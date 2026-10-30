import Foundation
import TaskifyCore

/// Chooses the week column that should be centered when a Mac week board opens.
public enum MacWeekBoardScroll {
    public static func currentDayColumnID(
        orderedColumnIDs: [String],
        date: Date,
        calendar: Calendar = .current
    ) -> String? {
        guard !orderedColumnIDs.isEmpty else { return nil }
        let today = WeekdayColumn.containing(date, calendar: calendar).rawValue
        return orderedColumnIDs.contains(today) ? today : orderedColumnIDs.first
    }

    public static func scrollID(boardID: String, columnID: String) -> String {
        "week-board-\(boardID)-\(columnID)"
    }
}

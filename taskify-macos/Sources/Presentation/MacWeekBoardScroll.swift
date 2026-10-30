import Foundation
import TaskifyCore

/// An identity for one week-board opening. Changing any component restarts the centering task,
/// even when SwiftUI reuses the same horizontal ScrollView for another week board.
public struct MacWeekBoardScrollRequest: Equatable, Sendable {
    public let boardID: String
    public let columnID: String
    public let orderedColumnIDs: [String]
    public let dayKey: String

    public var targetID: String {
        MacWeekBoardScroll.scrollID(boardID: boardID, columnID: columnID)
    }

    public var requestID: String {
        "\(boardID)|\(columnID)|\(dayKey)|\(orderedColumnIDs.joined(separator: ","))"
    }
}

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

    /// Symmetric gutters let both the first and last weekday columns reach the viewport center.
    public static func horizontalContentPadding(
        viewportWidth: CGFloat,
        columnWidth: CGFloat = 270,
        minimum: CGFloat = 24
    ) -> CGFloat {
        max(minimum, (viewportWidth - columnWidth) / 2)
    }

    public static func request(
        boardID: String,
        orderedColumnIDs: [String],
        date: Date,
        calendar: Calendar = .current
    ) -> MacWeekBoardScrollRequest? {
        guard let columnID = currentDayColumnID(
            orderedColumnIDs: orderedColumnIDs,
            date: date,
            calendar: calendar
        ) else { return nil }
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        let dayKey = [components.year, components.month, components.day]
            .map { $0.map(String.init) ?? "?" }
            .joined(separator: "-")
        return MacWeekBoardScrollRequest(
            boardID: boardID,
            columnID: columnID,
            orderedColumnIDs: orderedColumnIDs,
            dayKey: dayKey
        )
    }
}

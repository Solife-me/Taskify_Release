import Foundation
import TaskifyCore

/// Resolves where a task dragged onto a board should land when no individual column was targeted.
public enum MacBoardDropTarget {
    public static func columnID(
        in board: Board,
        date: Date = Date(),
        calendar: Calendar = .current
    ) -> String? {
        switch board.kind {
        case .week:
            let today = WeekdayColumn.containing(date, calendar: calendar).rawValue
            return board.columns.first(where: { $0.id == today })?.id
                ?? board.columns.sorted(by: columnOrder).first?.id
        case .list:
            return board.columns.sorted(by: columnOrder).first?.id
        case .compound, .bible:
            return nil
        }
    }

    public static func archivedBoardIDs(in values: [String], boards: [Board]) -> [String] {
        let archivedIDs = Set(boards.lazy.filter(\.archived).map(\.id))
        var seen = Set<String>()
        return values.filter { archivedIDs.contains($0) && seen.insert($0).inserted }
    }

    private static func columnOrder(_ lhs: BoardColumn, _ rhs: BoardColumn) -> Bool {
        lhs.order == rhs.order ? lhs.name < rhs.name : lhs.order < rhs.order
    }
}

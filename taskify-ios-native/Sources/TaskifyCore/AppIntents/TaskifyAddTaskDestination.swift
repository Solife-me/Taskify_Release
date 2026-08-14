import Foundation

/// Resolves where a headless "add task" request should land, mirroring the priority order the
/// quick-add bar in `BoardsView` uses when nothing is focused: an explicitly named board (falling
/// through to a compound board's first child list, the same way quick-add does), else the app's
/// currently selected board, else the first addable board at all. Week boards land on today's
/// weekday column; list boards land in the first column by display order. Compound and Bible
/// boards are never a final destination — compound resolves to its first child, and Bible has no
/// quick-add equivalent at all, so it's skipped in favor of any other addable board.
public struct TaskifyAddTaskDestination {
    public let boardID: String
    public let boardName: String
    public let columnID: String?
    public let dueDate: Date?

    /// Boards people can name when adding a task. Compound child lists are intentionally hidden
    /// from the main board picker, but they remain visible as lists inside their parent and are
    /// valid task destinations (for example, “Work Tasks”). Siri therefore needs both top-level
    /// boards and linked child lists, in stable display order, with duplicates removed.
    public static func namedBoards(in snapshot: TaskifySnapshot) -> [Board] {
        var result: [Board] = []
        var seen = Set<String>()

        for board in snapshot.visibleBoards where board.kind != .bible {
            if seen.insert(board.id).inserted {
                result.append(board)
            }
            guard board.kind == .compound else { continue }
            for child in snapshot.compoundChildBoards(for: board.id)
                where seen.insert(child.id).inserted {
                result.append(child)
            }
        }
        return result
    }

    public static func resolve(
        in snapshot: TaskifySnapshot,
        requestedBoardName: String?,
        now: Date = Date()
    ) -> TaskifyAddTaskDestination? {
        let namedBoards = namedBoards(in: snapshot)
        let addable = namedBoards.filter { $0.kind == .week || $0.kind == .list }

        func destination(for board: Board) -> TaskifyAddTaskDestination? {
            switch board.kind {
            case .week:
                let weekday = WeekdayColumn.containing(now)
                return TaskifyAddTaskDestination(
                    boardID: board.id,
                    boardName: board.name,
                    columnID: weekday.rawValue,
                    dueDate: WeekDateResolver.date(for: weekday, inWeekContaining: now)
                )
            case .list:
                let orderedColumns = board.columns.sorted {
                    if $0.order != $1.order { return $0.order < $1.order }
                    return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                }
                guard let column = orderedColumns.first else { return nil }
                return TaskifyAddTaskDestination(
                    boardID: board.id,
                    boardName: board.name,
                    columnID: column.id,
                    dueDate: nil
                )
            case .compound, .bible:
                return nil
            }
        }

        func resolvedDestination(for board: Board) -> TaskifyAddTaskDestination? {
            if let direct = destination(for: board) { return direct }
            guard board.kind == .compound,
                  let child = snapshot.compoundChildBoards(for: board.id).first else { return nil }
            return destination(for: child)
        }

        if let requestedBoardName {
            let needle = requestedBoardName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !needle.isEmpty {
                let matched = namedBoards.first { $0.name.lowercased() == needle }
                    ?? namedBoards.first { $0.name.lowercased().contains(needle) }
                    ?? namedBoards.first { needle.contains($0.name.lowercased()) }
                if let matched, let resolved = resolvedDestination(for: matched) {
                    return resolved
                }
            }
        }

        if let selected = snapshot.selectedBoard, let resolved = resolvedDestination(for: selected) {
            return resolved
        }

        return addable.compactMap(destination(for:)).first
    }
}

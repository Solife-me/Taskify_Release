import Foundation

public enum BoardPageMode: String, Equatable {
    case board
    case boardUpcoming
    case completed
}

public enum BoardPageState: Equatable {
    case loading(String)
    case empty(String)
    case ready
    case error(String)
}

@MainActor
public final class BoardModeViewModel: ObservableObject {
    @Published public private(set) var mode: BoardPageMode = .board

    private var boardItemCount = 0
    private var upcomingItemCount = 0
    private var completedItemCount = 0

    private var modeOverrides: [BoardPageMode: BoardPageState] = [:]

    public init() {}

    public var currentState: BoardPageState {
        if let override = modeOverrides[mode] {
            return override
        }

        switch mode {
        case .board:
            return boardItemCount == 0 ? .empty("No items on this board.") : .ready
        case .boardUpcoming:
            return upcomingItemCount == 0 ? .empty("No upcoming items on this board.") : .ready
        case .completed:
            return completedItemCount == 0 ? .empty("No completed items on this board.") : .ready
        }
    }

    public func setMode(_ next: BoardPageMode) {
        mode = next
    }

    public func setBoardItems(_ items: [String]) {
        setBoardItemCount(items.count)
    }

    public func setBoardItemCount(_ count: Int) {
        boardItemCount = max(0, count)
        clearOverride(for: .board)
    }

    public func setUpcomingItems(_ items: [String]) {
        setUpcomingItemCount(items.count)
    }

    public func setUpcomingItemCount(_ count: Int) {
        upcomingItemCount = max(0, count)
        clearOverride(for: .boardUpcoming)
    }

    public func setCompletedItems(_ items: [String]) {
        setCompletedItemCount(items.count)
    }

    public func setCompletedItemCount(_ count: Int) {
        completedItemCount = max(0, count)
        clearOverride(for: .completed)
    }

    public func setLoading(for mode: BoardPageMode) {
        switch mode {
        case .board:
            modeOverrides[mode] = .loading("Loading board…")
        case .boardUpcoming:
            modeOverrides[mode] = .loading("Loading upcoming…")
        case .completed:
            modeOverrides[mode] = .loading("Loading completed…")
        }
    }

    public func setError(for mode: BoardPageMode, message: String) {
        modeOverrides[mode] = .error(message)
    }

    private func clearOverride(for mode: BoardPageMode) {
        modeOverrides.removeValue(forKey: mode)
    }
}

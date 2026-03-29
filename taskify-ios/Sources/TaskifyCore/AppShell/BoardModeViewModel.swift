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

    private var boardItems: [String] = []
    private var upcomingItems: [String] = []
    private var completedItems: [String] = []

    private var modeOverrides: [BoardPageMode: BoardPageState] = [:]

    public init() {}

    public var currentState: BoardPageState {
        if let override = modeOverrides[mode] {
            return override
        }

        switch mode {
        case .board:
            return boardItems.isEmpty ? .empty("No items on this board.") : .ready
        case .boardUpcoming:
            return upcomingItems.isEmpty ? .empty("No upcoming items on this board.") : .ready
        case .completed:
            return completedItems.isEmpty ? .empty("No completed items on this board.") : .ready
        }
    }

    public func setMode(_ next: BoardPageMode) {
        mode = next
    }

    public func setBoardItems(_ items: [String]) {
        boardItems = items
        clearOverride(for: .board)
    }

    public func setUpcomingItems(_ items: [String]) {
        upcomingItems = items
        clearOverride(for: .boardUpcoming)
    }

    public func setCompletedItems(_ items: [String]) {
        completedItems = items
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

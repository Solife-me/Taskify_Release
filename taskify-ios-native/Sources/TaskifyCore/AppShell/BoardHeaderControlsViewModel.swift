import Foundation

@MainActor
public final class BoardHeaderControlsViewModel: ObservableObject {
    @Published public private(set) var mode: BoardPageMode = .board

    public let completedTabEnabled: Bool
    public let canShareBoard: Bool

    private var onFilterSort: () -> Void
    private var onShareBoard: () -> Void
    private var onClearCompleted: () -> Void

    public init(
        completedTabEnabled: Bool,
        canShareBoard: Bool,
        onFilterSort: @escaping () -> Void = {},
        onShareBoard: @escaping () -> Void = {},
        onClearCompleted: @escaping () -> Void = {}
    ) {
        self.completedTabEnabled = completedTabEnabled
        self.canShareBoard = canShareBoard
        self.onFilterSort = onFilterSort
        self.onShareBoard = onShareBoard
        self.onClearCompleted = onClearCompleted
    }

    public func bind(mode: BoardPageMode) {
        self.mode = mode
    }

    public func setActionHandlers(
        onFilterSort: @escaping () -> Void,
        onShareBoard: @escaping () -> Void,
        onClearCompleted: @escaping () -> Void
    ) {
        self.onFilterSort = onFilterSort
        self.onShareBoard = onShareBoard
        self.onClearCompleted = onClearCompleted
    }

    public func primaryCompletedAction() {
        if completedTabEnabled {
            toggleCompletedMode()
        } else {
            onClearCompleted()
        }
    }

    public func toggleCompletedMode() {
        mode = (mode == .completed) ? .board : .completed
    }

    public func toggleBoardUpcomingMode() {
        mode = (mode == .boardUpcoming) ? .board : .boardUpcoming
    }

    public func openFilterSort() {
        onFilterSort()
    }

    public func openShareBoard() {
        guard canShareBoard else { return }
        onShareBoard()
    }
}

import Foundation

public struct BoardTaskItem: Equatable, Identifiable {
    public let id: String
    public let title: String
    public let completed: Bool

    public init(id: String, title: String, completed: Bool) {
        self.id = id
        self.title = title
        self.completed = completed
    }
}

public enum BoardDetailState: Equatable {
    case loading
    case empty
    case ready
    case error(String)
}

@MainActor
public final class BoardDetailViewModel: ObservableObject {
    @Published public private(set) var state: BoardDetailState = .empty
    @Published public private(set) var selectedBoardId: String?
    @Published public private(set) var visibleTasks: [BoardTaskItem] = []

    private var tasksByBoard: [String: [BoardTaskItem]] = [:]

    public init() {}

    public func setSelectedBoard(id: String?) {
        selectedBoardId = id
        guard let id else {
            visibleTasks = []
            state = .empty
            return
        }
        let tasks = tasksByBoard[id] ?? []
        visibleTasks = tasks
        state = tasks.isEmpty ? .empty : .ready
    }

    public func setTasks(for boardId: String, tasks: [BoardTaskItem]) {
        tasksByBoard[boardId] = tasks
        guard boardId == selectedBoardId else { return }
        visibleTasks = tasks
        state = tasks.isEmpty ? .empty : .ready
    }

    public func setLoading() {
        state = .loading
    }

    public func setError(_ message: String) {
        state = .error(message)
    }

    public var emptyMessage: String {
        "No tasks yet for this board."
    }
}

@MainActor
public enum BoardDetailFixture {
    public static func empty(boardId: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setTasks(for: boardId, tasks: [])
        return vm
    }

    public static func loading(boardId: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setLoading()
        return vm
    }

    public static func error(boardId: String, message: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setError(message)
        return vm
    }

    public static func sample(boardId: String) -> BoardDetailViewModel {
        let vm = BoardDetailViewModel()
        vm.setSelectedBoard(id: boardId)
        vm.setTasks(for: boardId, tasks: [
            .init(id: "t1", title: "Draft roadmap", completed: false),
            .init(id: "t2", title: "Review PRs", completed: false),
            .init(id: "t3", title: "Ship TestFlight build", completed: true),
        ])
        return vm
    }
}

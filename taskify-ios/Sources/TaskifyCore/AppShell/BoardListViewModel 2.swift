import Foundation

public enum BoardListState: Equatable {
    case loading
    case empty
    case ready
    case error(String)
}

@MainActor
public final class BoardListViewModel: ObservableObject {
    @Published public private(set) var state: BoardListState = .loading
    @Published public private(set) var visibleBoards: [ProfileBoardEntry] = []
    @Published public private(set) var selectedBoardId: String?

    public init() {}

    public func setLoading() {
        state = .loading
    }

    public func setBoards(_ boards: [ProfileBoardEntry]) {
        visibleBoards = boards.sorted { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
        if visibleBoards.isEmpty {
            state = .empty
            selectedBoardId = nil
        } else {
            state = .ready
            if selectedBoardId == nil || !visibleBoards.contains(where: { $0.id == selectedBoardId }) {
                selectedBoardId = visibleBoards.first?.id
            }
        }
    }

    public func selectBoard(id: String) {
        guard visibleBoards.contains(where: { $0.id == id }) else { return }
        selectedBoardId = id
    }

    public func setError(_ message: String) {
        state = .error(message)
    }
}

@MainActor
public enum BoardListFixture {
    public static func empty() -> BoardListViewModel {
        let vm = BoardListViewModel()
        vm.setBoards([])
        return vm
    }

    public static func loading() -> BoardListViewModel {
        let vm = BoardListViewModel()
        vm.setLoading()
        return vm
    }

    public static func error(_ message: String) -> BoardListViewModel {
        let vm = BoardListViewModel()
        vm.setError(message)
        return vm
    }

    public static func sample() -> BoardListViewModel {
        let vm = BoardListViewModel()
        vm.setBoards([
            .init(id: "b3", name: "Work"),
            .init(id: "b1", name: "Inbox"),
            .init(id: "b2", name: "Personal")
        ])
        return vm
    }
}

import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("BoardListViewModel")
struct BoardListViewModelTests {

    @Test("boards are sorted alphabetically case-insensitive")
    func sorting() {
        let vm = BoardListViewModel()
        vm.setBoards([
            ProfileBoardEntry(id: "2", name: "work"),
            ProfileBoardEntry(id: "1", name: "Alpha"),
            ProfileBoardEntry(id: "3", name: "beta")
        ])
        #expect(vm.visibleBoards.map(\.name) == ["Alpha", "beta", "work"])
    }

    @Test("select board sets selectedBoardId")
    func selectBoard() {
        let vm = BoardListViewModel()
        vm.setBoards([ProfileBoardEntry(id: "b1", name: "Personal")])
        vm.selectBoard(id: "b1")
        #expect(vm.selectedBoardId == "b1")
    }

    @Test("defaults to empty state when no boards")
    func emptyState() {
        let vm = BoardListViewModel()
        vm.setBoards([])
        #expect(vm.state == .empty)
    }

    @Test("can represent loading state")
    func loadingState() {
        let vm = BoardListViewModel()
        vm.setLoading()
        #expect(vm.state == .loading)
    }

    @Test("can represent error state")
    func errorState() {
        let vm = BoardListViewModel()
        vm.setError("Failed to load boards")
        #expect(vm.state == .error("Failed to load boards"))
    }

    @Test("fixtures create deterministic states")
    func fixtures() {
        #expect(BoardListFixture.empty().state == .empty)
        #expect(BoardListFixture.loading().state == .loading)
        #expect(BoardListFixture.error("x").state == .error("x"))
        #expect(BoardListFixture.sample().visibleBoards.count == 3)
    }
}

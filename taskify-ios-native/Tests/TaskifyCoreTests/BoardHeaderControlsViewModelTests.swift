import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("BoardHeaderControlsViewModel")
struct BoardHeaderControlsViewModelTests {

    @Test("completed toggle mirrors PWA semantics")
    func completedToggle() {
        let vm = BoardHeaderControlsViewModel(completedTabEnabled: true, canShareBoard: true)
        #expect(vm.mode == .board)

        vm.toggleCompletedMode()
        #expect(vm.mode == .completed)

        vm.toggleCompletedMode()
        #expect(vm.mode == .board)
    }

    @Test("board-upcoming toggle mirrors PWA semantics")
    func boardUpcomingToggle() {
        let vm = BoardHeaderControlsViewModel(completedTabEnabled: true, canShareBoard: true)
        vm.toggleBoardUpcomingMode()
        #expect(vm.mode == .boardUpcoming)

        vm.toggleBoardUpcomingMode()
        #expect(vm.mode == .board)
    }

    @Test("filter-sort and share action entry points fire")
    func actionEntryPoints() {
        var filterSortCalls = 0
        var shareCalls = 0

        let vm = BoardHeaderControlsViewModel(
            completedTabEnabled: true,
            canShareBoard: true,
            onFilterSort: { filterSortCalls += 1 },
            onShareBoard: { shareCalls += 1 }
        )

        vm.openFilterSort()
        vm.openShareBoard()

        #expect(filterSortCalls == 1)
        #expect(shareCalls == 1)
    }

    @Test("clear completed path used when completedTab disabled")
    func clearCompletedPath() {
        var clearCalls = 0
        let vm = BoardHeaderControlsViewModel(
            completedTabEnabled: false,
            canShareBoard: true,
            onClearCompleted: { clearCalls += 1 }
        )

        vm.primaryCompletedAction()
        #expect(clearCalls == 1)
        #expect(vm.mode == .board)
    }
}

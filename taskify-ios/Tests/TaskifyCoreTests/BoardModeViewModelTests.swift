import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("BoardModeViewModel")
struct BoardModeViewModelTests {

    @Test("defaults to board mode")
    func defaultMode() {
        let vm = BoardModeViewModel()
        #expect(vm.mode == .board)
    }

    @Test("can switch between board, board-upcoming, completed")
    func modeSwitching() {
        let vm = BoardModeViewModel()
        vm.setMode(.boardUpcoming)
        #expect(vm.mode == .boardUpcoming)
        vm.setMode(.completed)
        #expect(vm.mode == .completed)
        vm.setMode(.board)
        #expect(vm.mode == .board)
    }

    @Test("each mode has deterministic empty state when no items")
    func emptyStatesByMode() {
        let vm = BoardModeViewModel()
        vm.setBoardItems([])
        #expect(vm.currentState == .empty("No items on this board."))

        vm.setMode(.boardUpcoming)
        vm.setUpcomingItems([])
        #expect(vm.currentState == .empty("No upcoming items on this board."))

        vm.setMode(.completed)
        vm.setCompletedItems([])
        #expect(vm.currentState == .empty("No completed items on this board."))
    }

    @Test("mode-specific loading and error states")
    func loadingAndErrorByMode() {
        let vm = BoardModeViewModel()
        vm.setLoading(for: .board)
        #expect(vm.currentState == .loading("Loading board…"))

        vm.setMode(.boardUpcoming)
        vm.setLoading(for: .boardUpcoming)
        #expect(vm.currentState == .loading("Loading upcoming…"))

        vm.setError(for: .completed, message: "Failed completed")
        vm.setMode(.completed)
        #expect(vm.currentState == .error("Failed completed"))
    }
}

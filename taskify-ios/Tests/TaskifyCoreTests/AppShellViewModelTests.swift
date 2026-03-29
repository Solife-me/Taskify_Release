import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("AppShellViewModel")
struct AppShellViewModelTests {

    @Test("initial tab defaults to boards")
    func defaultTab() {
        let profile = TaskifyProfile(name: "Nathan", nsecHex: String(repeating: "a", count: 64), npub: "npub1x", relays: [], boards: [])
        let vm = AppShellViewModel(profile: profile)
        #expect(vm.selectedTab == .boards)
    }

    @Test("shows empty boards state when no boards")
    func emptyBoardsState() {
        let profile = TaskifyProfile(name: "Nathan", nsecHex: String(repeating: "a", count: 64), npub: "npub1x", relays: [], boards: [])
        let vm = AppShellViewModel(profile: profile)
        #expect(vm.hasBoards == false)
        #expect(vm.boardsEmptyMessage == "No boards yet. Create or import your first board.")
    }

    @Test("hasBoards true when profile includes boards")
    func hasBoardsState() {
        let profile = TaskifyProfile(
            name: "Nathan",
            nsecHex: String(repeating: "a", count: 64),
            npub: "npub1x",
            relays: [],
            boards: [ProfileBoardEntry(id: "b1", name: "Personal")]
        )
        let vm = AppShellViewModel(profile: profile)
        #expect(vm.hasBoards == true)
    }

    @Test("tab switching works")
    func tabSwitching() {
        let profile = TaskifyProfile(name: "Nathan", nsecHex: String(repeating: "a", count: 64), npub: "npub1x", relays: [], boards: [])
        let vm = AppShellViewModel(profile: profile)
        vm.select(tab: .upcoming)
        #expect(vm.selectedTab == .upcoming)
    }
}

import Foundation

@MainActor
public final class AppShellViewModel: ObservableObject {
    public enum Tab: String {
        case boards
        case upcoming
        case settings
    }

    @Published public private(set) var selectedTab: Tab = .boards
    public let profile: TaskifyProfile

    public init(profile: TaskifyProfile) {
        self.profile = profile
    }

    public var hasBoards: Bool {
        !profile.boards.isEmpty
    }

    public var boardsEmptyMessage: String {
        "No boards yet. Create or import your first board."
    }

    public func select(tab: Tab) {
        selectedTab = tab
    }
}

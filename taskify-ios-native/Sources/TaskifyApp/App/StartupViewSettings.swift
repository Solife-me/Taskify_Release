import Foundation

/// Local device setting for which tab the app opens to, matching the PWA's `startupView`
/// setting. The PWA's "main" value maps to the Boards tab; Settings has no PWA equivalent since
/// the PWA has no dedicated settings page to land on.
enum StartupTab: String, CaseIterable {
    case boards = "main"
    case upcoming
    case wallet
    case chat

    var title: String {
        switch self {
        case .boards: "Boards"
        case .upcoming: "Upcoming"
        case .wallet: "Wallet"
        case .chat: "Chat"
        }
    }

    var appTab: AppTab {
        switch self {
        case .boards: .boards
        case .upcoming: .upcoming
        case .wallet: .wallet
        case .chat: .chat
        }
    }
}

enum StartupViewSettings {
    private static let key = "taskify.startupView"

    /// Defaults to Boards, matching the PWA's "main" default.
    static var tab: StartupTab {
        UserDefaults.standard.string(forKey: key).flatMap(StartupTab.init(rawValue:)) ?? .boards
    }

    static func setTab(_ tab: StartupTab) {
        UserDefaults.standard.set(tab.rawValue, forKey: key)
    }
}

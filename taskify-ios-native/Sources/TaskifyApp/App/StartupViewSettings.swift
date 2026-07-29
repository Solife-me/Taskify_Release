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
    private static let tabKey = "taskify.startupView"
    private static let boardByWeekdayKey = "taskify.startBoardByDay"

    /// Defaults to Boards, matching the PWA's "main" default.
    static var tab: StartupTab {
        UserDefaults.standard.string(forKey: tabKey).flatMap(StartupTab.init(rawValue:)) ?? .boards
    }

    static func setTab(_ tab: StartupTab) {
        UserDefaults.standard.set(tab.rawValue, forKey: tabKey)
    }

    /// Uses the PWA's weekday numbering: Sunday is 0 and Saturday is 6.
    static var boardIDsByWeekday: [Int: String] {
        guard let data = UserDefaults.standard.data(forKey: boardByWeekdayKey),
              let decoded = try? JSONDecoder().decode([Int: String].self, from: data) else {
            return [:]
        }
        return decoded
    }

    static func setBoardIDsByWeekday(_ preferences: [Int: String]) {
        guard !preferences.isEmpty else {
            UserDefaults.standard.removeObject(forKey: boardByWeekdayKey)
            return
        }
        guard let data = try? JSONEncoder().encode(preferences) else { return }
        UserDefaults.standard.set(data, forKey: boardByWeekdayKey)
    }
}

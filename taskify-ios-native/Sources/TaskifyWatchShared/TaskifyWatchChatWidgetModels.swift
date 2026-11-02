import Foundation

/// The links chat complications use to open the Watch app somewhere useful. Shared so the widget
/// extension and the app agree on the shape. A link only navigates; it never sends anything.
public enum TaskifyWatchChatLink: Equatable, Hashable, Sendable {
    case messages
    case newMessage
    case conversation(id: String)

    public static let scheme = "taskify-watch"
    private static let host = "chat"

    public var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = Self.host
        switch self {
        case .messages:
            break
        case .newMessage:
            components.path = "/new"
        case .conversation(let id):
            components.path = "/conversation/\(id)"
        }
        return components.url!
    }

    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme,
              url.host?.lowercased() == Self.host else { return nil }
        let path = url.pathComponents.filter { $0 != "/" }
        switch path.count {
        case 0:
            self = .messages
        case 1 where path[0] == "new":
            self = .newMessage
        case 2 where path[0] == "conversation":
            let id = path[1].lowercased()
            guard id.count == 64, id.allSatisfy(\.isHexDigit) else { return nil }
            self = .conversation(id: id)
        default:
            return nil
        }
    }
}

public struct TaskifyWatchChatWidgetConversation: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let unreadCount: Int
    public let isGroup: Bool

    public init(id: String, displayName: String, unreadCount: Int, isGroup: Bool) {
        self.id = id.lowercased()
        self.displayName = displayName
        self.unreadCount = max(0, unreadCount)
        self.isGroup = isGroup
    }
}

/// What chat complications are allowed to know.
///
/// This lives in App Group defaults because complications must render on a locked Watch, which
/// the complete-protection chat store cannot serve. So it deliberately holds names and counts
/// and never message text, and it leaves out message requests so a stranger cannot put their
/// chosen name on the watch face. Their unread count still counts, to match the app's Chat row.
public struct TaskifyWatchChatWidgetSnapshot: Codable, Equatable, Sendable {
    public static let maximumConversationCount = 50

    public let unreadCount: Int
    /// Conversations with unread messages first, then most recent first.
    public let conversations: [TaskifyWatchChatWidgetConversation]

    public init(
        unreadCount: Int = 0,
        conversations: [TaskifyWatchChatWidgetConversation] = []
    ) {
        self.unreadCount = max(0, unreadCount)
        // A stable sort keeps the caller's recency order within each group.
        let unread = conversations.filter { $0.unreadCount > 0 }
        let read = conversations.filter { $0.unreadCount == 0 }
        self.conversations = Array((unread + read).prefix(Self.maximumConversationCount))
    }

    public var unreadConversations: [TaskifyWatchChatWidgetConversation] {
        conversations.filter { $0.unreadCount > 0 }
    }

    public func conversation(id: String) -> TaskifyWatchChatWidgetConversation? {
        let normalized = id.lowercased()
        return conversations.first { $0.id == normalized }
    }

    /// Whether the conversations someone could pick differ, ignoring unread counts and order.
    public func hasSameDirectory(as other: TaskifyWatchChatWidgetSnapshot) -> Bool {
        func directory(_ snapshot: TaskifyWatchChatWidgetSnapshot) -> [String: String] {
            snapshot.conversations.reduce(into: [:]) { $0[$1.id] = $1.displayName }
        }
        return directory(self) == directory(other)
    }

    /// Case-insensitive name search for Siri and the Shortcuts picker.
    public func conversations(matching query: String) -> [TaskifyWatchChatWidgetConversation] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return conversations }
        return conversations.filter { $0.displayName.localizedCaseInsensitiveContains(trimmed) }
    }
}

public enum TaskifyWatchChatWidgetCache {
    public static let messagesWidgetKind = "TaskifyWatchMessagesWidget"
    public static let conversationWidgetKind = "TaskifyWatchConversationWidget"
    public static let widgetKinds = [messagesWidgetKind, conversationWidgetKind]

    private static let snapshotKey = "taskify-watch-chat-widget-snapshot-v1"

    public static func load() -> TaskifyWatchChatWidgetSnapshot {
        guard let defaults = UserDefaults(suiteName: TaskifyWatchWidgetCache.appGroupIdentifier),
              let data = defaults.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(
                TaskifyWatchChatWidgetSnapshot.self,
                from: data
              ) else {
            return TaskifyWatchChatWidgetSnapshot()
        }
        return snapshot
    }

    /// Returns true only when the stored value changed, preserving the WidgetKit reload budget.
    @discardableResult
    public static func saveIfChanged(_ snapshot: TaskifyWatchChatWidgetSnapshot) -> Bool {
        guard let defaults = UserDefaults(suiteName: TaskifyWatchWidgetCache.appGroupIdentifier),
              let data = try? JSONEncoder().encode(snapshot),
              defaults.data(forKey: snapshotKey) != data else { return false }
        defaults.set(data, forKey: snapshotKey)
        return true
    }
}

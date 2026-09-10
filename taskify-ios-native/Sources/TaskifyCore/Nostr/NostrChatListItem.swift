/// A conversation or the collapsed stranger inbox in the main chat list.
public enum NostrChatListItem: Identifiable, Equatable, Sendable {
    case thread(NostrDirectMessageThread)
    case strangers

    public var id: String {
        switch self {
        case .thread(let thread): return "thread:\(thread.id)"
        case .strangers: return "strangers"
        }
    }

    /// Inserts the stranger inbox into the already newest-first conversation list.
    /// Passing no strangers leaves search results and the expanded inbox unchanged.
    public static func rows(
        threads: [NostrDirectMessageThread],
        strangerThreads: [NostrDirectMessageThread] = []
    ) -> [NostrChatListItem] {
        var rows = threads.map(Self.thread)
        guard let latestStrangerActivity = strangerThreads.map(\.latestActivityTimestamp).max() else {
            return rows
        }
        // Preserve the existing conversation ordering, including its tie-breakers.
        // Familiar conversations precede the inbox when activity timestamps match.
        let index = threads.firstIndex { $0.latestActivityTimestamp < latestStrangerActivity }
            ?? threads.endIndex
        rows.insert(.strangers, at: index)
        return rows
    }
}

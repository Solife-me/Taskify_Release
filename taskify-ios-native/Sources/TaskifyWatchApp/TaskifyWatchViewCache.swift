import Foundation
import TaskifyWatchShared

struct TaskifyWatchChatThread: Identifiable, Equatable {
    let id: String
    let displayName: String
    let memberPublicKeys: [String]
    let latestMessage: TaskifyWatchChatMessage?
    let latestActivityAt: Int
    let preview: String
    let avatarURL: URL?
    let unreadCount: Int
    let isRequest: Bool
    let isGroup: Bool
}

/// Built once for a snapshot. Delivery expiry is evaluated at lookup time, never cached.
struct TaskifyWatchChatIndex {
    let contacts: [String: TaskifyWatchContact]
    let threads: [TaskifyWatchChatThread]
    let unreadCount: Int
    private let messagesByConversation: [String: [TaskifyWatchChatMessage]]
    private let outboxByRumor: [String: TaskifyWatchChatOutboxEntry]

    init(snapshot: TaskifyWatchChatSnapshot, identity: String) {
        contacts = snapshot.contacts.reduce(into: [:]) { $0[$1.publicKey] = $1 }
        messagesByConversation = Dictionary(grouping: snapshot.messages, by: \.conversationID)
            .mapValues { $0.sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                return $0.rumorID < $1.rumorID
            } }
        outboxByRumor = snapshot.outbox.reduce(into: [:]) { $0[$1.rumorID] = $1 }
        threads = Self.makeThreads(snapshot: snapshot, identity: identity.lowercased(),
                                   contacts: contacts, messagesByConversation: messagesByConversation)
        unreadCount = threads.reduce(0) { $0 + $1.unreadCount }
    }

    func messages(conversationID: String, now: Date = Date()) -> [TaskifyWatchChatMessage] {
        (messagesByConversation[conversationID.lowercased()] ?? []).map { message in
            guard let entry = outboxByRumor[message.rumorID] else { return message }
            var current = message
            current.deliveryState = entry.deliveryState(at: now)
            current.lastSubmissionError = current.deliveryState == .failed ? entry.lastSubmissionError : nil
            return current
        }
    }

    private static func makeThreads(snapshot: TaskifyWatchChatSnapshot, identity: String,
                                    contacts: [String: TaskifyWatchContact],
                                    messagesByConversation: [String: [TaskifyWatchChatMessage]]) -> [TaskifyWatchChatThread] {
        let groups = snapshot.groups.reduce(into: [String: TaskifyWatchGroupConversation]()) {
            $0[$1.groupID] = $1
        }
        let summaries = (snapshot.threadSummaries ?? []).reduce(
            into: [String: TaskifyWatchChatThreadSummary]()
        ) { $0[$1.id] = $1 }
        let conversationIDs = Set(messagesByConversation.keys).union(summaries.keys)
        return conversationIDs.compactMap { conversationID -> TaskifyWatchChatThread? in
                let messages = messagesByConversation[conversationID] ?? []
                let latest = messages.max(by: {
                    if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                    return $0.rumorID < $1.rumorID
                })
                let summary = summaries[conversationID]
                guard let members = latest?.memberPublicKeys ?? summary?.memberPublicKeys else {
                    return nil
                }
                let group = groups[conversationID]
                guard group?.isLeft != true else { return nil }
                let isGroup = group != nil || summary?.isGroup == true || members.count > 2
                let peers = members.filter { $0 != identity }
                let displayName: String
                if let group {
                    displayName = group.displayName
                } else if let summary {
                    displayName = summary.displayName
                } else if let peer = peers.first {
                    displayName = contacts[peer]?.displayName ?? Self.shortPublicKey(peer)
                } else {
                    displayName = "Conversation"
                }
                let readAt = max(
                    snapshot.readAt[conversationID] ?? 0,
                    summary?.readThrough ?? 0
                )
                let localUnread = messages.filter {
                    $0.senderPublicKey != identity && $0.createdAt > readAt
                }.count
                let latestActivityAt = max(latest?.createdAt ?? 0, summary?.latestActivityAt ?? 0)
                let preview: String
                if let latest, latest.createdAt >= (summary?.latestActivityAt ?? 0) {
                    preview = Self.chatPreview(for: latest)
                } else if let summary, !summary.latestPreview.isEmpty {
                    preview = summary.latestPreview
                } else {
                    preview = "Start a message"
                }
                // Summaries are rebuilt locally in the store after every mutation, so a
                // summary-backed thread's unreadCount already counts every local inbound
                // message after readAt; only summary-less conversations need the local count.
                let unread = summary?.unreadCount ?? localUnread
                let isRequest = summary?.isRequest ?? (!isGroup && peers.contains { contacts[$0] == nil })
                let avatarURL = summary?.avatarURL
                    ?? peers.first.flatMap { contacts[$0]?.avatarURL }
                return TaskifyWatchChatThread(
                    id: conversationID,
                    displayName: displayName,
                    memberPublicKeys: members,
                    latestMessage: latest,
                    latestActivityAt: latestActivityAt,
                    preview: preview,
                    avatarURL: avatarURL,
                    unreadCount: unread,
                    isRequest: isRequest,
                    isGroup: isGroup
                )
            }
            .sorted {
                if $0.latestActivityAt != $1.latestActivityAt {
                    return $0.latestActivityAt > $1.latestActivityAt
                }
                return $0.id < $1.id
            }
    }

    /// Shared with the chat store's locally rebuilt summaries: both the index and the store
    /// must render the same one-line preview from the same message row.
    static func shortPublicKey(_ value: String) -> String {
        value.count > 16 ? "\(value.prefix(8))…\(value.suffix(6))" : value
    }

    static func chatPreview(for message: TaskifyWatchChatMessage) -> String {
        switch message.kind {
        case .photo: "Photo"
        case .unsupportedAttachment: "Attachment — open on iPhone"
        case .unsupportedMessage: "Message — open on iPhone"
        case .reaction: "Reaction \(message.content)"
        case .text: message.content
        }
    }

}

/// The owner discards this index when tasks, boards, or pending completions change.
final class TaskifyWatchTaskIndex {
    let tasksByBoard: [String: [TaskifyWatchTask]]
    let openCounts: [String: Int]
    private let tasks: [TaskifyWatchTask]
    private var dayCache: (start: Date, calendar: Calendar, today: [TaskifyWatchTask], upcoming: [TaskifyWatchTask])?

    init(snapshot: TaskifyWatchSnapshot, pendingCompletions: Set<String>) {
        tasks = snapshot.tasks.filter { !pendingCompletions.contains($0.id) }
        tasksByBoard = Dictionary(grouping: tasks, by: \.boardID)
        let pending = snapshot.tasks.reduce(into: [String: Int]()) {
            if pendingCompletions.contains($1.id) { $0[$1.boardID, default: 0] += 1 }
        }
        openCounts = snapshot.boards.reduce(into: [:]) {
            $0[$1.id] = max(0, $1.openTaskCount - (pending[$1.id] ?? 0))
        }
    }

    func dayLists(now: Date = Date(), calendar: Calendar = .current)
        -> (today: [TaskifyWatchTask], upcoming: [TaskifyWatchTask]) {
        let start = calendar.startOfDay(for: now)
        if let cached = dayCache, cached.start == start, cached.calendar == calendar {
            return (cached.today, cached.upcoming)
        }
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
        var today: [TaskifyWatchTask] = []
        var upcoming: [TaskifyWatchTask] = []
        for task in tasks {
            guard let due = task.dueDate, due >= start else { continue }
            upcoming.append(task)
            if due < end { today.append(task) }
        }
        dayCache = (start, calendar, today, upcoming)
        return (today, upcoming)
    }
}

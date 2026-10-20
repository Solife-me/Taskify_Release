import CryptoKit
import Foundation

/// The parts of `TaskifySnapshot` kept in separate files (C7-5). Each is written only when it
/// changed, so a new chat message no longer rewrites every task, and widgets and intents read
/// only the tasks file.
public enum TaskifyStoreArea: String, CaseIterable, Codable, Sendable {
    /// Boards, tasks, calendar events, the selection and series cutoffs: everything widgets,
    /// intents and Siri read and write.
    case tasks
    /// Direct messages, group conversations and their per-conversation state.
    case chat
    /// Shared items waiting in the inbox, and contacts.
    case inbox

    var filename: String { "\(rawValue).json" }
}

struct TaskifyTasksArea: Codable, Equatable, Sendable {
    var schemaVersion: Int
    var boards: [Board]
    var tasks: [TaskItem]
    var selectedBoardID: String
    var taskifyEvents: [TaskifyEvent]?
    var sharedTaskRecipients: [SharedTaskRecipient]?
    var recurringTaskSeriesCutoffs: [String: [String: Date]]?
    var recurringTaskifyEventSeriesCutoffs: [String: [String: Date]]?
}

struct TaskifyChatArea: Codable, Equatable, Sendable {
    var directMessages: [NostrDirectMessage]?
    var directMessageReadAt: [String: Int]?
    var directMessageReactions: [NostrDirectMessageReaction]?
    var nostrGroupConversations: [NostrGroupConversation]?
    var directMessageArchivedAt: [String: Int]?
    var directMessageDeletedEventIDs: [String: Int]?
    var directMessageDeletedThreadAt: [String: Int]?
    var directMessageBlockedPeers: [String]?
    var directMessageMutedGroups: [String: Int]?
    var directMessageLeftGroups: [String]?
}

struct TaskifyInboxArea: Codable, Equatable, Sendable {
    var sharedInboxItems: [SharedInboxItem]?
    var sharedContactInboxItems: [SharedContactInboxItem]?
    var sharedCalendarInviteItems: [SharedCalendarInviteInboxItem]?
    var sharedBoardInboxItems: [SharedBoardInboxItem]?
    var contacts: [NostrContact]?
    var contactsListUpdatedAt: Int?
    var contactsListExtraTags: [[String]]?
}

/// A snapshot split into its areas, and joined back.
struct TaskifySnapshotAreas: Equatable, Sendable {
    var tasks: TaskifyTasksArea
    var chat: TaskifyChatArea
    var inbox: TaskifyInboxArea

    init(_ snapshot: TaskifySnapshot) {
        tasks = TaskifyTasksArea(
            schemaVersion: snapshot.schemaVersion,
            boards: snapshot.boards,
            tasks: snapshot.tasks,
            selectedBoardID: snapshot.selectedBoardID,
            taskifyEvents: snapshot.taskifyEvents,
            sharedTaskRecipients: snapshot.sharedTaskRecipients,
            recurringTaskSeriesCutoffs: snapshot.recurringTaskSeriesCutoffs,
            recurringTaskifyEventSeriesCutoffs: snapshot.recurringTaskifyEventSeriesCutoffs
        )
        chat = TaskifyChatArea(
            directMessages: snapshot.directMessages,
            directMessageReadAt: snapshot.directMessageReadAt,
            directMessageReactions: snapshot.directMessageReactions,
            nostrGroupConversations: snapshot.nostrGroupConversations,
            directMessageArchivedAt: snapshot.directMessageArchivedAt,
            directMessageDeletedEventIDs: snapshot.directMessageDeletedEventIDs,
            directMessageDeletedThreadAt: snapshot.directMessageDeletedThreadAt,
            directMessageBlockedPeers: snapshot.directMessageBlockedPeers,
            directMessageMutedGroups: snapshot.directMessageMutedGroups,
            directMessageLeftGroups: snapshot.directMessageLeftGroups
        )
        inbox = TaskifyInboxArea(
            sharedInboxItems: snapshot.sharedInboxItems,
            sharedContactInboxItems: snapshot.sharedContactInboxItems,
            sharedCalendarInviteItems: snapshot.sharedCalendarInviteItems,
            sharedBoardInboxItems: snapshot.sharedBoardInboxItems,
            contacts: snapshot.contacts,
            contactsListUpdatedAt: snapshot.contactsListUpdatedAt,
            contactsListExtraTags: snapshot.contactsListExtraTags
        )
    }

    /// The snapshot as stored: assigned field by field, because the initializer would repair it
    /// before the store can report the repair.
    var snapshot: TaskifySnapshot {
        var snapshot = TaskifySnapshot.empty
        snapshot.schemaVersion = tasks.schemaVersion
        snapshot.boards = tasks.boards
        snapshot.tasks = tasks.tasks
        snapshot.selectedBoardID = tasks.selectedBoardID
        snapshot.taskifyEvents = tasks.taskifyEvents
        snapshot.sharedTaskRecipients = tasks.sharedTaskRecipients
        snapshot.recurringTaskSeriesCutoffs = tasks.recurringTaskSeriesCutoffs
        snapshot.recurringTaskifyEventSeriesCutoffs = tasks.recurringTaskifyEventSeriesCutoffs
        snapshot.directMessages = chat.directMessages
        snapshot.directMessageReadAt = chat.directMessageReadAt
        snapshot.directMessageReactions = chat.directMessageReactions
        snapshot.nostrGroupConversations = chat.nostrGroupConversations
        snapshot.directMessageArchivedAt = chat.directMessageArchivedAt
        snapshot.directMessageDeletedEventIDs = chat.directMessageDeletedEventIDs
        snapshot.directMessageDeletedThreadAt = chat.directMessageDeletedThreadAt
        snapshot.directMessageBlockedPeers = chat.directMessageBlockedPeers
        snapshot.directMessageMutedGroups = chat.directMessageMutedGroups
        snapshot.directMessageLeftGroups = chat.directMessageLeftGroups
        snapshot.sharedInboxItems = inbox.sharedInboxItems
        snapshot.sharedContactInboxItems = inbox.sharedContactInboxItems
        snapshot.sharedCalendarInviteItems = inbox.sharedCalendarInviteItems
        snapshot.sharedBoardInboxItems = inbox.sharedBoardInboxItems
        snapshot.contacts = inbox.contacts
        snapshot.contactsListUpdatedAt = inbox.contactsListUpdatedAt
        snapshot.contactsListExtraTags = inbox.contactsListExtraTags
        return snapshot
    }
}

/// Inline attachment data kept as files beside the store (C7-5). Files hold a reference
/// (`taskify-file:<sha256>`) in place of each large inline value; in memory, and on the wire,
/// values stay inline, so nothing outside the store sees references. Files are named by content,
/// so writing one twice is harmless and two processes agree on the name.
struct TaskifyAttachmentFiles {
    static let referencePrefix = "taskify-file:"
    /// Smaller values stay inline: a file per small value would cost more than it saves.
    static let minimumBytes = 4096

    let directory: URL
    /// Inline value -> file name, for values already written. Rebuilt on each save so it holds
    /// only values still in use.
    private(set) var known: [String: String] = [:]

    init(directory: URL) {
        self.directory = directory
    }

    /// The value to write to a store file: a reference for a large inline value.
    mutating func externalize(_ value: String, into used: inout [String: String]) throws -> String {
        guard value.utf8.count >= Self.minimumBytes, !value.hasPrefix(Self.referencePrefix) else { return value }
        let name: String
        if let existing = known[value] ?? used[value] {
            name = existing
        } else {
            let data = Data(value.utf8)
            name = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            let url = directory.appendingPathComponent(name, isDirectory: false)
            if !FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: url, options: .atomic)
            }
        }
        used[value] = name
        return Self.referencePrefix + name
    }

    /// The inline value for a reference read from a store file; nil when its file is missing.
    mutating func inline(_ value: String) -> String? {
        guard value.hasPrefix(Self.referencePrefix) else { return value }
        let name = String(value.dropFirst(Self.referencePrefix.count))
        guard name.count == 64, name.allSatisfy(\.isHexDigit),
              let data = FileManager.default.contents(atPath: directory.appendingPathComponent(name).path),
              let inline = String(data: data, encoding: .utf8) else { return nil }
        known[inline] = name
        return inline
    }

    mutating func replaceKnown(with used: [String: String]) {
        known = used
    }

    /// Removes files no store file refers to. Only files older than `minimumAge` go: another
    /// process may have just written one for a store file it is about to write.
    func removeUnused(referenced: Set<String>, minimumAge: TimeInterval = 3600, now: Date = Date()) {
        let fileManager = FileManager.default
        guard let names = try? fileManager.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where !referenced.contains(name) {
            let url = directory.appendingPathComponent(name)
            let modified = (try? fileManager.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
            if let modified, now.timeIntervalSince(modified) < minimumAge { continue }
            try? fileManager.removeItem(at: url)
        }
    }
}

extension TaskifySnapshotAreas {
    /// Applies `transform` to every attachment value the areas carry: task images and document
    /// data, event images and documents, and documents in tasks shared to the inbox.
    mutating func mapAttachmentValues(_ transform: (String) throws -> String?) rethrows {
        func document(_ document: TaskDocument) throws -> TaskDocument {
            var document = document
            if let value = document.dataURL { document.dataURL = try transform(value) }
            if let preview = document.preview {
                document.preview = try transform(preview.data).map { TaskDocumentContent(type: preview.type, data: $0) }
            }
            if let full = document.full {
                document.full = try transform(full.data).map { TaskDocumentContent(type: full.type, data: $0) }
            }
            return document
        }
        for index in tasks.tasks.indices {
            if let images = tasks.tasks[index].images, images.contains(where: Self.mayCarryAttachment) {
                tasks.tasks[index].images = try images.compactMap(transform)
            }
            if let documents = tasks.tasks[index].documents, !documents.isEmpty {
                tasks.tasks[index].documents = try documents.map(document)
            }
        }
        if let events = tasks.taskifyEvents {
            tasks.taskifyEvents = try events.map { event in
                var event = event
                if let image = event.imageURL, Self.mayCarryAttachment(image) { event.imageURL = try transform(image) }
                if let documents = event.documents, !documents.isEmpty { event.documents = try documents.map(document) }
                return event
            }
        }
        if let items = inbox.sharedInboxItems {
            inbox.sharedInboxItems = try items.map { item in
                var item = item
                if let documents = item.task.documents, !documents.isEmpty {
                    item.task.documents = try documents.map(document)
                }
                return item
            }
        }
    }

    private static func mayCarryAttachment(_ value: String) -> Bool {
        value.utf8.count >= TaskifyAttachmentFiles.minimumBytes || value.hasPrefix(TaskifyAttachmentFiles.referencePrefix)
    }
}

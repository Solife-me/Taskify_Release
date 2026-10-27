import Foundation

/// A task as Spotlight shows it (C10-7).
public struct TaskifySpotlightItem: Codable, Equatable, Sendable {
    public let id: String
    public let boardID: String
    public let title: String
    public let boardName: String
    public let dueDate: Date?
    public let dueTimeEnabled: Bool

    /// What the index holds for this task; a change means it is indexed again.
    public var fingerprint: String {
        [title, boardID, boardName, dueDate.map { String($0.timeIntervalSince1970) } ?? "", dueTimeEnabled ? "t" : ""]
            .joined(separator: "\u{1}")
    }
}

/// Which tasks Spotlight finds, and what changed since the index was last updated (C10-7).
/// Open tasks on boards that aren't archived; completed and deleted tasks leave the index. The
/// index stays on the device.
public enum TaskifySpotlightIndex {
    public struct Changes: Equatable, Sendable {
        /// Tasks to add or replace in the index.
        public var upserts: [TaskifySpotlightItem]
        /// Task ids to remove from the index.
        public var removals: [String]
        /// Task id -> fingerprint, to keep for the next update.
        public var fingerprints: [String: String]
    }

    public static func items(in snapshot: TaskifySnapshot) -> [TaskifySpotlightItem] {
        let boards = Dictionary(
            snapshot.boards.filter { !$0.archived }.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var seen = Set<String>()
        return snapshot.tasks.compactMap { task in
            guard !task.isDeleted, !task.completed, let board = boards[task.boardID],
                  !task.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  seen.insert(task.id).inserted else { return nil }
            return TaskifySpotlightItem(
                id: task.id,
                boardID: board.id,
                title: task.title,
                boardName: board.name,
                dueDate: task.dueDateEnabled ? task.dueDate : nil,
                dueTimeEnabled: task.dueDateEnabled && task.dueTimeEnabled
            )
        }
    }

    /// The updates that bring an index holding `indexed` (task id -> fingerprint) to `items`.
    public static func changes(from indexed: [String: String], to items: [TaskifySpotlightItem]) -> Changes {
        var fingerprints: [String: String] = [:]
        var upserts: [TaskifySpotlightItem] = []
        for item in items {
            let fingerprint = item.fingerprint
            fingerprints[item.id] = fingerprint
            if indexed[item.id] != fingerprint { upserts.append(item) }
        }
        let removals = indexed.keys.filter { fingerprints[$0] == nil }.sorted()
        return Changes(upserts: upserts, removals: removals, fingerprints: fingerprints)
    }
}

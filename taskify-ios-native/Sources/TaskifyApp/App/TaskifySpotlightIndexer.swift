import CoreSpotlight
import Foundation
import TaskifyCore
import UniformTypeIdentifiers

/// Keeps open tasks in Spotlight (C10-7). `TaskifySpotlightIndex` decides what changed since the
/// last update; only that is sent. The index is on this device only, and the user can turn it off
/// in iOS Settings under Siri & Search. A result opens the task (`RootTabView`).
actor TaskifySpotlightIndexer {
    static let shared = TaskifySpotlightIndexer()
    static let domain = "solife.me.Taskify.tasks"

    private let index = CSSearchableIndex.default()
    /// Task id -> fingerprint of what the index holds. Nil until read from disk.
    private var indexed: [String: String]?

    private var stateURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return support.appendingPathComponent("TaskifyNative", isDirectory: true)
            .appendingPathComponent("spotlight-index.json", isDirectory: false)
    }

    func update(with items: [TaskifySpotlightItem]) async {
        var current = indexed ?? loadState()
        if current == nil {
            // No record of what an earlier install or version indexed: start clean.
            try? await index.deleteSearchableItems(withDomainIdentifiers: [Self.domain])
            current = [:]
        }
        let changes = TaskifySpotlightIndex.changes(from: current ?? [:], to: items)
        guard !changes.upserts.isEmpty || !changes.removals.isEmpty else {
            indexed = current
            return
        }
        do {
            if !changes.removals.isEmpty {
                try await index.deleteSearchableItems(withIdentifiers: changes.removals)
            }
            if !changes.upserts.isEmpty {
                try await index.indexSearchableItems(changes.upserts.map(Self.searchableItem))
            }
            indexed = changes.fingerprints
            saveState(changes.fingerprints)
        } catch {
            // The record stays as it was, so the next update sends these again.
            indexed = current
        }
    }

    private static func searchableItem(_ item: TaskifySpotlightItem) -> CSSearchableItem {
        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = item.title
        var details = [item.boardName]
        if let due = item.dueDate {
            details.append(item.dueTimeEnabled
                ? due.formatted(date: .abbreviated, time: .shortened)
                : due.formatted(date: .abbreviated, time: .omitted))
        }
        attributes.contentDescription = details.filter { !$0.isEmpty }.joined(separator: " · ")
        // Spotlight shows a due date with its time; an all-day task's is in the description.
        if item.dueTimeEnabled { attributes.dueDate = item.dueDate }
        return CSSearchableItem(uniqueIdentifier: item.id, domainIdentifier: domain, attributeSet: attributes)
    }

    private func loadState() -> [String: String]? {
        guard let data = FileManager.default.contents(atPath: stateURL.path) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: data)
    }

    private func saveState(_ fingerprints: [String: String]) {
        guard let data = try? JSONEncoder().encode(fingerprints) else { return }
        try? FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: stateURL, options: .atomic)
    }
}

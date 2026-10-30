import CoreSpotlight
import Foundation
import TaskifyCore
import UniformTypeIdentifiers

/// Keeps open tasks in Spotlight (C10-7/C11-4). `TaskifySpotlightIndex` decides what changed since
/// the last update; only that is sent. The index is on this device only. A result opens the task
/// through the shared `taskify://task` link on both iOS and macOS.
actor TaskifySpotlightIndexer {
    static let shared = TaskifySpotlightIndexer()

    private struct StoredState: Codable {
        var accountID: String
        var fingerprints: [String: String]
    }
#if os(macOS)
    /// The bundle-scoped domain keeps the isolated Mac UI host out of the production Mac index.
    static var domain: String {
        "\(Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac").tasks"
    }
#else
    /// Preserve the established iOS domain so upgrades continue removing earlier indexed items.
    static let domain = "solife.me.Taskify.tasks"
#endif

    private let index = CSSearchableIndex.default()
    /// Task id -> fingerprint of what the index holds. Nil until read from disk.
    private var indexed: [String: String]?
    private var activeAccountID: String?

    private var stateURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return support.appendingPathComponent("TaskifyNative", isDirectory: true)
            .appendingPathComponent("spotlight-index.json", isDirectory: false)
    }

    /// Clears the device-visible Spotlight index when another account becomes active. Each model
    /// update also carries its account ID, so a delayed old-account task cannot repopulate it.
    func activate(accountID: String) async {
        let normalized = accountID.lowercased()
        guard activeAccountID != normalized else { return }
        activeAccountID = normalized
        indexed = [:]
        try? await index.deleteSearchableItems(withDomainIdentifiers: [Self.domain])
        saveState(StoredState(accountID: normalized, fingerprints: [:]))
    }

    func update(with items: [TaskifySpotlightItem], accountID: String) async {
        if activeAccountID == nil {
            await activate(accountID: accountID)
        }
        // An update request may outlive the model that scheduled it. It may never select an
        // account; only the runtime's explicit activation can change the active Spotlight scope.
        guard TaskifyAccountScope.isSame(activeAccountID, accountID) else { return }
        var current = indexed ?? loadState(for: accountID)
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
        attributes.contentURL = TaskifyWidgetLink.task(id: item.id, boardID: item.boardID).url
        // Spotlight shows a due date with its time; an all-day task's is in the description.
        if item.dueTimeEnabled { attributes.dueDate = item.dueDate }
        return CSSearchableItem(uniqueIdentifier: item.id, domainIdentifier: domain, attributeSet: attributes)
    }

    private func loadState(for accountID: String) -> [String: String]? {
        guard let data = FileManager.default.contents(atPath: stateURL.path) else { return nil }
        if let state = try? JSONDecoder().decode(StoredState.self, from: data),
           state.accountID == accountID.lowercased() {
            return state.fingerprints
        }
        // A legacy unqualified state map is never trusted across an account boundary.
        return nil
    }

    private func saveState(_ fingerprints: [String: String]) {
        saveState(StoredState(
            accountID: activeAccountID ?? "",
            fingerprints: fingerprints
        ))
    }

    private func saveState(_ state: StoredState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: stateURL, options: .atomic)
    }
}

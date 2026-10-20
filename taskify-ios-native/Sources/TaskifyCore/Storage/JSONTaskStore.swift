import Foundation

/// The app's data on disk, shared with widgets, intents and the notification service.
///
/// Kept as one file per area (`TaskifyStoreArea`, C7-5) in a `taskify-store` folder beside where
/// the single legacy file lived, with large inline attachments as files of their own. A save
/// writes only the areas that changed since this store last read or wrote them, so a chat
/// message does not rewrite every task, and another process's save does not write back areas it
/// never changed. Areas left out of a load are not written either.
///
/// The legacy single file is read until the store is split. Splitting (by the app, at load)
/// writes every area, then a format marker, then removes the legacy file, so an interruption at
/// any point leaves either the legacy file in charge or a complete split store.
public actor JSONTaskStore {
    public struct LoadResult: Sendable {
        public let snapshot: TaskifySnapshot
        public let wasRepaired: Bool
    }

    /// The legacy single file. Resolves to the App Group container when that capability is in
    /// effect, so widgets and the Add Task intent read the same data the app writes. Falls back
    /// to the app's own directory otherwise -- see `TaskifySharedContainer`.
    public static var defaultURL: URL {
        TaskifySharedContainer.storeDirectory()
            .appendingPathComponent(TaskifySharedContainer.storeFilename, isDirectory: false)
    }

    public static let splitDirectoryName = "taskify-store"
    static let markerFilename = "format.json"
    static let attachmentsDirectoryName = "attachments"
    static let formatVersion = 1

    private struct FormatMarker: Codable {
        var version: Int
    }

    private let legacyURL: URL
    private let directory: URL
    private let migratesLegacyStore: Bool
    private var attachments: TaskifyAttachmentFiles

    /// What this store last read or wrote for each area. Nil until loaded or saved: a save then
    /// writes the area. An area left out of a load is not written.
    private var savedTasks: TaskifyTasksArea?
    private var savedChat: TaskifyChatArea?
    private var savedInbox: TaskifyInboxArea?
    private var writableAreas: Set<TaskifyStoreArea> = Set(TaskifyStoreArea.allCases)

    /// - Parameters:
    ///   - fileURL: where the legacy single file lives; the split store is kept beside it.
    ///   - migratesLegacyStore: splits a legacy store at load. Only the app does this, so an
    ///     extension that loaded the legacy file earlier never writes a split store from it.
    public init(fileURL: URL = JSONTaskStore.defaultURL, migratesLegacyStore: Bool = false) {
        legacyURL = fileURL
        directory = fileURL.deletingLastPathComponent()
            .appendingPathComponent(Self.splitDirectoryName, isDirectory: true)
        self.migratesLegacyStore = migratesLegacyStore
        attachments = TaskifyAttachmentFiles(
            directory: directory.appendingPathComponent(Self.attachmentsDirectoryName, isDirectory: true)
        )
    }

    private var markerURL: URL { directory.appendingPathComponent(Self.markerFilename, isDirectory: false) }

    private func areaURL(_ area: TaskifyStoreArea) -> URL {
        directory.appendingPathComponent(area.filename, isDirectory: false)
    }

    private var isSplit: Bool { FileManager.default.fileExists(atPath: markerURL.path) }

    /// When the tasks were last written by any process: the signal for changes made elsewhere.
    public func tasksModificationDate() -> Date? {
        let url = isSplit ? areaURL(.tasks) : legacyURL
        return (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    public func load(areas: Set<TaskifyStoreArea> = Set(TaskifyStoreArea.allCases)) throws -> TaskifySnapshot {
        try loadWithRepairStatus(areas: areas).snapshot
    }

    /// Loads `areas`; the others come back empty and are not written by later saves.
    public func loadWithRepairStatus(
        areas: Set<TaskifyStoreArea> = Set(TaskifyStoreArea.allCases)
    ) throws -> LoadResult {
        var loaded: TaskifySnapshotAreas
        // The legacy file holds every area, so a load of it covers them all.
        var areas = areas
        if isSplit {
            loaded = TaskifySnapshotAreas(.empty)
            let decoder = JSONDecoder()
            for area in areas {
                guard let data = FileManager.default.contents(atPath: areaURL(area).path) else { continue }
                switch area {
                case .tasks: loaded.tasks = try decoder.decode(TaskifyTasksArea.self, from: data)
                case .chat: loaded.chat = try decoder.decode(TaskifyChatArea.self, from: data)
                case .inbox: loaded.inbox = try decoder.decode(TaskifyInboxArea.self, from: data)
                }
            }
            loaded.mapAttachmentValues { attachments.inline($0) }
        } else if let data = FileManager.default.contents(atPath: legacyURL.path) {
            loaded = TaskifySnapshotAreas(try JSONDecoder().decode(TaskifySnapshot.self, from: data))
            areas = Set(TaskifyStoreArea.allCases)
            if migratesLegacyStore { try? split(loaded) }
        } else {
            loaded = TaskifySnapshotAreas(.empty)
        }

        let decodedSnapshot = loaded.snapshot
        writableAreas = areas
        savedTasks = areas.contains(.tasks) ? loaded.tasks : nil
        savedChat = areas.contains(.chat) ? loaded.chat : nil
        savedInbox = areas.contains(.inbox) ? loaded.inbox : nil
        var snapshot = decodedSnapshot
        snapshot.repairSelection()
        return LoadResult(snapshot: snapshot, wasRepaired: snapshot != decodedSnapshot)
    }

    /// Reads `areas` for display only, leaving each externalized attachment as its
    /// `taskify-file:` reference instead of reading it into memory (C10-3). For extensions that
    /// show tasks or decide a notification but never show an attachment, within their memory
    /// limits. It leaves what this store saves next unchanged; save what `load` returns, not this.
    public func read(areas: Set<TaskifyStoreArea>) throws -> TaskifySnapshot {
        var loaded = TaskifySnapshotAreas(.empty)
        if isSplit {
            let decoder = JSONDecoder()
            for area in areas {
                guard let data = FileManager.default.contents(atPath: areaURL(area).path) else { continue }
                switch area {
                case .tasks: loaded.tasks = try decoder.decode(TaskifyTasksArea.self, from: data)
                case .chat: loaded.chat = try decoder.decode(TaskifyChatArea.self, from: data)
                case .inbox: loaded.inbox = try decoder.decode(TaskifyInboxArea.self, from: data)
                }
            }
        } else if let data = FileManager.default.contents(atPath: legacyURL.path) {
            loaded = TaskifySnapshotAreas(try JSONDecoder().decode(TaskifySnapshot.self, from: data))
        }
        var snapshot = loaded.snapshot
        snapshot.repairSelection()
        return snapshot
    }

    /// The tasks on disk, for merging changes another process made. Unlike `load`, it leaves what
    /// this store saves next unchanged.
    public func readTasksWrittenElsewhere() throws -> [TaskItem] {
        if isSplit {
            guard let data = FileManager.default.contents(atPath: areaURL(.tasks).path) else { return [] }
            var areas = TaskifySnapshotAreas(.empty)
            areas.tasks = try JSONDecoder().decode(TaskifyTasksArea.self, from: data)
            areas.mapAttachmentValues { attachments.inline($0) }
            return areas.tasks.tasks
        }
        guard let data = FileManager.default.contents(atPath: legacyURL.path) else { return [] }
        return try JSONDecoder().decode(TaskifySnapshot.self, from: data).tasks
    }

    /// Writes the areas that changed since this store last read or wrote them, and returns them.
    @discardableResult
    public func save(_ snapshot: TaskifySnapshot) throws -> Set<TaskifyStoreArea> {
        let areas = TaskifySnapshotAreas(snapshot)
        guard isSplit || !FileManager.default.fileExists(atPath: legacyURL.path) || migratesLegacyStore else {
            // Not split yet, and not ours to split: keep writing the legacy file.
            try write(snapshot, to: legacyURL)
            savedTasks = areas.tasks
            savedChat = areas.chat
            savedInbox = areas.inbox
            return Set(TaskifyStoreArea.allCases)
        }
        if !isSplit {
            try split(areas)
            return Set(TaskifyStoreArea.allCases)
        }
        var written: Set<TaskifyStoreArea> = []
        var stored = areas
        var used: [String: String] = [:]
        let changedTasks = writableAreas.contains(.tasks) && areas.tasks != savedTasks
        let changedInbox = writableAreas.contains(.inbox) && areas.inbox != savedInbox
        if changedTasks || changedInbox {
            try stored.mapAttachmentValues { try attachments.externalize($0, into: &used) }
        }
        if changedTasks {
            try write(stored.tasks, to: areaURL(.tasks))
            savedTasks = areas.tasks
            written.insert(.tasks)
        }
        if writableAreas.contains(.chat), areas.chat != savedChat {
            try write(stored.chat, to: areaURL(.chat))
            savedChat = areas.chat
            written.insert(.chat)
        }
        if changedInbox {
            try write(stored.inbox, to: areaURL(.inbox))
            savedInbox = areas.inbox
            written.insert(.inbox)
        }
        // Both areas were mapped, so `used` names every attachment still in use.
        if changedTasks || changedInbox { attachments.replaceKnown(with: used) }
        return written
    }

    /// Removes attachment files no area refers to. Call after loading every area; files written
    /// within the last hour stay, in case another process is about to refer to them.
    public func removeUnusedAttachments(minimumAge: TimeInterval = 3600) throws {
        guard isSplit else { return }
        var referenced = Set<String>()
        for area in TaskifyStoreArea.allCases where area != .chat {
            guard let data = FileManager.default.contents(atPath: areaURL(area).path),
                  let text = String(data: data, encoding: .utf8) else { continue }
            var rest = text[...]
            while let range = rest.range(of: TaskifyAttachmentFiles.referencePrefix) {
                let name = rest[range.upperBound...].prefix(64)
                if name.count == 64 { referenced.insert(String(name)) }
                rest = rest[range.upperBound...]
            }
        }
        attachments.removeUnused(referenced: referenced, minimumAge: minimumAge)
    }

    /// Writes every area, then the marker, then removes the legacy file.
    private func split(_ areas: TaskifySnapshotAreas) throws {
        var stored = areas
        var used: [String: String] = [:]
        try stored.mapAttachmentValues { try attachments.externalize($0, into: &used) }
        try write(stored.tasks, to: areaURL(.tasks))
        try write(stored.chat, to: areaURL(.chat))
        try write(stored.inbox, to: areaURL(.inbox))
        try write(FormatMarker(version: Self.formatVersion), to: markerURL)
        attachments.replaceKnown(with: used)
        savedTasks = areas.tasks
        savedChat = areas.chat
        savedInbox = areas.inbox
        try? FileManager.default.removeItem(at: legacyURL)
    }

    private func write(_ value: some Encodable, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        // Sorted for deterministic output; not pretty-printed. Nothing reads these files by eye,
        // and the indentation was roughly a third of the bytes written on every save.
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }
}

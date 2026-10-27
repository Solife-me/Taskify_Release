import Foundation

/// A task saved from the share sheet, waiting for the app (C10-6).
///
/// The share extension keeps to its own App Group and never opens the task store, so it can't
/// add the task itself. It writes a draft, with copies of the shared files, to the share group;
/// the app imports drafts when it next runs (in the foreground or a background refresh): it
/// uploads the files, adds the task through its normal path and publishes it, then removes the
/// draft.
public struct ShareTaskDraft: Codable, Equatable, Identifiable, Sendable {
    public struct File: Codable, Equatable, Sendable {
        public let name: String
        public let mimeType: String
        /// The copy's name inside the draft's folder.
        public let storedName: String

        public init(name: String, mimeType: String, storedName: String) {
            self.name = name; self.mimeType = mimeType; self.storedName = storedName
        }
    }

    public let id: UUID
    /// The account it was saved for; a draft for another account is dropped.
    public let account: String
    public let title: String
    public let note: String
    /// A name from `ShareAccount.taskBoards`, or nil for the default board.
    public let boardName: String?
    public let createdAt: Date
    public var files: [File]

    public init(id: UUID = UUID(), account: String, title: String, note: String, boardName: String?,
                createdAt: Date = Date(), files: [File] = []) {
        self.id = id; self.account = account; self.title = title; self.note = note
        self.boardName = boardName; self.createdAt = createdAt; self.files = files
    }

    /// The task id the draft becomes, so an import interrupted after adding it doesn't add it twice.
    public var taskID: String { "share-\(id.uuidString.lowercased())" }

    /// Title and note from what was shared. The title is the page's title, or the first line of
    /// text that isn't a link; everything else, links included, goes in the note. With only files,
    /// the title is the first file's name.
    public static func titleAndNote(text: String, pageTitle: String?, fileNames: [String] = []) -> (title: String, note: String) {
        var lines = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let title: String
        if let pageTitle = pageTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !pageTitle.isEmpty {
            title = pageTitle
        } else if let index = lines.firstIndex(where: { !isLink($0) }) {
            title = lines.remove(at: index)
        } else if let first = lines.first {
            title = first
            lines.removeFirst()
        } else {
            title = fileNames.first.map { URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent } ?? "Shared item"
        }
        let clipped = title.count > 200 ? String(title.prefix(200)) : title
        return (clipped, lines.joined(separator: "\n"))
    }

    private static func isLink(_ line: String) -> Bool {
        guard !line.contains(" "), let url = URL(string: line), let scheme = url.scheme?.lowercased() else { return false }
        return ["http", "https"].contains(scheme) && url.host != nil
    }
}

/// Drafts in the share group, one folder each beside the share transfers.
public enum ShareTaskDraftStore {
    private static let folderName = "task-drafts"

    static func root(in parent: URL? = nil) throws -> URL {
        let url = try (parent ?? ShareTransferStore.root()).appendingPathComponent(folderName, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return url
    }

    /// Saves `draft`, copying each file in `files` (source URL, display name, MIME type) into its
    /// folder. The draft is written last, so a folder without one is an interrupted save.
    @discardableResult
    public static func save(_ draft: ShareTaskDraft, files: [(url: URL, name: String, mimeType: String)],
                            in parent: URL? = nil) throws -> ShareTaskDraft {
        let folder = try root(in: parent).appendingPathComponent(draft.id.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var saved = draft
        saved.files = []
        for (index, file) in files.enumerated() {
            let ext = URL(fileURLWithPath: file.name).pathExtension
            let storedName = "file-\(index)" + (ext.isEmpty ? "" : ".\(ext)")
            let destination = folder.appendingPathComponent(storedName)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.copyItem(at: file.url, to: destination)
            saved.files.append(ShareTaskDraft.File(name: file.name, mimeType: file.mimeType, storedName: storedName))
        }
        let data = try JSONEncoder().encode(saved)
        try data.write(to: folder.appendingPathComponent("draft.json"), options: .atomic)
        return saved
    }

    /// Saved drafts, oldest first.
    public static func all(in parent: URL? = nil) -> [ShareTaskDraft] {
        guard let root = try? root(in: parent),
              let folders = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        return folders.compactMap { folder in
            guard let data = FileManager.default.contents(atPath: folder.appendingPathComponent("draft.json").path) else { return nil }
            return try? JSONDecoder().decode(ShareTaskDraft.self, from: data)
        }
        .sorted { $0.createdAt < $1.createdAt }
    }

    public static func fileURL(_ file: ShareTaskDraft.File, of draft: ShareTaskDraft, in parent: URL? = nil) throws -> URL {
        guard file.storedName == URL(fileURLWithPath: file.storedName).lastPathComponent else { throw AttachmentFileError.invalidFile }
        return try root(in: parent).appendingPathComponent(draft.id.uuidString, isDirectory: true)
            .appendingPathComponent(file.storedName)
    }

    public static func remove(_ draft: ShareTaskDraft, in parent: URL? = nil) {
        guard let folder = try? root(in: parent).appendingPathComponent(draft.id.uuidString, isDirectory: true) else { return }
        try? FileManager.default.removeItem(at: folder)
    }
}

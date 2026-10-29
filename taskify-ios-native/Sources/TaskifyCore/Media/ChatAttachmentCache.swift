import CryptoKit
import Foundation
import UniformTypeIdentifiers

/// Hands out the decrypted file for a chat attachment: from memory, then the disk cache, and
/// only then by downloading and decrypting it.
public actor DirectMessageAttachmentDataLoader {
    public static let shared = DirectMessageAttachmentDataLoader()
    private var files: [String: URL] = [:]
    private var order: [String] = []

    public func file(
        for attachment: NostrDirectMessageAttachment,
        progress: AttachmentProgressHandler? = nil
    ) async throws -> URL {
        if let file = files[attachment.cacheKey], FileManager.default.fileExists(atPath: file.path) { return file }
        if let cached = await DirectMessageAttachmentDiskCache.shared.file(forKey: attachment.cacheKey) {
            remember(cached, forKey: attachment.cacheKey)
            return cached
        }
        guard let url = URL(string: attachment.url) else { throw URLError(.badURL) }
        let ciphertext = try await AttachmentDownload.file(
            from: url,
            limit: AttachmentFiles.maximumBytes + 16,
            progress: progress
        )
        defer { try? FileManager.default.removeItem(at: ciphertext) }
        let plaintext = try await AttachmentFiles.work {
            try AttachmentFileCrypto.decryptChat(ciphertext, attachment: attachment)
        }
        // The disk cache owns stored files from here on; if storing fails, the
        // plaintext temp file still works and is purged with other temporary files.
        let stored = await DirectMessageAttachmentDiskCache.shared.store(plaintext, forKey: attachment.cacheKey)
        remember(stored ?? plaintext, forKey: attachment.cacheKey)
        return stored ?? plaintext
    }

    private func remember(_ file: URL, forKey key: String) {
        files[key] = file
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > 2 {
            files.removeValue(forKey: order.removeFirst())
        }
    }

    /// A copy named after the attachment (with an extension), for Quick Look, exports and
    /// opening in another app; the caller removes it when done.
    public nonisolated static func previewFile(file: URL, attachment: NostrDirectMessageAttachment) throws -> URL {
        let directory = try AttachmentFiles.directory().appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try AttachmentFiles.protect(directory)
        let cleaned = attachment.displayName.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        var name = cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "Attachment" : String(cleaned.prefix(160))
        // Quick Look and the Files and Photos exports identify the type by extension, and a
        // filename-less attachment's display name ("Photo", "Audio") has none.
        if (name as NSString).pathExtension.isEmpty,
           let ext = UTType(mimeType: attachment.mimeType)?.preferredFilenameExtension {
            name += ".\(ext)"
        }
        let url = directory.appendingPathComponent(name)
        try FileManager.default.copyItem(at: file, to: url)
        try AttachmentFiles.protect(url)
        return url
    }
}

/// Persistently caches decrypted chat attachments so returning to a conversation or
/// relaunching the app renders immediately instead of re-downloading and
/// re-decrypting every image and file again. Entries live in the OS-managed caches
/// directory, are keyed by the full attachment descriptor (URL + key + nonce — a
/// key therefore maps to exactly one plaintext), and are evicted least-recently-used
/// once the total size exceeds `byteLimit`. Files carry the same owner-only
/// permissions and first-unlock protection as every other Taskify media file.
public actor DirectMessageAttachmentDiskCache {
    public static let shared = DirectMessageAttachmentDiskCache()

    /// Bounds total disk usage; decrypted attachments are already capped at 500 MB
    /// individually by `AttachmentFiles.maximumBytes`.
    private static let byteLimit = 256 * 1_024 * 1_024

    private let directory: URL

    init() {
        // The system may empty the caches directory under storage pressure; that is
        // acceptable for a cache — the loader just falls back to downloading again.
        let fileManager = FileManager.default
        let base = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        directory = base.appendingPathComponent("TaskifyChatAttachments", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
                                          attributes: [.posixPermissions: 0o700])
        try? AttachmentFiles.protect(directory)
    }

    private func filename(forKey key: String) -> String {
        Data(SHA256.hash(data: Data(key.utf8))).hexString
    }

    /// Returns the cached plaintext for `key`, refreshing its recency so eviction
    /// is least-recently-used.
    public func file(forKey key: String) -> URL? {
        let fileManager = FileManager.default
        let url = directory.appendingPathComponent(filename(forKey: key))
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        touchRecency(of: url)
        return url
    }

    /// Moves a freshly decrypted file into the cache, evicting least-recently-used
    /// entries past the byte limit. Returns the cache URL, or nil if storing failed.
    public func store(_ file: URL, forKey key: String) -> URL? {
        let fileManager = FileManager.default
        let destination = directory.appendingPathComponent(filename(forKey: key))
        if fileManager.fileExists(atPath: destination.path) {
            try? fileManager.removeItem(at: file)
            touchRecency(of: destination)
            return destination
        }
        do {
            try fileManager.moveItem(at: file, to: destination)
        } catch {
            return nil
        }
        try? AttachmentFiles.protect(destination)
        trimToByteLimit()
        return destination
    }

    private func touchRecency(of url: URL) {
        var mutableURL = url
        var values = URLResourceValues()
        values.contentModificationDate = Date()
        try? mutableURL.setResourceValues(values)
    }

    private func trimToByteLimit() {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: keys
        ) else { return }
        var candidates: [(url: URL, size: Int, date: Date)] = []
        var total = 0
        for entry in entries {
            guard let values = try? entry.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true,
                  let size = values.fileSize else { continue }
            total += size
            candidates.append((entry, size, values.contentModificationDate ?? .distantPast))
        }
        guard total > Self.byteLimit else { return }
        for entry in candidates.sorted(by: { $0.date < $1.date }) {
            guard total > Self.byteLimit else { break }
            if (try? FileManager.default.removeItem(at: entry.url)) != nil {
                total -= entry.size
            }
        }
    }
}

public extension NostrDirectMessageAttachment {
    var cacheKey: String {
        "\(url)::\(keyHex)::\(nonceHex)"
    }

    var detailIcon: String {
        if isVideo { return "video.fill" }
        if isAudio { return "waveform" }
        if mimeType.lowercased().contains("pdf") { return "doc.richtext.fill" }
        return "doc.fill"
    }

    /// "PDF document · 71 KB", from the system's name for the file type.
    var kindAndSizeLabel: String {
        let kind = UTType(mimeType: mimeType)?.localizedDescription.map { $0.prefix(1).uppercased() + $0.dropFirst() }
            ?? detailKindLabel.capitalized
        guard let size else { return kind }
        return "\(kind) · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))"
    }

    var fileExtensionLabel: String {
        let fromName = filename.map { ($0 as NSString).pathExtension } ?? ""
        let value = fromName.isEmpty ? (UTType(mimeType: mimeType)?.preferredFilenameExtension ?? "") : fromName
        return String(value.uppercased().prefix(4))
    }

    var detailKindLabel: String {
        if isVideo { return "VIDEO" }
        if isAudio { return "AUDIO" }
        if mimeType.lowercased().contains("pdf") { return "PDF" }
        return "FILE"
    }
}

/// Groups a sender's back-to-back photos into one stack, the way Messages draws a batch.
public enum DirectMessagePhotoStacks {
    public struct Grouping: Equatable, Sendable {
        /// Each run of two or more photos, oldest first, keyed by its newest photo's message ID;
        /// that message draws the whole stack.
        public var stacks: [String: [NostrDirectMessage]] = [:]
        /// The earlier photos of each run, which draw nothing of their own.
        public var stackedMessageIDs: Set<String> = []
    }

    /// Photos within this long of the previous one still join its stack.
    public static let maximumGap = 120

    /// `timeline` is the conversation in display order; `nil` stands for an item that is not a
    /// message (a shared task card, say), which ends a run.
    public static func group(_ timeline: [NostrDirectMessage?]) -> Grouping {
        var grouping = Grouping()
        var run: [NostrDirectMessage] = []
        func closeRun() {
            if run.count > 1, let host = run.last {
                grouping.stacks[host.id] = run
                grouping.stackedMessageIDs.formUnion(run.dropLast().map(\.id))
            }
            run = []
        }
        for item in timeline {
            guard let message = item, message.attachment?.isImage == true else {
                closeRun()
                continue
            }
            if let previous = run.last,
               previous.senderPublicKey != message.senderPublicKey
                || previous.isIncoming != message.isIncoming
                || previous.replyToEventID != message.replyToEventID
                || message.createdAt - previous.createdAt > maximumGap {
                closeRun()
            }
            run.append(message)
        }
        closeRun()
        return grouping
    }
}

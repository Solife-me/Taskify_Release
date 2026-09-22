import AppKit
import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers

struct MacStagedFile: Identifiable {
    let id = UUID()
    let url: URL
    let name: String
    let mimeType: String
    var uploadedChat: NostrDirectMessageAttachment?
    var uploadedDocument: TaskDocument?
}

@MainActor
final class MacAttachmentQueue: ObservableObject {
    @Published private(set) var files: [MacStagedFile] = []
    @Published private(set) var importing = false
    @Published var progress: String?
    @Published var error: String?

    func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        stage(panel.urls)
    }

    func stage(_ urls: [URL]) {
        guard !importing else { return }
        guard files.count + urls.count <= NostrDirectMessageAttachment.maximumBatchCount else {
            error = "Choose up to ten attachments at a time."; return
        }
        importing = true; error = nil
        Task {
            defer { importing = false }
            do {
                for url in urls {
                    let name = url.lastPathComponent
                    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    let local = try await AttachmentFiles.work { try AttachmentFiles.importFile(url) }
                    files.append(MacStagedFile(url: local, name: name, mimeType: type))
                }
            } catch { self.error = error.localizedDescription }
        }
    }

    func remove(_ id: UUID) {
        guard let file = files.first(where: { $0.id == id }) else { return }
        try? FileManager.default.removeItem(at: file.url)
        files.removeAll { $0.id == id }
    }
    func clear() {
        files.forEach { try? FileManager.default.removeItem(at: $0.url) }
        files = []; progress = nil
    }
    func uploadChat() async throws -> [NostrDirectMessageAttachment] {
        var result: [NostrDirectMessageAttachment] = []
        for index in files.indices {
            try Task.checkCancellation()
            let file = files[index]
            if let uploaded = file.uploadedChat { result.append(uploaded); continue }
            progress = "Encrypting and uploading \(index + 1) of \(files.count)…"
            let attachment = try await TaskAttachmentUploadService.shared.uploadChatAttachment(fileURL: file.url, name: file.name, mimeType: file.mimeType)
            files[index].uploadedChat = attachment
            result.append(attachment)
        }
        return result
    }
    func uploadDocuments(boardID: String) async throws -> [TaskDocument] {
        var result: [TaskDocument] = []
        for index in files.indices {
            try Task.checkCancellation()
            let file = files[index]
            if let uploaded = file.uploadedDocument, uploaded.encryptionBoardID == boardID { result.append(uploaded); continue }
            progress = "Encrypting and uploading \(index + 1) of \(files.count)…"
            let document = try await TaskAttachmentUploadService.shared.uploadDocument(fileURL: file.url, name: file.name, mimeType: file.mimeType, boardID: boardID)
            files[index].uploadedDocument = document
            result.append(document)
        }
        return result
    }
}

struct MacAttachmentQueueView: View {
    @ObservedObject var queue: MacAttachmentQueue
    var busy = false
    var onCancel: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(queue.files) { file in
                HStack {
                    Label(file.name, systemImage: "doc").lineLimit(1)
                    Spacer()
                    Button { queue.remove(file.id) } label: { Image(systemName: "xmark.circle") }.buttonStyle(.plain).disabled(busy)
                }.font(.caption)
            }
            if queue.importing { ProgressView("Importing files…").controlSize(.small) }
            if let progress = queue.progress {
                HStack {
                    Text(progress).font(.caption).foregroundStyle(.secondary)
                    if busy, let onCancel {
                        Spacer(minLength: 8)
                        Button("Cancel", action: onCancel).font(.caption).buttonStyle(.plain).foregroundStyle(.red)
                    }
                }
            }
            if let error = queue.error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}

@MainActor
final class MacChatImageLoader: ObservableObject {
    static let shared = MacChatImageLoader()
    private var cache: [String: NSImage] = [:]
    private var inFlight: [String: Task<NSImage?, Never>] = [:]
    private init() {}

    func image(for attachment: NostrDirectMessageAttachment) async -> NSImage? {
        if let cached = cache[attachment.url] { return cached }
        if let existing = inFlight[attachment.url] { return await existing.value }
        let task = Task<NSImage?, Never> {
            guard let url = URL(string: attachment.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return nil }
            do {
                let ciphertext = try await AttachmentDownload.file(from: url)
                defer { try? FileManager.default.removeItem(at: ciphertext) }
                let file = try await AttachmentFileCrypto.decryptChat(ciphertext, attachment: attachment)
                defer { try? FileManager.default.removeItem(at: file) }
                let data = try Data(contentsOf: file, options: .alwaysMapped)
                return NSImage(data: data)
            } catch { return nil }
        }
        inFlight[attachment.url] = task
        let result = await task.value
        inFlight[attachment.url] = nil
        if let result { cache[attachment.url] = result }
        return result
    }
}

struct MacChatImageAttachment: View {
    let attachment: NostrDirectMessageAttachment
    @State private var image: NSImage?
    @State private var loaded = false
    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 240, maxHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if loaded {
                Button("Save Attachment…") { Task { try? await MacAttachmentExport.chat(attachment) } }
            } else {
                ProgressView().frame(width: 80, height: 80)
            }
        }
        .task(id: attachment.url) {
            image = await MacChatImageLoader.shared.image(for: attachment)
            loaded = true
        }
        .onTapGesture { if image != nil { Task { try? await MacAttachmentExport.chat(attachment) } } }
        .help("Click to save")
    }
}

@MainActor
enum MacAttachmentExport {
    static func document(_ document: TaskDocument, boardID: String) async throws {
        let source = document.remoteURL ?? document.dataURL
        guard let source else { throw AttachmentFileError.invalidFile }
        let file = try await taskFile(source: source, encrypted: document.encrypted == true, boardID: document.encryptionBoardID ?? boardID)
        defer { try? FileManager.default.removeItem(at: file) }
        try save(file, name: document.name)
    }
    static func image(_ source: String, boardID: String) async throws {
        let file = try await taskFile(source: source, encrypted: !source.hasPrefix("data:"), boardID: boardID)
        defer { try? FileManager.default.removeItem(at: file) }
        try save(file, name: "Taskify-image.jpg")
    }
    static func chat(_ attachment: NostrDirectMessageAttachment) async throws {
        guard let url = URL(string: attachment.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { throw URLError(.badURL) }
        let ciphertext = try await AttachmentDownload.file(from: url)
        defer { try? FileManager.default.removeItem(at: ciphertext) }
        let file = try await AttachmentFiles.work { try AttachmentFileCrypto.decryptChat(ciphertext, attachment: attachment) }
        defer { try? FileManager.default.removeItem(at: file) }
        try save(file, name: attachment.displayName)
    }
    private static func taskFile(source: String, encrypted: Bool, boardID: String) async throws -> URL {
        if source.hasPrefix("data:") { return try await AttachmentFiles.work { try AttachmentFiles.write(TaskAttachmentCrypto.data(from: source)) } }
        guard let url = URL(string: source), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { throw URLError(.badURL) }
        let downloaded = try await AttachmentDownload.file(from: url)
        guard encrypted else { return downloaded }
        defer { try? FileManager.default.removeItem(at: downloaded) }
        return try await AttachmentFiles.work { try AttachmentFileCrypto.decryptTask(downloaded, boardID: boardID) }
    }
    private static func save(_ source: URL, name: String) throws {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: name).lastPathComponent
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        // The panel grants access to the chosen file. Atomic replacement also handles an existing file.
        let data = try Data(contentsOf: source, options: .alwaysMapped)
        try data.write(to: destination, options: .atomic)
    }
}

import SwiftUI
import UIKit
import UniformTypeIdentifiers
import Intents
import TaskifyCore

@MainActor
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareComposer(context: extensionContext)
        let host = UIHostingController(rootView: ShareComposerView(model: model))
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        host.didMove(toParent: self)
    }
}

private struct SharedInput: Identifiable {
    let id = UUID()
    let file: URL
    let name: String
    let mimeType: String
    let size: Int
}

@MainActor
private final class ShareComposer: ObservableObject {
    @Published var account: ShareAccount?
    @Published var selectedID: String?
    @Published var query = ""
    @Published var text = ""
    @Published var inputs: [SharedInput] = []
    @Published var busy = true
    @Published var status = "Preparing…"
    @Published var progress: AttachmentTransferProgress?
    @Published var error: String?
    private let context: NSExtensionContext?
    private var operation: Task<Void, Never>?
    private var pendingIDs: [UUID] = []
    private var encryptingFileID: UUID?

    init(context: NSExtensionContext?) {
        self.context = context
        AttachmentFiles.purgeExpiredTemporaryFiles()
        ShareTransferStore.purgeOrphanedFiles()
        operation = Task { await load() }
    }
    private func load() async {
        defer { busy = false }
        do {
            let account = try ShareTransferStore.account()
            _ = try TaskifyShareIdentity.load(account: account.publicKey)
            self.account = account
            if let intent = context?.intent as? INSendMessageIntent,
               let id = intent.conversationIdentifier {
                selectedID = account.recipients.first { $0.suggestionID(account: account.publicKey) == id }?.id
            }
            let items = context?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
            let providers = items.flatMap { $0.attachments ?? [] }
            guard providers.count <= 10 else { throw ShareError.tooMany }
            var textParts: [String] = []
            for provider in providers {
                try Task.checkCancellation()
                let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
                let namedFile = provider.suggestedName.map { !URL(fileURLWithPath: $0).pathExtension.isEmpty } ?? false
                let type = types.first { $0.conforms(to: .image) || $0.conforms(to: .movie) || $0.conforms(to: .audio) }
                    ?? types.first { $0.conforms(to: .data) && (namedFile || !$0.conforms(to: .text)) && !$0.conforms(to: .url) }
                if let type {
                    let url = try await importFile(provider, type: type.identifier)
                    if Task.isCancelled { try? FileManager.default.removeItem(at: url); throw CancellationError() }
                    let name = provider.suggestedName.map { URL(fileURLWithPath: $0).lastPathComponent } ?? url.lastPathComponent
                    let completeName = URL(fileURLWithPath: name).pathExtension.isEmpty
                        ? "\(name).\(type.preferredFilenameExtension ?? "bin")" : name
                    inputs.append(SharedInput(file: url, name: completeName,
                        mimeType: type.preferredMIMEType ?? "application/octet-stream", size: try AttachmentFiles.size(url)))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let item = try await loadItem(provider, type: UTType.fileURL.identifier)
                    guard let source = item as? URL else { throw AttachmentFileError.invalidFile }
                    let url = try await AttachmentFiles.work { try AttachmentFiles.importFile(source) }
                    let type = UTType(filenameExtension: source.pathExtension)
                    inputs.append(SharedInput(file: url, name: source.lastPathComponent,
                        mimeType: type?.preferredMIMEType ?? "application/octet-stream", size: try AttachmentFiles.size(url)))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = try await loadItem(provider, type: UTType.url.identifier) as? URL { textParts.append(url.absoluteString) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
                    if let value = try await loadItem(provider, type: UTType.text.identifier) as? String { textParts.append(value) }
                } else { throw AttachmentFileError.invalidFile }
            }
            var seen = Set<String>()
            text = textParts.filter { seen.insert($0).inserted }.joined(separator: "\n")
            guard !inputs.isEmpty || !text.isEmpty else { throw AttachmentFileError.empty }
        } catch {
            self.error = account == nil ? "Open Taskify once to prepare sharing for your account, then try again." : error.localizedDescription
        }
    }

    private func importFile(_ provider: NSItemProvider, type: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                do {
                    if let error { throw error }
                    guard let url else { throw AttachmentFileError.invalidFile }
                    // The provider owns this URL only for the duration of its callback.
                    continuation.resume(returning: try AttachmentFiles.importFile(url))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    private func loadItem(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding? {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type) { value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
        }
    }
    func send() {
        guard !busy, let selectedID, let account,
              let recipient = account.recipients.first(where: { $0.id == selectedID }) else { return }
        busy = true; error = nil
        operation = Task { [self] in
            var ready: [(ShareTransfer, EncryptedFileUploadRequest, UUID)] = []
            do {
                let current = try ShareTransferStore.account()
                guard current.publicKey == account.publicKey,
                      current.recipients.contains(where: { $0.id == recipient.id && $0.members == recipient.members }) else { throw ShareDeliveryError.invalidRecipient }
                guard text.utf8.count <= 32_000 else { throw ShareError.textTooLong }
                let identity = try TaskifyShareIdentity.load(account: account.publicKey)
                let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
                let hasAttachments = !inputs.isEmpty
                for (index, input) in inputs.enumerated() {
                    status = "Encrypting file \(index + 1) of \(inputs.count)…"
                    // One comment for the selection, replying to its last file.
                    // It stays in that file's durable job until the parent is sent.
                    var job = ShareTransfer(account: current, recipient: recipient,
                        text: index == inputs.count - 1 ? message : nil)
                    pendingIDs.append(job.id)
                    let directory = try ShareTransferStore.directory(job.id)
                    encryptingFileID = input.id
                    let inputID = input.id
                    let reportProgress: AttachmentProgressHandler = { [weak self] progress in
                        Task { @MainActor [weak self] in
                            guard let self, self.encryptingFileID == inputID else { return }
                            self.progress = progress
                            self.status = progress.message
                        }
                    }
                    let encrypted = try await AttachmentFiles.work {
                        try AttachmentFileCrypto.encryptChat(input.file, directory: directory, progress: reportProgress)
                    }
                    encryptingFileID = nil
                    progress = .preparingUpload
                    status = "Preparing upload…"
                    try Task.checkCancellation()
                    job.filename = input.name; job.mimeType = input.mimeType; job.size = encrypted.plaintextSize
                    job.keyHex = encrypted.keyHex; job.nonceHex = encrypted.nonceHex; job.sha256 = encrypted.sha256
                    job.ciphertextName = encrypted.url.lastPathComponent
                    let prepared = try await EncryptedFileUpload.prepare(file: encrypted.url, filename: "\(encrypted.sha256).bin",
                        server: current.server, privateKey: identity.privateKey, directory: directory)
                    ready.append((job, prepared, input.id))
                }
                try Task.checkCancellation()
                progress = nil
                status = "Queueing upload…"
                for (job, request, inputID) in ready {
                    try TaskifyShareUploadSession.enqueue(job, prepared: request)
                    pendingIDs.removeAll { $0 == job.id }
                    if let input = inputs.first(where: { $0.id == inputID }) { try? FileManager.default.removeItem(at: input.file) }
                    inputs.removeAll { $0.id == inputID }
                }
                pendingIDs = [] // queued files now belong to the background transfer service
                if !hasAttachments && !message.isEmpty {
                    var job = ShareTransfer(account: current, recipient: recipient, text: message)
                    job.state = "sending"
                    try ShareTransferStore.save(job)
                    await TaskifyShareUploadSession.retry(job)
                }
                text = ""
                TaskifyShareSuggestions.donate(account: account.publicKey, recipient: recipient)
                cleanup()
                context?.completeRequest(returningItems: nil)
            } catch {
                encryptingFileID = nil
                progress = nil
                for id in pendingIDs { ShareTransferStore.remove(id) }
                pendingIDs = []
                self.error = error.localizedDescription
                busy = false
            }
        }
    }
    func remove(_ input: SharedInput) {
        guard !busy else { return }
        inputs.removeAll { $0.id == input.id }
        try? FileManager.default.removeItem(at: input.file)
    }
    func cancel() {
        operation?.cancel()
        cleanup()
        context?.cancelRequest(withError: CocoaError(.userCancelled))
    }
    private func cleanup() {
        for input in inputs { try? FileManager.default.removeItem(at: input.file) }
    }
    enum ShareError: LocalizedError {
        case tooMany, textTooLong
        var errorDescription: String? {
            switch self {
            case .tooMany: "Share up to 10 items at a time."
            case .textTooLong: "This message is too long. Share long text as a file instead."
            }
        }
    }
}

private struct ShareComposerView: View {
    @ObservedObject var model: ShareComposer
    var body: some View {
        NavigationStack {
            Form {
                if let error = model.error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    if !model.inputs.isEmpty {
                        ScrollView(.horizontal) {
                            HStack(alignment: .top, spacing: 12) {
                                ForEach(model.inputs) { input in
                                    TaskifyAttachmentDraftPreview(fileURL: input.file, name: input.name,
                                        mimeType: input.mimeType, size: input.size, isBusy: model.busy) {
                                            model.remove(input)
                                        }
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                    }
                    TextField(model.inputs.isEmpty ? "Message" : "Add comment or Send", text: $model.text, axis: .vertical)
                        .lineLimit(2...6)
                        .disabled(model.busy)
                } footer: {
                    if model.inputs.count > 1 { Text("Your comment replies to the last attachment.") }
                }
                Section("Send to") {
                    TextField("Search chats", text: $model.query).disabled(model.busy)
                    ForEach((model.account?.recipients ?? []).filter {
                        model.query.isEmpty || $0.name.localizedCaseInsensitiveContains(model.query)
                    }) { recipient in
                        Button { model.selectedID = recipient.id } label: {
                            HStack {
                                Image(systemName: recipient.isGroup ? "person.2.fill" : "person.crop.circle.fill")
                                Text(recipient.name).foregroundStyle(.primary)
                                Spacer()
                                if model.selectedID == recipient.id { Image(systemName: "checkmark.circle.fill") }
                            }
                        }.disabled(model.busy)
                    }
                    if model.account?.recipients.isEmpty == true { Text("Add a contact in Taskify to start sharing.") }
                }
                if model.busy {
                    Section {
                        HStack { ProgressView(); Text(model.status) }
                        if let fraction = model.progress?.fractionCompleted { ProgressView(value: fraction) }
                    }
                }
                Section { Text("Files are encrypted before upload. Large uploads continue in the background; Taskify retries interrupted messages when opened.").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("Taskify")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: model.cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send", action: model.send).bold()
                        .disabled(model.busy || model.selectedID == nil || (model.inputs.isEmpty && model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
        }
    }
}

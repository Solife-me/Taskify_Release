import ImageIO
import LinkPresentation
import QuickLook
import QuickLookThumbnailing
import SwiftUI
import TaskifyCore
import UIKit

struct TaskMediaView: View {
    let task: TaskItem
    let boardID: String
    var compact = false

    private var images: [String] {
        task.images?.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? []
    }

    private var documents: [TaskDocument] {
        task.documents ?? []
    }

    private var firstLink: URL? {
        TaskContentLinks.firstURL(title: task.title, note: task.note)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 7 : 10) {
            ForEach(Array(images.enumerated()), id: \.offset) { _, source in
                TaskAttachmentImageView(source: source, boardID: boardID, compact: compact)
            }

            ForEach(documents) { document in
                TaskDocumentTile(
                    document: document,
                    fallbackBoardID: boardID,
                    compact: compact
                )
            }

            if let firstLink {
                TaskLinkPreviewCard(url: firstLink, compact: compact)
            }
        }
    }
}

private struct TaskAttachmentImageView: View {
    let source: String
    let boardID: String
    let compact: Bool

    @State private var thumbnail: UIImage?
    @State private var failed = false
    @State private var showingPreview = false
    @State private var retryID = UUID()

    private var previewHeight: CGFloat { compact ? 150 : 210 }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color.white.opacity(0.07), Color.black.opacity(0.22)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            if let thumbnail {
                Button {
                    showingPreview = true
                } label: {
                    Image(uiImage: thumbnail)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .frame(height: previewHeight)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open attached image")
            } else if failed {
                Button {
                    failed = false
                    retryID = UUID()
                } label: {
                    VStack(spacing: 8) {
                        Image(systemName: "arrow.clockwise")
                            .font(.title3.weight(.semibold))
                        Text("Image unavailable · Retry")
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity, minHeight: previewHeight)
                }
                .buttonStyle(.plain)
            } else {
                VStack(spacing: 9) {
                    ProgressView()
                        .tint(TaskifyTheme.accent)
                    Text("Decrypting image")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
                .frame(maxWidth: .infinity, minHeight: previewHeight)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: previewHeight)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TaskifyTheme.border, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .task(id: retryID) {
            do {
                let data = try await TaskAttachmentDataLoader.load(
                    source: source,
                    encrypted: !source.hasPrefix("data:"),
                    boardID: boardID
                )
                guard !Task.isCancelled else { return }
                thumbnail = await TaskAttachmentThumbnailLoader.shared.image(
                    data: data,
                    cacheKey: "image::\(boardID)::\(source)",
                    maximumPixelSize: 1_080
                )
                failed = thumbnail == nil
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
            }
        }
        .sheet(isPresented: $showingPreview) {
            TaskAttachmentFullScreenImage(
                source: source,
                boardID: boardID,
                isPresented: $showingPreview
            )
        }
    }
}

private struct TaskAttachmentFullScreenImage: View {
    let source: String
    let boardID: String
    @Binding var isPresented: Bool
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .padding(12)
                    }
                } else if failed {
                    ContentUnavailableView(
                        "Image unavailable",
                        systemImage: "photo.badge.exclamationmark"
                    )
                } else {
                    ProgressView("Loading full-resolution image…")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Attachment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isPresented = false }
                }
            }
        }
        .preferredColorScheme(.dark)
        .task(id: source) {
            do {
                let data = try await TaskAttachmentDataLoader.load(
                    source: source,
                    encrypted: !source.hasPrefix("data:"),
                    boardID: boardID
                )
                guard !Task.isCancelled else { return }
                image = await TaskAttachmentThumbnailLoader.shared.fullImage(
                    data: data,
                    cacheKey: "full::\(boardID)::\(source)"
                )
                failed = image == nil
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
            }
        }
    }
}

private struct TaskDocumentTile: View {
    let document: TaskDocument
    let fallbackBoardID: String
    let compact: Bool

    @State private var isLoading = false
    @State private var derivedPreviewImage: UIImage?
    @State private var derivedPreviewText: String?
    @State private var previewURL: URL?
    @State private var alert: TaskAttachmentAlert?

    private var previewHeight: CGFloat { compact ? 160 : 190 }

    private var source: String? {
        let remote = document.remoteURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !remote.isEmpty { return remote }
        let inline = document.dataURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return inline.isEmpty ? nil : inline
    }

    var body: some View {
        Button(action: openDocument) {
            VStack(spacing: 0) {
                ZStack(alignment: .topTrailing) {
                    LinearGradient(
                        colors: [Color.white.opacity(0.085), Color.black.opacity(0.24)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )

                    if let previewImage {
                        Image(uiImage: previewImage)
                            .resizable()
                            .scaledToFill()
                            .frame(maxWidth: .infinity)
                            .frame(height: previewHeight)
                            .clipped()
                    } else if let textPreview {
                        Text(textPreview)
                            .font(.system(size: compact ? 10 : 11, design: .monospaced))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .lineLimit(compact ? 5 : 7)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .padding(13)
                    } else {
                        VStack(spacing: 9) {
                            Image(systemName: documentIcon)
                                .font(.system(size: compact ? 31 : 38, weight: .light))
                                .foregroundStyle(TaskifyTheme.accent)
                            Text(document.kind.uppercased())
                                .font(.caption2.weight(.bold))
                                .tracking(1.2)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                    }

                    if document.encrypted == true {
                        Label("Encrypted", systemImage: "lock.fill")
                            .labelStyle(.iconOnly)
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .padding(7)
                            .background(.ultraThinMaterial, in: Circle())
                            .padding(8)
                            .accessibilityLabel("Encrypted attachment")
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: previewHeight)

                if !compact {
                    HStack(spacing: 9) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(document.name)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .lineLimit(1)
                            Text(documentDetail)
                                .font(.caption2)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                        Spacer(minLength: 5)
                        if isLoading {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up.forward.app")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                    }
                    .padding(.horizontal, 11)
                    .padding(.vertical, 9)
                    .background(Color.black.opacity(0.16))
                }
            }
            .background(TaskifyTheme.panelFill)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(TaskifyTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .disabled(source == nil || isLoading)
        .task(id: document) {
            await loadThumbnailIfNeeded()
        }
        .quickLookPreview($previewURL)
        .alert(item: $alert) { alert in
            Alert(
                title: Text("Attachment unavailable"),
                message: Text(alert.message),
                dismissButton: .default(Text("OK"))
            )
        }
    }

    private var documentDetail: String {
        let kind = document.kind.uppercased()
        if let size = document.size {
            return "\(kind) · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))"
        }
        return kind
    }

    private var previewImage: UIImage? {
        derivedPreviewImage
    }

    private var textPreview: String? {
        derivedPreviewText
    }

    private var documentIcon: String {
        switch document.kind.lowercased() {
        case "pdf": "doc.richtext"
        case "png", "jpg", "jpeg", "webp", "gif": "photo"
        case "mp3", "aac", "m4a", "wav": "waveform"
        case "mp4", "mov", "webm": "video"
        case "txt", "md", "json", "csv": "doc.text"
        default: "doc"
        }
    }

    private func openDocument() {
        guard let source else { return }
        isLoading = true
        Task {
            do {
                let boardID = document.encryptionBoardID ?? fallbackBoardID
                let data = try await TaskAttachmentDataLoader.load(
                    source: source,
                    encrypted: document.encrypted == true,
                    boardID: boardID
                )
                let url = try TaskAttachmentDataLoader.previewFile(
                    data: data,
                    name: document.name,
                    documentID: document.id
                )
                guard !Task.isCancelled else { return }
                previewURL = url
            } catch {
                guard !Task.isCancelled else { return }
                alert = TaskAttachmentAlert(message: error.localizedDescription)
            }
            isLoading = false
        }
    }

    private func loadThumbnailIfNeeded() async {
        guard previewImage == nil,
              textPreview == nil else { return }

        if let embedded = document.preview {
            if embedded.type == "image",
               let data = try? TaskAttachmentCrypto.data(from: embedded.data) {
                derivedPreviewImage = await TaskAttachmentThumbnailLoader.shared.image(
                    data: data,
                    cacheKey: "document-preview::\(document.id)",
                    maximumPixelSize: 1_080
                )
                if derivedPreviewImage != nil { return }
            } else if embedded.type == "text" || embedded.type == "html" {
                derivedPreviewText = await Task.detached(priority: .utility) {
                    let raw = embedded.type == "html"
                        ? embedded.data.replacingOccurrences(
                            of: #"<[^>]+>"#,
                            with: " ",
                            options: .regularExpression
                        )
                        : embedded.data
                    let normalized = raw
                        .split(whereSeparator: \.isWhitespace)
                        .joined(separator: " ")
                    return normalized.isEmpty ? nil : normalized
                }.value
                if derivedPreviewText != nil { return }
            }
        }

        guard let source else { return }
        do {
            let boardID = document.encryptionBoardID ?? fallbackBoardID
            let data = try await TaskAttachmentDataLoader.load(
                source: source,
                encrypted: document.encrypted == true,
                boardID: boardID
            )
            guard !Task.isCancelled else { return }

            let kind = document.kind.lowercased()
            if ["png", "jpg", "jpeg", "webp", "gif"].contains(kind) {
                derivedPreviewImage = await TaskAttachmentThumbnailLoader.shared.image(
                    data: data,
                    cacheKey: "document::\(document.id)::\(source)",
                    maximumPixelSize: 1_080
                )
                if derivedPreviewImage != nil { return }
            }

            if ["txt", "md", "json", "csv"].contains(kind),
               let text = String(data: data.prefix(24_000), encoding: .utf8) {
                let normalized = await Task.detached(priority: .utility) {
                    text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                }.value
                if !normalized.isEmpty {
                    derivedPreviewText = normalized
                    return
                }
            }

            let fileURL = try TaskAttachmentDataLoader.previewFile(
                data: data,
                name: document.name,
                documentID: document.id
            )
            guard !Task.isCancelled else { return }
            derivedPreviewImage = await quickLookThumbnail(for: fileURL)
        } catch {
            return
        }
    }

    private func quickLookThumbnail(for fileURL: URL) async -> UIImage? {
        let scale = await MainActor.run { UIScreen.main.scale }
        let request = QLThumbnailGenerator.Request(
            fileAt: fileURL,
            size: CGSize(width: 640, height: 800),
            scale: scale,
            representationTypes: .all
        )
        return await withCheckedContinuation { continuation in
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, _ in
                continuation.resume(returning: representation?.uiImage)
            }
        }
    }
}

private struct TaskAttachmentAlert: Identifiable {
    let id = UUID()
    let message: String
}

@MainActor
private final class TaskLinkPreviewModel: ObservableObject {
    @Published var metadata: LPLinkMetadata?
    @Published var previewImage: UIImage?
    @Published var iconImage: UIImage?
    @Published var isLoading = false

    private var provider: LPMetadataProvider?
    private static let metadataCache = NSCache<NSURL, LPLinkMetadata>()
    private static let previewImageCache = NSCache<NSURL, UIImage>()
    private static let iconImageCache = NSCache<NSURL, UIImage>()

    func load(_ url: URL) async {
        guard metadata == nil, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        if let cached = Self.metadataCache.object(forKey: url as NSURL) {
            metadata = cached
            await loadArtwork(from: cached, for: url)
            return
        }

        let provider = LPMetadataProvider()
        provider.timeout = 12
        self.provider = provider
        defer { self.provider = nil }
        do {
            let value = try await provider.startFetchingMetadata(for: url)
            guard !Task.isCancelled else { return }
            metadata = value
            Self.metadataCache.setObject(value, forKey: url as NSURL)
            await loadArtwork(from: value, for: url)
        } catch {
            return
        }
    }

    private func loadArtwork(from metadata: LPLinkMetadata, for url: URL) async {
        if let cached = Self.previewImageCache.object(forKey: url as NSURL) {
            previewImage = cached
        } else if let image = await loadImage(from: metadata.imageProvider) {
            guard !Task.isCancelled else { return }
            previewImage = image
            Self.previewImageCache.setObject(image, forKey: url as NSURL)
        }

        guard previewImage == nil else { return }
        if let cached = Self.iconImageCache.object(forKey: url as NSURL) {
            iconImage = cached
        } else if let icon = await loadImage(from: metadata.iconProvider) {
            guard !Task.isCancelled else { return }
            iconImage = icon
            Self.iconImageCache.setObject(icon, forKey: url as NSURL)
        }
    }

    private func loadImage(from provider: NSItemProvider?) async -> UIImage? {
        guard let provider, provider.canLoadObject(ofClass: UIImage.self) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadObject(ofClass: UIImage.self) { object, _ in
                continuation.resume(returning: object as? UIImage)
            }
        }
    }

    deinit {
        provider?.cancel()
    }
}

private struct TaskLinkPreviewCard: View {
    let url: URL
    let compact: Bool
    @StateObject private var model = TaskLinkPreviewModel()

    private var destination: URL {
        model.metadata?.url ?? model.metadata?.originalURL ?? url
    }

    private var title: String {
        let metadataTitle = model.metadata?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return metadataTitle.isEmpty ? TaskContentLinks.fallbackTitle(for: destination) : metadataTitle
    }

    private var siteLabel: String {
        (destination.host(percentEncoded: false) ?? url.host(percentEncoded: false) ?? "Link")
            .replacingOccurrences(of: "www.", with: "", options: [.anchored, .caseInsensitive])
    }

    var body: some View {
        Link(destination: destination) {
            VStack(spacing: 0) {
                if let image = model.previewImage {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity)
                        .frame(height: compact ? 116 : 154)
                        .clipped()

                    linkCopy
                        .padding(11)
                        .background(Color.black.opacity(0.15))
                } else {
                    HStack(spacing: 11) {
                        Group {
                            if let icon = model.iconImage {
                                Image(uiImage: icon)
                                    .resizable()
                                    .scaledToFit()
                                    .padding(7)
                            } else {
                                Image(systemName: "link")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(TaskifyTheme.accent)
                            }
                        }
                        .frame(width: 42, height: 42)
                        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 11))

                        linkCopy

                        if model.isLoading {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                    }
                    .padding(11)
                }
            }
            .background(
                LinearGradient(
                    colors: [Color.white.opacity(0.075), Color.black.opacity(0.2)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(TaskifyTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityLabel("Open link: \(title)")
        .task(id: url) {
            await model.load(url)
        }
    }

    private var linkCopy: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TaskifyTheme.primaryText)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(siteLabel.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(TaskifyTheme.tertiaryText)
                .lineLimit(1)
        }
    }
}

private actor TaskAttachmentThumbnailLoader {
    static let shared = TaskAttachmentThumbnailLoader()

    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 96 * 1_024 * 1_024
        return cache
    }()

    func image(
        data: Data,
        cacheKey: String,
        maximumPixelSize: CGFloat
    ) async -> UIImage? {
        let key = "\(Int(maximumPixelSize))::\(cacheKey)" as NSString
        if let cached = cache.object(forKey: key) { return cached }

        let image = await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                return nil as UIImage?
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                options as CFDictionary
            ) else {
                return nil
            }
            return UIImage(cgImage: thumbnail)
        }.value
        guard let image else { return nil }
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        cache.setObject(image, forKey: key, cost: cost)
        return image
    }

    func fullImage(data: Data, cacheKey: String) async -> UIImage? {
        let key = cacheKey as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let image = await Task.detached(priority: .userInitiated) {
            UIImage(data: data)?.preparingForDisplay()
        }.value
        guard let image else { return nil }
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        cache.setObject(image, forKey: key, cost: cost)
        return image
    }
}

private enum TaskAttachmentDataLoader {
    private static let cache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.totalCostLimit = 64 * 1_024 * 1_024
        return cache
    }()
    private static let maximumDownloadSize = 50 * 1_024 * 1_024

    static func load(source: String, encrypted: Bool, boardID: String) async throws -> Data {
        if source.hasPrefix("data:") {
            return try TaskAttachmentCrypto.data(from: source)
        }

        let cacheKey = "\(encrypted ? "encrypted" : "plain")::\(boardID)::\(source)" as NSString
        if let cached = cache.object(forKey: cacheKey) {
            return cached as Data
        }

        guard let url = URL(string: source),
              url.scheme?.lowercased() == "https" || url.scheme?.lowercased() == "http" else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        request.cachePolicy = .returnCacheDataElseLoad
        let (downloaded, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse,
              (200...299).contains(response.statusCode) else {
            throw URLError(.badServerResponse)
        }
        guard downloaded.count <= maximumDownloadSize else {
            throw TaskAttachmentLoadingError.tooLarge
        }

        let resolved = encrypted
            ? try TaskAttachmentCrypto.decrypt(downloaded, boardID: boardID)
            : downloaded
        cache.setObject(resolved as NSData, forKey: cacheKey, cost: resolved.count)
        return resolved
    }

    static func previewFile(data: Data, name: String, documentID: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TaskifyAttachmentPreviews", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = name.replacingOccurrences(
            of: #"[^A-Za-z0-9._-]"#,
            with: "_",
            options: .regularExpression
        )
        let safeID = documentID.replacingOccurrences(
            of: #"[^A-Za-z0-9_-]"#,
            with: "_",
            options: .regularExpression
        )
        let fileURL = directory.appendingPathComponent("\(safeID)-\(safeName.isEmpty ? "attachment" : safeName)")
        try data.write(to: fileURL, options: .atomic)
        return fileURL
    }
}

private enum TaskAttachmentLoadingError: LocalizedError {
    case tooLarge

    var errorDescription: String? {
        "This attachment is larger than the native preview limit."
    }
}

import AppKit
import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers

/// Chat attachments drawn the way Messages draws them, matching the iPhone app: a photo is the
/// bubble itself, a sender's back-to-back photos collapse into a stack, and files and audio sit
/// in the thread as neutral cards rather than inside a colored message bubble.
enum MacChatAttachmentStyle {
    static let cardFill = Color(nsColor: .controlBackgroundColor)
    static let cornerRadius: CGFloat = 16
    static let photoWidth: CGFloat = 240
}

/// Decoded chat images, from the shared decrypted-attachment cache.
@MainActor
final class MacChatImageLoader {
    static let shared = MacChatImageLoader()
    private let cache = NSCache<NSString, NSImage>()
    private init() { cache.countLimit = 120 }

    func image(for attachment: NostrDirectMessageAttachment) async -> NSImage? {
        if let cached = cache.object(forKey: attachment.cacheKey as NSString) { return cached }
        guard let file = try? await DirectMessageAttachmentDataLoader.shared.file(for: attachment),
              let image = NSImage(contentsOf: file) else { return nil }
        cache.setObject(image, forKey: attachment.cacheKey as NSString)
        return image
    }
}

/// A chat image scaled to fill its frame, with loading and retry states.
struct MacChatPhoto: View {
    let attachment: NostrDirectMessageAttachment
    @State private var image: NSImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        ZStack {
            Rectangle().fill(Color.secondary.opacity(0.12))
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
            } else if failed {
                Button { attempt += 1 } label: {
                    Label("Photo unavailable · Retry", systemImage: "arrow.clockwise").font(.caption)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .task(id: "\(attachment.cacheKey)#\(attempt)") {
            failed = false
            image = await MacChatImageLoader.shared.image(for: attachment)
            failed = image == nil
        }
        .accessibilityLabel(attachment.displayName)
    }
}

/// A single photo: the image is the bubble. Clicking opens it in the default viewer.
struct MacChatPhotoBubble: View {
    let attachment: NostrDirectMessageAttachment
    var reportError: (String) -> Void

    private var height: CGFloat {
        guard let width = attachment.width, let height = attachment.height, width > 0 else { return 280 }
        return min(320, max(150, MacChatAttachmentStyle.photoWidth * CGFloat(height) / CGFloat(width)))
    }

    var body: some View {
        MacChatPhoto(attachment: attachment)
            .frame(width: MacChatAttachmentStyle.photoWidth, height: height)
            .clipShape(RoundedRectangle(cornerRadius: MacChatAttachmentStyle.cornerRadius, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: MacChatAttachmentStyle.cornerRadius, style: .continuous))
            .onTapGesture { MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.open(attachment) } }
            .help("Click to open")
    }
}

/// Up to three of a sender's consecutive photos fanned into an overlapping stack; clicking it
/// shows every photo.
struct MacChatPhotoStack: View {
    let attachments: [NostrDirectMessageAttachment]
    var reportError: (String) -> Void
    @State private var showingGallery = false

    private static let maximumVisible = 3
    private static let cardSize = CGSize(width: 172, height: 214)
    private static let step = CGSize(width: 34, height: 42)

    var body: some View {
        let visible = Array(attachments.prefix(Self.maximumVisible))
        let layers = CGFloat(visible.count - 1)
        ZStack(alignment: .topLeading) {
            ForEach(Array(visible.enumerated()), id: \.element.cacheKey) { index, attachment in
                MacChatPhoto(attachment: attachment)
                    .frame(width: Self.cardSize.width, height: Self.cardSize.height)
                    .clipShape(RoundedRectangle(cornerRadius: MacChatAttachmentStyle.cornerRadius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: MacChatAttachmentStyle.cornerRadius, style: .continuous)
                            .stroke(Color.black.opacity(0.3), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.25), radius: 4, y: 2)
                    .offset(x: Self.step.width * CGFloat(index), y: Self.step.height * CGFloat(index))
            }
        }
        .frame(
            width: Self.cardSize.width + Self.step.width * layers,
            height: Self.cardSize.height + Self.step.height * layers,
            alignment: .topLeading
        )
        .overlay(alignment: .bottomTrailing) {
            if attachments.count > Self.maximumVisible {
                Text("+\(attachments.count - Self.maximumVisible)")
                    .font(.caption.weight(.bold)).foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(.black.opacity(0.55), in: Capsule())
                    .padding(8)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { showingGallery = true }
        .help("Show all \(attachments.count) photos")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(attachments.count) photos")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { showingGallery = true }
        .sheet(isPresented: $showingGallery) {
            MacChatPhotoGallery(attachments: attachments, reportError: reportError)
        }
    }
}

struct MacChatPhotoGallery: View {
    let attachments: [NostrDirectMessageAttachment]
    var reportError: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(attachments.count) Photos").font(.headline)
                Spacer()
                Menu { MacChatAttachmentMenu(attachments: attachments, reportError: reportError) } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .menuStyle(.borderlessButton).fixedSize()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(14)
            Divider()
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 6)], spacing: 6) {
                    ForEach(attachments, id: \.cacheKey) { attachment in
                        MacChatPhoto(attachment: attachment)
                            .frame(height: 160)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .contentShape(Rectangle())
                            .onTapGesture {
                                MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.open(attachment) }
                            }
                            .contextMenu { MacChatAttachmentMenu(attachments: [attachment], reportError: reportError) }
                    }
                }
                .padding(10)
            }
        }
        .frame(minWidth: 520, minHeight: 420)
    }
}

/// A file sits in the thread as its own card, the same for sent and received files: click to
/// open it, or save it with the button.
struct MacChatFileRow: View {
    let attachment: NostrDirectMessageAttachment
    var reportError: (String) -> Void
    @State private var isOpening = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottom) {
                Image(systemName: "doc.fill").font(.system(size: 34)).foregroundStyle(Color.white.opacity(0.92))
                if isOpening {
                    ProgressView().controlSize(.mini).padding(.bottom, 8)
                } else {
                    Text(attachment.fileExtensionLabel)
                        .font(.system(size: 7, weight: .bold)).foregroundStyle(.gray)
                        .padding(.bottom, 5)
                }
            }
            .frame(width: 32, height: 40)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.displayName).font(.callout.weight(.semibold)).lineLimit(2)
                Text(attachment.kindAndSizeLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.save([attachment]) }
            } label: {
                Image(systemName: "square.and.arrow.down").frame(width: 28, height: 28)
                    .background(Color.primary.opacity(0.08), in: Circle())
            }
            .buttonStyle(.plain)
            .help("Save \(attachment.displayName)…")
            .accessibilityLabel("Save \(attachment.displayName)")
        }
        .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 10)
        .frame(width: 270)
        .background(MacChatAttachmentStyle.cardFill, in: RoundedRectangle(cornerRadius: MacChatAttachmentStyle.cornerRadius, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: MacChatAttachmentStyle.cornerRadius, style: .continuous))
        .onTapGesture {
            guard !isOpening else { return }
            isOpening = true
            MacChatAttachmentExport.run(reportError) {
                defer { isOpening = false }
                try await MacChatAttachmentExport.open(attachment)
            }
        }
        .help("Click to open")
    }
}

/// The round save button Messages puts beside incoming photos.
struct MacChatPhotoSaveButton: View {
    let attachments: [NostrDirectMessageAttachment]
    var reportError: (String) -> Void

    var body: some View {
        Button {
            MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.save(attachments) }
        } label: {
            Image(systemName: "square.and.arrow.down")
                .foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30)
                .background(MacChatAttachmentStyle.cardFill, in: Circle())
        }
        .buttonStyle(.plain)
        .help(attachments.count > 1 ? "Save \(attachments.count) Photos…" : "Save Photo…")
        .accessibilityLabel(attachments.count > 1 ? "Save \(attachments.count) photos" : "Save photo")
    }
}

/// Save, share and open actions for a message's attachments, for its context menu. Every file
/// type, audio included, can be saved.
struct MacChatAttachmentMenu: View {
    let attachments: [NostrDirectMessageAttachment]
    var reportError: (String) -> Void

    var body: some View {
        if attachments.count == 1, let attachment = attachments.first {
            Button("Open") { MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.open(attachment) } }
            if attachment.isImage {
                Button("Copy Image") {
                    MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.copyImage(attachment) }
                }
            }
        }
        Button(attachments.count > 1 ? "Save \(attachments.count) Files…" : "Save…") {
            MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.save(attachments) }
        }
        Button("Share…") { MacChatAttachmentExport.run(reportError) { try await MacChatAttachmentExport.share(attachments) } }
    }
}

/// Moves decrypted attachments out of the app. Each action works on a copy named after the
/// attachment, so the result keeps its filename and extension rather than the cache's name.
@MainActor
enum MacChatAttachmentExport {
    static func run(_ reportError: @escaping (String) -> Void, _ action: @escaping @MainActor () async throws -> Void) {
        Task { @MainActor in
            do { try await action() }
            catch is CancellationError {}
            catch { reportError(error.localizedDescription) }
        }
    }

    static func open(_ attachment: NostrDirectMessageAttachment) async throws {
        let file = try await namedFiles([attachment])[0]
        NSWorkspace.shared.open(file)
    }

    static func copyImage(_ attachment: NostrDirectMessageAttachment) async throws {
        let file = try await DirectMessageAttachmentDataLoader.shared.file(for: attachment)
        guard let image = NSImage(contentsOf: file) else { throw AttachmentFileError.invalidFile }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([image])
    }

    /// One file goes through a save panel; several go into a chosen folder.
    static func save(_ attachments: [NostrDirectMessageAttachment]) async throws {
        let files = try await namedFiles(attachments)
        defer { files.forEach { try? FileManager.default.removeItem(at: $0) } }
        if files.count == 1, let file = files.first {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = file.lastPathComponent
            guard panel.runModal() == .OK, let destination = panel.url else { return }
            try copy(file, to: destination)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Save"
        panel.message = "Choose a folder for \(files.count) files"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        for file in files {
            try copy(file, to: uniqueURL(in: folder, name: file.lastPathComponent))
        }
    }

    static func share(_ attachments: [NostrDirectMessageAttachment]) async throws {
        let files = try await namedFiles(attachments)
        guard let window = NSApp.keyWindow, let view = window.contentView else { return }
        let point = view.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        NSSharingServicePicker(items: files).show(
            relativeTo: NSRect(origin: point, size: CGSize(width: 1, height: 1)),
            of: view,
            preferredEdge: .minY
        )
    }

    private static func namedFiles(_ attachments: [NostrDirectMessageAttachment]) async throws -> [URL] {
        var files: [URL] = []
        for attachment in attachments {
            let file = try await DirectMessageAttachmentDataLoader.shared.file(for: attachment)
            try Task.checkCancellation()
            files.append(try DirectMessageAttachmentDataLoader.previewFile(file: file, attachment: attachment))
        }
        return files
    }

    private static func copy(_ source: URL, to destination: URL) throws {
        // The panel grants access to the chosen location; atomic replacement handles an existing file.
        let data = try Data(contentsOf: source, options: .alwaysMapped)
        try data.write(to: destination, options: .atomic)
    }

    private static func uniqueURL(in folder: URL, name: String) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var index = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(index)" : "\(base) \(index).\(ext)")
            index += 1
        }
        return candidate
    }
}

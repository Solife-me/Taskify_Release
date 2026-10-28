import Photos
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers

/// Attachments render the way Messages draws them: a photo is the bubble itself, and files and
/// audio sit in the thread as neutral cards rather than inside a colored message bubble.
enum DirectMessageAttachmentStyle {
    /// The incoming bubble's gray, shared by every attachment card in both directions so a
    /// file never reads as text in the sender's accent color.
    static let cardFill = Color(red: 44 / 255, green: 44 / 255, blue: 48 / 255).opacity(0.98)
    static let cornerRadius: CGFloat = 18
    static let photoWidth: CGFloat = 240
}

/// Up to three of a sender's consecutive photos fanned into an overlapping stack. Tapping it
/// opens every photo in a grid.
struct DirectMessagePhotoStack: View {
    let attachments: [NostrDirectMessageAttachment]
    @State private var showingGallery = false

    private static let maximumVisible = 3
    private static let cardSize = CGSize(width: 172, height: 214)
    private static let step = CGSize(width: 34, height: 42)

    private var visible: [NostrDirectMessageAttachment] {
        Array(attachments.prefix(Self.maximumVisible))
    }

    var body: some View {
        let layers = CGFloat(visible.count - 1)
        Button { showingGallery = true } label: {
            ZStack(alignment: .topLeading) {
                ForEach(Array(visible.enumerated()), id: \.element.cacheKey) { index, attachment in
                    DirectMessageAttachmentThumbnail(attachment: attachment, maximumPixelSize: 640)
                        .frame(width: Self.cardSize.width, height: Self.cardSize.height)
                        .clipShape(RoundedRectangle(cornerRadius: DirectMessageAttachmentStyle.cornerRadius, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: DirectMessageAttachmentStyle.cornerRadius, style: .continuous)
                                .stroke(Color.black.opacity(0.35), lineWidth: 1)
                        )
                        .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
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
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.black.opacity(0.55), in: Capsule())
                        .padding(8)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(attachments.count) photos")
        .accessibilityHint("Opens all photos")
        .sheet(isPresented: $showingGallery) {
            DirectMessagePhotoGallery(attachments: attachments)
        }
    }
}

/// Every photo of a stack in a grid; each tile opens full screen.
struct DirectMessagePhotoGallery: View {
    let attachments: [NostrDirectMessageAttachment]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(
                    columns: [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)],
                    spacing: 4
                ) {
                    ForEach(attachments, id: \.cacheKey) { attachment in
                        DirectMessageAttachmentView(attachment: attachment, compact: true)
                            .contextMenu {
                                DirectMessageAttachmentMenuItems(attachments: [attachment])
                            }
                    }
                }
                .padding(4)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("\(attachments.count) Photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        DirectMessageAttachmentMenuItems(attachments: attachments)
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Save or share all photos")
                }
            }
        }
        .presentationDragIndicator(.visible)
    }
}

/// Decrypts an image attachment and draws it scaled to fill, with loading and retry states.
struct DirectMessageAttachmentThumbnail: View {
    let attachment: NostrDirectMessageAttachment
    var maximumPixelSize: CGFloat = 1_080

    @State private var image: UIImage?
    @State private var failed = false
    @State private var retryID = UUID()

    var body: some View {
        ZStack {
            Rectangle().fill(Color.white.opacity(0.06))
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            } else if failed {
                Button { retryID = UUID() } label: {
                    VStack(spacing: 6) {
                        Image(systemName: "arrow.clockwise").font(.title3.weight(.semibold))
                        Text("Photo unavailable · Retry").font(.caption.weight(.medium))
                    }
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .padding(10)
                }
                .buttonStyle(.plain)
            } else {
                ProgressView()
            }
        }
        .task(id: retryID) { await load() }
        .accessibilityLabel(attachment.displayName)
    }

    @MainActor
    private func load() async {
        failed = false
        do {
            let file = try await DirectMessageAttachmentDataLoader.shared.file(for: attachment)
            guard !Task.isCancelled else { return }
            guard let decoded = await DirectMessageAttachmentImageLoader.shared.image(
                fileURL: file,
                cacheKey: attachment.cacheKey,
                maximumPixelSize: maximumPixelSize
            ) else { throw ChatAttachmentError.unreadableFile }
            image = decoded
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }
}

/// The round save button Messages puts beside incoming photos.
struct DirectMessagePhotoSaveButton: View {
    let attachments: [NostrDirectMessageAttachment]
    @Environment(AppModel.self) private var model
    @State private var isSaving = false
    @State private var saved = false

    var body: some View {
        Button {
            guard !isSaving else { return }
            isSaving = true
            Task { @MainActor in
                defer { isSaving = false }
                do {
                    try await DirectMessageAttachmentExport.saveToPhotos(attachments)
                    saved = true
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                } catch {
                    model.errorMessage = error.localizedDescription
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                }
            }
        } label: {
            ZStack {
                if isSaving {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: saved ? "checkmark" : "square.and.arrow.down")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.accent)
                }
            }
            .frame(width: 36, height: 36)
            .background(DirectMessageAttachmentStyle.cardFill, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(attachments.count > 1 ? "Save \(attachments.count) photos" : "Save photo")
    }
}

/// Save and share actions for a message's attachments, shown in its long-press menu. Every file
/// type, audio included, can be saved to Files or shared; photos and videos can also go straight
/// to the photo library.
struct DirectMessageAttachmentMenuItems: View {
    let attachments: [NostrDirectMessageAttachment]
    @Environment(AppModel.self) private var model

    private var areAllMedia: Bool {
        !attachments.isEmpty && attachments.allSatisfy { $0.isImage || $0.isVideo }
    }

    var body: some View {
        if areAllMedia {
            Button(
                attachments.count > 1 ? "Save \(attachments.count) to Photos" : "Save to Photos",
                systemImage: "photo.badge.arrow.down"
            ) {
                run { try await DirectMessageAttachmentExport.saveToPhotos(attachments) }
            }
        }
        if attachments.count == 1, let image = attachments.first, image.isImage {
            Button("Copy", systemImage: "doc.on.doc") {
                run { try await DirectMessageAttachmentExport.copyImage(image) }
            }
        }
        Button("Save to Files", systemImage: "folder") {
            run { try await DirectMessageAttachmentExport.saveToFiles(attachments) }
        }
        Button("Share…", systemImage: "square.and.arrow.up") {
            run { try await DirectMessageAttachmentExport.share(attachments) }
        }
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        Task { @MainActor in
            do {
                try await action()
            } catch is CancellationError {
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }
}

/// Moves decrypted attachments out of the app: to Files, the photo library, the pasteboard or the
/// share sheet. Each export works on a copy named after the attachment, so the saved file keeps
/// its filename and extension rather than the cache's hashed name.
@MainActor
enum DirectMessageAttachmentExport {
    enum ExportError: LocalizedError {
        case photoAccessDenied, notAnImage
        var errorDescription: String? {
            switch self {
            case .photoAccessDenied:
                "Taskify needs permission to add to your photo library. You can allow it in Settings."
            case .notAnImage: "This photo couldn't be read."
            }
        }
    }

    static func saveToFiles(_ attachments: [NostrDirectMessageAttachment]) async throws {
        let files = try await namedFiles(attachments)
        present(UIDocumentPickerViewController(forExporting: files, asCopy: true))
    }

    static func share(_ attachments: [NostrDirectMessageAttachment]) async throws {
        let files = try await namedFiles(attachments)
        present(UIActivityViewController(activityItems: files, applicationActivities: nil))
    }

    static func copyImage(_ attachment: NostrDirectMessageAttachment) async throws {
        let file = try await DirectMessageAttachmentDataLoader.shared.file(for: attachment)
        guard let image = UIImage(contentsOfFile: file.path) else { throw ExportError.notAnImage }
        UIPasteboard.general.image = image
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func saveToPhotos(_ attachments: [NostrDirectMessageAttachment]) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw ExportError.photoAccessDenied }
        let files = try await namedFiles(attachments)
        let resources = zip(files, attachments).map { file, attachment in
            (file, attachment.isVideo ? PHAssetResourceType.video : .photo, attachment.displayName,
             UTType(mimeType: attachment.mimeType)?.identifier)
        }
        try await PHPhotoLibrary.shared().performChanges {
            for (file, type, name, typeIdentifier) in resources {
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = name
                options.uniformTypeIdentifier = typeIdentifier
                PHAssetCreationRequest.forAsset().addResource(with: type, fileURL: file, options: options)
            }
        }
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

    private static func present(_ controller: UIViewController) {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
            var top = scene.keyWindow?.rootViewController else { return }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        if let popover = controller.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        top.present(controller, animated: true)
    }
}

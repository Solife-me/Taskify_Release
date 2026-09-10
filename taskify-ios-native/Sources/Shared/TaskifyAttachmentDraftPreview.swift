import ImageIO
import SwiftUI
import UIKit

/// A small local preview shared by the chat composer and the share extension.
/// ImageIO downsamples from disk so even large photos do not load in full.
struct TaskifyAttachmentDraftPreview: View {
    let fileURL: URL
    let name: String
    let mimeType: String
    let size: Int
    var isBusy = false
    let onRemove: () -> Void
    @State private var thumbnail: UIImage?

    private var symbol: String {
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType.hasPrefix("video/") { return "video" }
        if mimeType.hasPrefix("audio/") { return "waveform" }
        return "doc.fill"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ZStack(alignment: .topTrailing) {
                Group {
                    if let thumbnail {
                        Image(uiImage: thumbnail).resizable().scaledToFit()
                    } else {
                        Image(systemName: symbol).font(.system(size: 36)).foregroundStyle(.secondary)
                    }
                }
                .frame(width: 132, height: 142)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityHidden(true)
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold))
                        .frame(width: 28, height: 28)
                        .background(.regularMaterial, in: Circle())
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityLabel("Remove \(name)")
            }
            Text(name).font(.caption).lineLimit(1)
            Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(width: 132, alignment: .leading)
        .task(id: fileURL) {
            thumbnail = nil
            guard mimeType.hasPrefix("image/") else { return }
            let url = fileURL
            let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                guard let source = CGImageSourceCreateWithURL(url as CFURL,
                    [kCGImageSourceShouldCache: false] as CFDictionary),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 420,
                        kCGImageSourceShouldCacheImmediately: true,
                      ] as CFDictionary) else { return nil }
                return UIImage(cgImage: image)
            }.value
            if !Task.isCancelled { thumbnail = image }
        }
    }
}

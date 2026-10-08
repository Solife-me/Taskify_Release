#if os(iOS)
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import TaskifyCore
import UIKit

private enum CashuQRCodeRenderer {
    /// Shared renderer is deliberately outside the SwiftUI view type so frame rasterization can
    /// remain off the main actor without inheriting `View`'s actor isolation.
    static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    static func image(for value: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let transformed = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cgImage = ciContext.createCGImage(transformed, from: transformed.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

struct CashuQRCodeView: View {
    let value: String
    let accessibilityLabel: String
    private let frames: [String]
    @State private var frameIndex = 0
    @State private var renderedFrames: [UIImage] = []
    @State private var singleImage: UIImage?

    init(value: String, accessibilityLabel: String = "Cashu token QR code") {
        self.value = value
        self.accessibilityLabel = accessibilityLabel
        frames = CashuAnimatedQRAnimation(token: value)?.frames ?? []
    }

    private var displayedImage: UIImage? {
        guard !renderedFrames.isEmpty else { return singleImage }
        return renderedFrames[min(frameIndex, renderedFrames.count - 1)]
    }

    var body: some View {
        VStack(spacing: 9) {
            Group {
                if let image = displayedImage {
                    Image(uiImage: image)
                        .resizable()
                        .interpolation(.none)
                        .scaledToFit()
                } else {
                    ContentUnavailableView("Payment detail is too large for a QR code", systemImage: "qrcode")
                        .foregroundStyle(Color.black)
                }
            }
            .aspectRatio(1, contentMode: .fit)

            if frames.count > 1 {
                HStack(spacing: 6) {
                    Image(systemName: "qrcode")
                    Text("Animated QR")
                    Text("\(frameIndex + 1)/\(frames.count)")
                        .monospacedDigit()
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.black.opacity(0.68))
            }
        }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(frames.count > 1 ? "Animated frame \(frameIndex + 1) of \(frames.count)" : "")
        .task(id: value) {
            frameIndex = 0
            renderedFrames = []

            guard frames.count > 1 else {
                singleImage = CashuQRCodeRenderer.image(for: value)
                return
            }

            // Rasterise every frame before playback starts, off the main actor. Generating them
            // mid-animation made the cadence depend on how long each QR took to draw.
            let source = frames
            let rendered = await Task.detached(priority: .userInitiated) {
                source.compactMap { CashuQRCodeRenderer.image(for: $0) }
            }.value
            guard !Task.isCancelled, rendered.count == source.count else { return }
            renderedFrames = rendered

            // ~7fps. Fast enough to get through a long token quickly, slow enough that a camera
            // still gets a clean read of each frame.
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(140))
                guard !Task.isCancelled else { return }
                frameIndex = (frameIndex + 1) % rendered.count
            }
        }
    }
}
#endif

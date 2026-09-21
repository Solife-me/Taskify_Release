import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

enum MacQRCode {
    private static let context = CIContext()

    static func image(for value: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let transformed = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cgImage = context.createCGImage(transformed, from: transformed.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: transformed.extent.width, height: transformed.extent.height))
    }
}

struct MacQRCodeView: View {
    let value: String
    var label = "QR code"
    var body: some View {
        Group {
            if let image = MacQRCode.image(for: value) {
                Image(nsImage: image).resizable().interpolation(.none).scaledToFit()
            } else {
                ContentUnavailableView("Too large for a QR code", systemImage: "qrcode")
            }
        }
        .frame(width: 200, height: 200)
        .padding(10)
        .background(.white, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel(label)
    }
}

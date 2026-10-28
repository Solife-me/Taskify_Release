import AVFoundation
import CoreText
import Foundation
import ImageIO
import TaskifyCore
import UniformTypeIdentifiers

struct BoardTemplateShareResult: Sendable {
    let board: Board
    let queuedTaskCount: Int
    let failedTaskCount: Int
    let queuedEventCount: Int
    let failedEventCount: Int
}

enum BoardTemplateShareError: LocalizedError {
    case boardUnavailable
    case unsupportedBoard

    var errorDescription: String? {
        switch self {
        case .boardUnavailable:
            "That board is no longer available."
        case .unsupportedBoard:
            "Template sharing currently supports week and list boards."
        }
    }
}

struct SharedTaskSendResult: Sendable {
    let recipientNpub: String
    let relayCount: Int
    let assignment: Bool
}

enum NostrContactDirectoryError: LocalizedError {
    case identityUnavailable
    case invalidPublicKey
    case cannotAddSelf
    case noRelays
    case contactUnavailable

    var errorDescription: String? {
        switch self {
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidPublicKey: "Enter a valid npub or 64-character public key."
        case .cannotAddSelf: "Your own Nostr account does not need to be added as a contact."
        case .noRelays: "No Nostr relays are configured for contact sync."
        case .contactUnavailable: "That contact is no longer available."
        }
    }
}

enum ProfilePictureUploadError: LocalizedError {
    case invalidServer

    var errorDescription: String? {
        switch self {
        case .invalidServer: "The configured file server URL is invalid."
        }
    }
}

enum SharedTaskSendError: LocalizedError {
    case taskUnavailable
    case eventUnavailable
    case identityUnavailable
    case invalidRecipient
    case cannotSendToSelf
    case noRelays

    var errorDescription: String? {
        switch self {
        case .taskUnavailable: "That task is no longer available."
        case .eventUnavailable: "That event is not available for sharing."
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "Enter a valid npub or 64-character public key."
        case .cannotSendToSelf: "Choose another Nostr account as the recipient."
        case .noRelays: "No Nostr relays are configured for delivery."
        }
    }
}

enum StructuredShareSendError: LocalizedError {
    case contactUnavailable
    case boardUnavailable
    case identityUnavailable
    case invalidRecipient
    case cannotSendToSelf
    case noRelays

    var errorDescription: String? {
        switch self {
        case .contactUnavailable: "That contact is no longer available."
        case .boardUnavailable: "That board is no longer available."
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "That conversation has an invalid Nostr public key."
        case .cannotSendToSelf: "Choose another Nostr account as the recipient."
        case .noRelays: "No Nostr relays are configured for delivery."
        }
    }
}

enum NostrDirectMessageError: LocalizedError {
    case identityUnavailable
    case invalidRecipient
    case emptyMessage
    case noRelays
    case invalidAttachment
    case invalidGroup
    case groupUnavailable
    case emptyGroupName
    case leftGroup

    var errorDescription: String? {
        switch self {
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "That conversation has an invalid Nostr public key."
        case .emptyMessage: "Enter a message before sending."
        case .noRelays: "No Nostr inbox relays are available for this recipient."
        case .invalidAttachment: "That encrypted attachment is invalid or incomplete."
        case .invalidGroup: "Choose at least two contacts. Groups can contain up to 17 people including you."
        case .groupUnavailable: "That group conversation is no longer available."
        case .emptyGroupName: "Enter a group name before saving."
        case .leftGroup: "Rejoin this group before sending a message."
        }
    }
}

/// The account-level relay set, stored per device. Falls back to the built-in defaults until
/// the user edits it.
enum AppRelaySettings {
    private static let key = "taskify.sync.appRelays"

    static var urls: [String] {
        let stored = UserDefaults.standard.stringArray(forKey: key) ?? []
        let normalized = TaskifyRelayURL.normalizedList(stored)
        return normalized.isEmpty ? TaskifyRelayDefaults.urls : normalized
    }

    static func setURLs(_ urls: [String]) {
        UserDefaults.standard.set(TaskifyRelayURL.normalizedList(urls), forKey: key)
    }

    /// Back to the built-in defaults (UI tests).
    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// Relays the user removed from this device's sync list. Device-local: nothing is published and
/// board relay lists are untouched—the app just stops connecting to, publishing to, and waiting
/// on these relays.
enum SyncExcludedRelaySettings {
    private static let key = "taskify.sync.excludedRelays"

    static var urls: Set<String> {
        let stored = UserDefaults.standard.stringArray(forKey: key) ?? []
        return Set(TaskifyRelayURL.normalizedList(stored))
    }

    static func setURLs(_ urls: Set<String>) {
        UserDefaults.standard.set(urls.sorted(), forKey: key)
    }
}

/// UI-test attachments whose decrypted files are seeded into the attachment disk cache under
/// their keys (the same hash-named, extensionless files a download decrypts to), so the chat
/// fixture renders and plays them without a file server. `TASKIFY_UI_TEST_CHAT_AUDIO` adds one
/// incoming audio message; `TASKIFY_UI_TEST_CHAT_ATTACHMENTS` adds a photo stack, a PDF, a
/// single photo and the audio message.
enum ChatAttachmentUITestFixture {
    struct Entry {
        let attachment: NostrDirectMessageAttachment
        let isIncoming: Bool
    }

    static var entries: [Entry] {
        let environment = ProcessInfo.processInfo.environment
        if environment["TASKIFY_UI_TEST_CHAT_ATTACHMENTS"] == "1" {
            return [
                photo(1, incoming: true), photo(2, incoming: true), photo(3, incoming: true),
                file("Trip Itinerary.pdf", mimeType: "application/pdf", incoming: false),
                photo(4, incoming: false),
                audio,
            ].compactMap { $0 }
        }
        if environment["TASKIFY_UI_TEST_CHAT_AUDIO"] == "1" { return [audio].compactMap { $0 } }
        return []
    }

    static func seedDiskCache(_ entries: [Entry]) async {
        for entry in entries {
            let attachment = entry.attachment
            guard await DirectMessageAttachmentDiskCache.shared.file(forKey: attachment.cacheKey) == nil,
                  let file = try? AttachmentFiles.create(suffix: "fixture") else { continue }
            let written: Bool
            if attachment.isAudio {
                written = writeTone(to: file)
            } else if attachment.isImage {
                let index = attachment.url.last.flatMap { Int(String($0)) } ?? 1
                written = (try? photoData(index: index).write(to: file)) != nil
            } else {
                written = (try? pdfData(title: attachment.displayName).write(to: file)) != nil
            }
            guard written else { try? FileManager.default.removeItem(at: file); continue }
            _ = await DirectMessageAttachmentDiskCache.shared.store(file, forKey: attachment.cacheKey)
        }
    }

    private static var audio: Entry? {
        attachment("audio-message", mimeType: "audio/mp4", filename: "Audio Message UI Test.m4a")
            .map { Entry(attachment: $0, isIncoming: true) }
    }

    private static func photo(_ index: Int, incoming: Bool) -> Entry? {
        attachment("photo-\(index)", mimeType: "image/png", filename: nil, width: 600, height: 800)
            .map { Entry(attachment: $0, isIncoming: incoming) }
    }

    private static func file(_ name: String, mimeType: String, incoming: Bool) -> Entry? {
        attachment(name, mimeType: mimeType, filename: name, size: 71 * 1_024)
            .map { Entry(attachment: $0, isIncoming: incoming) }
    }

    private static func attachment(
        _ id: String, mimeType: String, filename: String?, size: Int? = nil, width: Int? = nil, height: Int? = nil
    ) -> NostrDirectMessageAttachment? {
        NostrDirectMessageAttachment(
            url: "https://files.invalid/ui-test-\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)",
            mimeType: mimeType,
            filename: filename,
            size: size,
            width: width,
            height: height,
            keyHex: String(repeating: "11", count: 32),
            nonceHex: String(repeating: "22", count: 16)
        )
    }

    /// A gradient with the photo's number, drawn with CoreGraphics so the iPhone and Mac share it.
    private static func photoData(index: Int) -> Data {
        let hues: [CGFloat] = [0.58, 0.08, 0.36, 0.83]
        let hue = hues[(index - 1) % hues.count]
        let size = CGSize(width: 600, height: 800)
        guard let context = CGContext(
            data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return Data() }
        let colors = [Self.color(hue: hue, saturation: 0.55, brightness: 0.9),
                      Self.color(hue: hue, saturation: 0.8, brightness: 0.45)] as CFArray
        if let gradient = CGGradient(colorsSpace: nil, colors: colors, locations: [0, 1]) {
            context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size.height), end: CGPoint(x: size.width, y: 0), options: [])
        }
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 200, nil)
        let label = NSAttributedString(string: "\(index)", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 0.85),
        ])
        context.textPosition = CGPoint(x: 240, y: 330)
        CTLineDraw(CTLineCreateWithAttributedString(label), context)
        guard let image = context.makeImage() else { return Data() }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            return Data()
        }
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    private static func pdfData(title: String) -> Data {
        let data = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: 612, height: 792)
        guard let consumer = CGDataConsumer(data: data),
              let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { return Data() }
        context.beginPDFPage(nil)
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 28, nil)
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: title, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
        ]))
        context.textPosition = CGPoint(x: 72, y: 700)
        CTLineDraw(line, context)
        context.endPDFPage()
        context.closePDF()
        return data as Data
    }

    private static func color(hue: CGFloat, saturation: CGFloat, brightness: CGFloat) -> CGColor {
        // HSB to RGB, enough for the fixture's swatches.
        let h = hue * 6, i = floor(h), f = h - i
        let p = brightness * (1 - saturation), q = brightness * (1 - saturation * f)
        let t = brightness * (1 - saturation * (1 - f))
        let (r, g, b): (CGFloat, CGFloat, CGFloat) = switch Int(i) % 6 {
        case 0: (brightness, t, p)
        case 1: (q, brightness, p)
        case 2: (p, brightness, t)
        case 3: (p, q, brightness)
        case 4: (t, p, brightness)
        default: (brightness, p, q)
        }
        return CGColor(red: r, green: g, blue: b, alpha: 1)
    }

    private static func writeTone(to url: URL) -> Bool {
        let sampleRate = 44_100.0
        let seconds = 25.0
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleRate * seconds)),
              let samples = buffer.floatChannelData?[0] else { return false }
        buffer.frameLength = buffer.frameCapacity
        for frame in 0..<Int(buffer.frameLength) {
            samples[frame] = Float(sin(2 * Double.pi * 440 * Double(frame) / sampleRate) * 0.15)
        }
        // AVAudioFile picks the container from the extension, so write beside the target and move.
        let staged = url.deletingPathExtension().appendingPathExtension("m4a")
        do {
            let writer = try AVAudioFile(forWriting: staged, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 1,
            ])
            try writer.write(from: buffer)
        } catch {
            try? FileManager.default.removeItem(at: staged)
            return false
        }
        do {
            try FileManager.default.removeItem(at: url)
            try FileManager.default.moveItem(at: staged, to: url)
            return true
        } catch {
            try? FileManager.default.removeItem(at: staged)
            return false
        }
    }
}

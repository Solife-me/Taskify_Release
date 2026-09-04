import CryptoKit
import Foundation
import ImageIO
import TaskifyWatchShared

enum TaskifyWatchPhotoError: LocalizedError {
    case unsupported
    case tooLarge
    case invalidResponse
    case authenticationFailed
    case invalidImage

    var errorDescription: String? {
        switch self {
        case .unsupported: "This attachment cannot be displayed on Apple Watch."
        case .tooLarge: "This photo is too large for Apple Watch."
        case .invalidResponse: "The encrypted photo could not be downloaded."
        case .authenticationFailed: "The encrypted photo failed its security check."
        case .invalidImage: "The decrypted photo is invalid."
        }
    }
}

actor TaskifyWatchPhotoLoader {
    static let shared = TaskifyWatchPhotoLoader()

    private let maximumCiphertextBytes = 12 * 1_024 * 1_024
    private let maximumDimension = 8_192
    private let maximumPixels = 40_000_000
    private let thumbnailPixels = 400
    private let session: URLSession
    private let directory: URL
    private let maximumDiskBytes: Int
    private let maximumDiskEntries: Int
    private var pending: [String: Task<CGImage, Error>] = [:]
    private var generation = 0
    private var cache: [String: CGImage] = [:]
    private var cacheOrder: [String] = []

    init(session: URLSession? = nil, directory: URL? = nil,
         maximumDiskBytes: Int = 16 * 1_024 * 1_024, maximumDiskEntries: Int = 64) {
        self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TaskifyWatchReceivedPhotos-v1", isDirectory: true)
        self.maximumDiskBytes = maximumDiskBytes
        self.maximumDiskEntries = maximumDiskEntries
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            self.session = URLSession(configuration: configuration)
        }
    }

    func image(for attachment: TaskifyWatchChatAttachment) async throws -> CGImage {
        guard attachment.isPhoto, attachment.url.scheme?.lowercased() == "https" else {
            throw TaskifyWatchPhotoError.unsupported
        }
        // A mutable URL alone cannot identify immutable content. Hashless legacy photos
        // still load, but never enter the persistent or memory cache.
        let key = cacheKey(for: attachment)
        if let key, let image = cachedImage(key: key, attachment: attachment) { return image }
        let requestKey = key ?? UUID().uuidString
        let revision = generation
        let task: Task<CGImage, Error>
        let ownsTask: Bool
        if let existing = pending[requestKey] {
            task = existing
            ownsTask = false
        } else {
            task = Task { try await self.download(attachment) }
            pending[requestKey] = task
            ownsTask = true
        }
        do {
            let image = try await task.value
            guard generation == revision else { throw CancellationError() }
            if ownsTask {
                pending[requestKey] = nil
                if let key {
                    remember(image, key: key)
                    persist(image, key: key, attachment: attachment)
                }
            }
            return image
        } catch {
            if generation == revision, ownsTask { pending[requestKey] = nil }
            throw error
        }
    }

    private func download(_ attachment: TaskifyWatchChatAttachment) async throws -> CGImage {
        var request = URLRequest(url: attachment.url, timeoutInterval: 30)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (ciphertext, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            throw TaskifyWatchPhotoError.invalidResponse
        }
        if response.expectedContentLength > Int64(maximumCiphertextBytes)
            || ciphertext.count > maximumCiphertextBytes {
            throw TaskifyWatchPhotoError.tooLarge
        }
        if let expectedHash = attachment.ciphertextSHA256,
           Data(SHA256.hash(data: ciphertext)).watchPhotoHex != expectedHash.lowercased() {
            throw TaskifyWatchPhotoError.authenticationFailed
        }
        guard ciphertext.count >= 16,
              let keyData = Data(watchPhotoHex: attachment.keyHex),
              let nonceData = Data(watchPhotoHex: attachment.nonceHex),
              keyData.count == 32,
              nonceData.count == 16 else {
            throw TaskifyWatchPhotoError.authenticationFailed
        }
        let tagStart = ciphertext.index(ciphertext.endIndex, offsetBy: -16)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonceData),
            ciphertext: ciphertext[..<tagStart],
            tag: ciphertext[tagStart...]
        )
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(box, using: SymmetricKey(data: keyData))
        } catch {
            throw TaskifyWatchPhotoError.authenticationFailed
        }
        // NIP-17's `size` tag describes plaintext bytes; the uploaded AES-GCM payload also
        // contains a 16-byte authentication tag.
        if let expectedSize = attachment.size, plaintext.count != expectedSize {
            throw TaskifyWatchPhotoError.authenticationFailed
        }
        guard plaintext.count <= maximumCiphertextBytes,
              let source = CGImageSourceCreateWithData(plaintext as CFData, [
                kCGImageSourceShouldCache: false,
              ] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0,
              height > 0,
              width <= maximumDimension,
              height <= maximumDimension,
              width * height <= maximumPixels else {
            throw TaskifyWatchPhotoError.invalidImage
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: thumbnailPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw TaskifyWatchPhotoError.invalidImage
        }
        return image
    }

    func clearMemory() {
        cache.removeAll()
        cacheOrder.removeAll()
    }

    func clear() {
        generation += 1
        pending.values.forEach { $0.cancel() }
        pending.removeAll()
        clearMemory()
        try? FileManager.default.removeItem(at: directory)
    }

    private func cacheKey(for attachment: TaskifyWatchChatAttachment) -> String? {
        guard let hash = attachment.ciphertextSHA256, hash.count == 64, hash.allSatisfy(\.isHexDigit) else {
            return nil
        }
        // Bind a verified thumbnail to all authentication/decoding inputs, not just the URL/hash.
        let identity = ["thumbnail-400-v1", hash, attachment.keyHex, attachment.nonceHex,
                        attachment.mimeType, attachment.size.map(String.init) ?? "unknown"].joined(separator: "|")
        return Data(SHA256.hash(data: Data(identity.utf8))).watchPhotoHex
    }

    private func remember(_ image: CGImage, key: String) {
        cache[key] = image
        cacheOrder.removeAll { $0 == key }
        cacheOrder.append(key)
        while cacheOrder.count > 8 { cache.removeValue(forKey: cacheOrder.removeFirst()) }
        var file = directory.appendingPathComponent(key)
        var values = URLResourceValues()
        values.contentAccessDate = Date()
        try? file.setResourceValues(values)
    }

    private func cachedImage(key: String, attachment: TaskifyWatchChatAttachment) -> CGImage? {
        if let image = cache[key] {
            remember(image, key: key)
            return image
        }
        let file = directory.appendingPathComponent(key)
        do {
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= maximumDiskBytes,
                  let keyData = Data(watchPhotoHex: attachment.keyHex) else {
                throw TaskifyWatchPhotoError.invalidImage
            }
            let sealed = try AES.GCM.SealedBox(combined: Data(contentsOf: file))
            let png = try AES.GCM.open(sealed, using: SymmetricKey(data: keyData),
                                       authenticating: Data(key.utf8))
            guard let source = CGImageSourceCreateWithData(png as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: thumbnailPixels,
                    kCGImageSourceShouldCacheImmediately: true,
                  ] as CFDictionary) else { throw TaskifyWatchPhotoError.invalidImage }
            remember(image, key: key)
            return image
        } catch {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
    }

    private func persist(_ image: CGImage, key: String, attachment: TaskifyWatchChatAttachment) {
        guard let keyData = Data(watchPhotoHex: attachment.keyHex) else { return }
        let png = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil) else {
            return
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return }
        do {
            // Use a new random nonce; never reuse the attachment's nonce for cached plaintext.
            let sealed = try AES.GCM.seal(png as Data, using: SymmetricKey(data: keyData),
                                          authenticating: Data(key.utf8))
            guard let data = sealed.combined else { return }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var options: Data.WritingOptions = [.atomic]
            #if os(watchOS)
            options.insert(.completeFileProtection)
            #endif
            try data.write(to: directory.appendingPathComponent(key), options: options)
            pruneDisk()
        } catch {
            // Cache storage is optional; the decoded image remains usable.
        }
    }

    private func pruneDisk() {
        let keys: Set<URLResourceKey> = [.contentAccessDateKey, .contentModificationDateKey, .fileSizeKey]
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: Array(keys)
        )) ?? []
        let entries = files.compactMap { file -> (URL, Date, Int)? in
            guard let values = try? file.resourceValues(forKeys: keys) else { return nil }
            return (file, values.contentAccessDate ?? values.contentModificationDate ?? .distantPast,
                    values.fileSize ?? 0)
        }.sorted { $0.1 < $1.1 }
        var bytes = entries.reduce(0) { $0 + $1.2 }
        var count = entries.count
        for (file, _, size) in entries {
            guard count > maximumDiskEntries || bytes > maximumDiskBytes else { break }
            try? FileManager.default.removeItem(at: file)
            bytes -= size
            count -= 1
        }
    }
}

private extension Data {
    init?(watchPhotoHex value: String) {
        guard value.count.isMultiple(of: 2) else { return nil }
        var result = Data(capacity: value.count / 2)
        var index = value.startIndex
        while index < value.endIndex {
            let next = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        self = result
    }

    var watchPhotoHex: String { map { String(format: "%02x", $0) }.joined() }
}

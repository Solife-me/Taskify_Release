import CryptoKit
import Foundation
import ImageIO

/// URL-keyed thumbnails survive relaunches without keeping full-size profile photos in memory.
actor TaskifyWatchAvatarLoader {
    static let shared = TaskifyWatchAvatarLoader()

    private struct Entry {
        let image: CGImage
        let fetchedAt: Date
        let validators: Validators
    }

    private struct Validators: Codable {
        let etag: String?
        let lastModified: String?
    }

    private let directory: URL
    private let session: URLSession
    private let maximumDiskEntries: Int
    private let maximumDiskBytes: Int
    private let refreshInterval: TimeInterval = 5 * 60
    private var checkedThisSession: [URL: Date] = [:]
    private var memory: [URL: Entry] = [:]
    private var memoryOrder: [URL] = []
    private var pending: [URL: Task<Entry, Error>] = [:]
    private var generation = 0

    init(directory: URL? = nil, session: URLSession? = nil,
         maximumDiskEntries: Int = 200, maximumDiskBytes: Int = 8 * 1_024 * 1_024) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory, in: .userDomainMask
        )[0].appendingPathComponent("TaskifyWatchProfilePhotos", isDirectory: true)
        self.maximumDiskEntries = maximumDiskEntries
        self.maximumDiskBytes = maximumDiskBytes
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            self.session = URLSession(configuration: configuration)
        }
    }

    /// Allows the view to display an old photo immediately while checking for a refresh.
    func cachedImage(for url: URL) -> CGImage? {
        cachedEntry(for: url)?.image
    }

    func image(for url: URL) async throws -> CGImage {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
            throw URLError(.unsupportedURL)
        }
        let cached = cachedEntry(for: url)
        if let cached, let checkedAt = checkedThisSession[url],
           Date().timeIntervalSince(checkedAt) < refreshInterval {
            return cached.image
        }
        let revision = generation
        if let task = pending[url] {
            do {
                let image = try await task.value
                guard revision == generation else { throw CancellationError() }
                return image.image
            }
            catch {
                guard revision == generation else { throw CancellationError() }
                if let cached { return cached.image }
                throw error
            }
        }
        let task = Task { try await self.download(url, cached: cached) }
        pending[url] = task
        do {
            let image = try await task.value
            guard revision == generation else { throw CancellationError() }
            pending[url] = nil
            checkedThisSession[url] = Date()
            remember(image, for: url)
            persist(image, for: url)
            return image.image
        } catch {
            guard revision == generation else { throw CancellationError() }
            pending[url] = nil
            // Avoid retrying the same offline URL for every row; foreground starts a fresh check.
            checkedThisSession[url] = Date()
            if checkedThisSession.count > 128,
               let oldest = checkedThisSession.min(by: { $0.value < $1.value })?.key {
                checkedThisSession[oldest] = nil
            }
            if let cached { return cached.image }
            throw error
        }
    }

    func beginSession() {
        checkedThisSession.removeAll()
    }

    func clearMemory() {
        memory.removeAll()
        memoryOrder.removeAll()
    }

    func clear() {
        generation += 1
        pending.values.forEach { $0.cancel() }
        pending.removeAll()
        clearMemory()
        checkedThisSession.removeAll()
        try? FileManager.default.removeItem(at: directory)
    }

    private func cachedEntry(for url: URL) -> Entry? {
        if let entry = memory[url] {
            remember(entry, for: url)
            return entry
        }
        let file = fileURL(for: url)
        guard let values = try? file.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
              let size = values.fileSize, size <= maximumDiskBytes,
              let data = try? Data(contentsOf: file),
              let image = try? thumbnail(data) else {
            try? FileManager.default.removeItem(at: file)
            try? FileManager.default.removeItem(at: file.deletingPathExtension().appendingPathExtension("json"))
            return nil
        }
        let metadata = try? Data(contentsOf: file.deletingPathExtension().appendingPathExtension("json"))
        let validators = metadata.flatMap { try? JSONDecoder().decode(Validators.self, from: $0) }
            ?? Validators(etag: nil, lastModified: nil)
        let entry = Entry(image: image, fetchedAt: values.contentModificationDate ?? .distantPast,
                          validators: validators)
        remember(entry, for: url)
        return entry
    }

    private func remember(_ entry: Entry, for url: URL) {
        memory[url] = entry
        memoryOrder.removeAll { $0 == url }
        memoryOrder.append(url)
        while memoryOrder.count > 48 {
            let removed = memoryOrder.removeFirst()
            memory.removeValue(forKey: removed)
            checkedThisSession[removed] = nil
        }
        // Access time tracks eviction without extending the refresh interval.
        var file = fileURL(for: url)
        var values = URLResourceValues()
        values.contentAccessDate = Date()
        try? file.setResourceValues(values)
    }

    private func download(_ url: URL, cached: Entry?) async throws -> Entry {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue(cached?.validators.etag, forHTTPHeaderField: "If-None-Match")
        request.setValue(cached?.validators.lastModified, forHTTPHeaderField: "If-Modified-Since")
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 304, let cached {
            return Entry(image: cached.image, fetchedAt: Date(), validators: Validators(
                etag: http.value(forHTTPHeaderField: "ETag") ?? cached.validators.etag,
                lastModified: http.value(forHTTPHeaderField: "Last-Modified") ?? cached.validators.lastModified
            ))
        }
        guard (200..<300).contains(http.statusCode),
              data.count <= 5 * 1_024 * 1_024 else {
            throw URLError(.badServerResponse)
        }
        return Entry(image: try thumbnail(data), fetchedAt: Date(), validators: Validators(
            etag: http.value(forHTTPHeaderField: "ETag"),
            lastModified: http.value(forHTTPHeaderField: "Last-Modified")
        ))
    }

    private func thumbnail(_ data: Data) throws -> CGImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, [
            kCGImageSourceShouldCache: false,
        ] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 8_192, height <= 8_192,
              width * height <= 40_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 128,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else {
            throw URLError(.cannotDecodeContentData)
        }
        return image
    }

    private func fileURL(for url: URL) -> URL {
        let key = SHA256.hash(data: Data(url.absoluteString.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(key).appendingPathExtension("png")
    }

    private func persist(_ entry: Entry, for url: URL) {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else {
            return
        }
        CGImageDestinationAddImage(destination, entry.image, nil)
        guard CGImageDestinationFinalize(destination) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var options: Data.WritingOptions = [.atomic]
            #if os(watchOS)
            options.insert(.completeFileProtection)
            #endif
            let metadata = fileURL(for: url).deletingPathExtension().appendingPathExtension("json")
            // Never leave an old validator paired with new pixels if a later write fails.
            try? FileManager.default.removeItem(at: metadata)
            try (data as Data).write(to: fileURL(for: url), options: options)
            try JSONEncoder().encode(entry.validators).write(to: metadata, options: options)
            pruneDisk()
        } catch {
            // A cache write failure must not hide a successfully downloaded photo.
        }
    }

    private func pruneDisk() {
        let keys: Set<URLResourceKey> = [.contentAccessDateKey, .contentModificationDateKey, .fileSizeKey]
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: Array(keys)
        )) ?? []
        let entries = files.filter { $0.pathExtension == "png" }.compactMap { file -> (URL, Date, Int)? in
            guard let values = try? file.resourceValues(forKeys: keys) else { return nil }
            let metadata = file.deletingPathExtension().appendingPathExtension("json")
            let metadataSize = (try? metadata.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return (file, values.contentAccessDate ?? values.contentModificationDate ?? .distantPast,
                    (values.fileSize ?? 0) + metadataSize)
        }.sorted { $0.1 < $1.1 }
        var bytes = entries.reduce(0) { $0 + $1.2 }
        var count = entries.count
        for (file, _, size) in entries {
            guard count > maximumDiskEntries || bytes > maximumDiskBytes else { break }
            try? FileManager.default.removeItem(at: file)
            try? FileManager.default.removeItem(at: file.deletingPathExtension().appendingPathExtension("json"))
            bytes -= size
            count -= 1
        }
    }
}

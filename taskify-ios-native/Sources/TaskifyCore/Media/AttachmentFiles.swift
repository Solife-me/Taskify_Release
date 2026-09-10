import CryptoKit
import Foundation

public enum AttachmentFileError: LocalizedError {
    case tooLarge, empty, invalidFile, corrupt, server(Int)
    public var errorDescription: String? {
        switch self {
        case .tooLarge: "Attachments must be 500 MB or smaller."
        case .empty: "The selected file is empty."
        case .invalidFile: "The attachment could not be read."
        case .corrupt: "The attachment failed verification."
        case .server(let status): "The attachment server returned an error (\(status))."
        }
    }
}

/// All temporary files are owner-only, excluded from backups and protected on iOS.
/// Callers own returned URLs and must remove them when the operation/preview ends.
public enum AttachmentFiles {
    public static func work<T: Sendable>(_ operation: @escaping @Sendable () throws -> T) async throws -> T {
        let task = Task.detached(priority: .userInitiated, operation: operation)
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    public static func purgeExpiredTemporaryFiles() {
        guard let root = try? directory(), let entries = try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for entry in entries {
            if let date = try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
               date < Date().addingTimeInterval(-24 * 3_600) { try? FileManager.default.removeItem(at: entry) }
        }
    }

    public static let chunkSize = 256 * 1_024
    public static let maximumBytes = 500 * 1_024 * 1_024

    public static func directory(in parent: URL = FileManager.default.temporaryDirectory) throws -> URL {
        let url = parent.appendingPathComponent("TaskifyMedia", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try protect(url)
        return url
    }

    public static func create(in directory: URL? = nil, suffix: String = "bin") throws -> URL {
        let parent = try directory ?? self.directory()
        let url = parent.appendingPathComponent(UUID().uuidString).appendingPathExtension(suffix)
        guard FileManager.default.createFile(atPath: url.path, contents: nil,
                                             attributes: [.posixPermissions: 0o600]) else {
            throw AttachmentFileError.invalidFile
        }
        do { try protect(url) } catch { try? FileManager.default.removeItem(at: url); throw error }
        return url
    }

    public static func protect(_ url: URL) throws {
        var mutableURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutableURL.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                              ofItemAtPath: url.path)
        #endif
    }

    public static func size(_ url: URL, limit: Int = maximumBytes) throws -> Int {
        // NSURL caches resource values; a file can change during a provider download.
        let values = try FileManager.default.attributesOfItem(atPath: url.path)
        guard values[.type] as? FileAttributeType == .typeRegular,
              let count = values[.size] as? NSNumber else { throw AttachmentFileError.invalidFile }
        let size = count.intValue
        guard size <= limit else { throw AttachmentFileError.tooLarge }
        return size
    }

    @discardableResult
    public static func copy(_ source: URL, to destination: URL, limit: Int = maximumBytes) throws -> Int {
        _ = try size(source, limit: limit)
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        var total = 0
        while try autoreleasepool(invoking: { () throws -> Bool in
            guard let data = try input.read(upToCount: chunkSize), !data.isEmpty else { return false }
            try Task.checkCancellation()
            total += data.count
            guard total <= limit else { throw AttachmentFileError.tooLarge }
            try output.write(contentsOf: data)
            return true
        }) {}
        return total
    }

    public static func importFile(_ source: URL, into directory: URL? = nil) throws -> URL {
        let accessing = source.startAccessingSecurityScopedResource()
        defer { if accessing { source.stopAccessingSecurityScopedResource() } }
        let destination = try create(in: directory, suffix: source.pathExtension.isEmpty ? "bin" : source.pathExtension)
        do { try copy(source, to: destination); return destination }
        catch { try? FileManager.default.removeItem(at: destination); throw error }
    }

    public static func write(_ data: Data, into directory: URL? = nil) throws -> URL {
        guard data.count <= maximumBytes else { throw AttachmentFileError.tooLarge }
        let url = try create(in: directory)
        do {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.write(contentsOf: data)
            return url
        } catch { try? FileManager.default.removeItem(at: url); throw error }
    }

    public static func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while try autoreleasepool(invoking: { () throws -> Bool in
            guard let data = try handle.read(upToCount: chunkSize), !data.isEmpty else { return false }
            try Task.checkCancellation()
            hash.update(data: data)
            return true
        }) {}
        return Data(hash.finalize()).hexString
    }

    public static func multipart(file: URL, filename: String, boundary: String,
                                 nip96: Bool = false, directory: URL? = nil) throws -> URL {
        let count = try size(file, limit: maximumBytes + 32)
        let name = filename.replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        let url = try create(in: directory, suffix: "multipart")
        do {
            let output = try FileHandle(forWritingTo: url)
            defer { try? output.close() }
            try output.write(contentsOf: Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
            let input = try FileHandle(forReadingFrom: file)
            defer { try? input.close() }
            var copied = 0
            while try autoreleasepool(invoking: { () throws -> Bool in
                guard let data = try input.read(upToCount: chunkSize), !data.isEmpty else { return false }
                try Task.checkCancellation()
                copied += data.count
                guard copied <= maximumBytes + 32 else { throw AttachmentFileError.tooLarge }
                try output.write(contentsOf: data)
                return true
            }) {}
            try output.write(contentsOf: Data("\r\n".utf8))
            if nip96 {
                for (key, value) in [("filename", name), ("content_type", "application/octet-stream"), ("size", String(count))] {
                    try output.write(contentsOf: Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n".utf8))
                }
            }
            try output.write(contentsOf: Data("--\(boundary)--\r\n".utf8))
            return url
        } catch { try? FileManager.default.removeItem(at: url); throw error }
    }
}

/// Download to disk, cancelling as soon as the byte budget is exceeded, including
/// servers that omit or lie about Content-Length. Never buffers the response body.
public final class AttachmentDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let limit: Int
    private var continuation: CheckedContinuation<URL, Error>?
    private var session: URLSession?
    private var result: Result<URL, Error>?
    private var exceededLimit = false
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionDownloadTask?

    private init(limit: Int) { self.limit = limit }

    public static func file(from url: URL, limit: Int = AttachmentFiles.maximumBytes + 32) async throws -> URL {
        let downloader = AttachmentDownload(limit: limit)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                downloader.lock.lock()
                defer { downloader.lock.unlock() }
                if downloader.cancelled { continuation.resume(throwing: CancellationError()); return }
                downloader.continuation = continuation
                let config = URLSessionConfiguration.ephemeral
                config.timeoutIntervalForRequest = 120
                config.timeoutIntervalForResource = 3_600
                let session = URLSession(configuration: config, delegate: downloader, delegateQueue: nil)
                downloader.session = session
                downloader.task = session.downloadTask(with: url)
                downloader.task?.resume()
            }
        } onCancel: {
            downloader.lock.lock()
            downloader.cancelled = true
            downloader.task?.cancel()
            downloader.lock.unlock()
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                           didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                           totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit || totalBytesExpectedToWrite > limit {
            exceededLimit = true
            downloadTask.cancel()
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            guard let response = downloadTask.response as? HTTPURLResponse else { throw AttachmentFileError.invalidFile }
            guard (200..<300).contains(response.statusCode) else { throw AttachmentFileError.server(response.statusCode) }
            _ = try AttachmentFiles.size(location, limit: limit)
            let destination = try AttachmentFiles.create()
            do {
                try FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: location, to: destination)
                try AttachmentFiles.protect(destination)
                result = .success(destination)
            } catch { try? FileManager.default.removeItem(at: destination); throw error }
        } catch { result = .failure(error) }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let final: Result<URL, Error> = exceededLimit ? .failure(AttachmentFileError.tooLarge)
            : error.map { .failure($0) } ?? result ?? .failure(AttachmentFileError.invalidFile)
        if case .failure = final, case .success(let url) = result { try? FileManager.default.removeItem(at: url) }
        continuation?.resume(with: final)
        continuation = nil
        session.finishTasksAndInvalidate()
        self.session = nil
    }
}

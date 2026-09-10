import Foundation

public enum AttachmentTransferProgress: Equatable, Sendable {
    case encrypting(completed: Int, total: Int)
    case preparingUpload
    case uploading(completed: Int64, total: Int64)
    case awaitingServer
    case sendingMessage

    public var fractionCompleted: Double? {
        switch self {
        case let .encrypting(completed, total):
            total > 0 ? min(1, max(0, Double(completed) / Double(total))) : nil
        case let .uploading(completed, total):
            total > 0 ? min(1, max(0, Double(completed) / Double(total))) : nil
        default: nil
        }
    }

    public var message: String {
        switch self {
        case .encrypting:
            "Encrypting attachment… \(Int((fractionCompleted ?? 0) * 100))%"
        case .preparingUpload:
            "Preparing upload…"
        case let .uploading(completed, total):
            "Uploading \(ByteCountFormatter.string(fromByteCount: completed, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))…"
        case .awaitingServer:
            "Waiting for the file server…"
        case .sendingMessage:
            "Sending message…"
        }
    }
}

/// Progress is local UI state. It never contains a filename, URL, key or comment.
public typealias AttachmentProgressHandler = @Sendable (AttachmentTransferProgress) -> Void

/// Keeps the body on disk and forwards URLSession's actual transmitted-byte counts.
enum AttachmentUploadTransport {
    static func upload(request: URLRequest, file: URL, session: URLSession,
                       progress: AttachmentProgressHandler?) async throws -> (Data, URLResponse) {
        let total = try AttachmentFiles.size(file, limit: AttachmentFiles.maximumBytes + 65_536)
        let delegate = UploadProgress(total: Int64(total), handler: progress)
        progress?(.uploading(completed: 0, total: Int64(total)))
        let result = try await session.upload(for: request, fromFile: file, delegate: delegate)
        progress?(.awaitingServer)
        return result
    }

    private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let total: Int64
        let handler: AttachmentProgressHandler?
        private let lock = NSLock()
        private var lastUpdate: TimeInterval = 0

        init(total: Int64, handler: AttachmentProgressHandler?) {
            self.total = total; self.handler = handler
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                        totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
            let expected = totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : total
            let now = ProcessInfo.processInfo.systemUptime
            lock.lock()
            let shouldUpdate = now - lastUpdate >= 0.1 || totalBytesSent >= expected
            if shouldUpdate { lastUpdate = now }
            lock.unlock()
            guard shouldUpdate else { return }
            handler?(.uploading(completed: totalBytesSent, total: expected))
            if totalBytesSent >= expected { handler?(.awaitingServer) }
        }
    }
}

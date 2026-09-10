import Foundation
import XCTest
@testable import TaskifyCore

final class AttachmentUploadTests: XCTestCase {
    private let identity = Data(repeating: 1, count: 32) // synthetic, never a user identity

    private func endpoint(_ path: String) throws -> URL {
        guard let base = ProcessInfo.processInfo.environment["TASKIFY_UPLOAD_TEST_BASE_URL"],
              let url = URL(string: base + path), url.host == "127.0.0.1" else {
            throw XCTSkip("Start Scripts/attachment-upload-test-server.py and set TASKIFY_UPLOAD_TEST_BASE_URL to its loopback address.")
        }
        return url
    }

    private func source(size: Int) throws -> URL {
        let source = try AttachmentFiles.create(suffix: "mp3")
        let writer = try FileHandle(forWritingTo: source)
        defer { try? writer.close() }
        let chunk = Data((0..<AttachmentFiles.chunkSize).map { UInt8($0 % 251) })
        var remaining = size
        while remaining > 0 {
            let count = min(remaining, chunk.count)
            try writer.write(contentsOf: chunk.prefix(count))
            remaining -= count
        }
        return source
    }

    func testEncryptedUploadsRoundTripThroughBothServerFormats() async throws {
        try await roundTrip(size: AttachmentFiles.chunkSize * 2 + 17)
    }

    func test83MiBEncryptedUploadsRoundTripThroughBothServerFormats() async throws {
        guard ProcessInfo.processInfo.environment["TASKIFY_TEST_LARGE_FILES"] == "1" else {
            throw XCTSkip("Set TASKIFY_TEST_LARGE_FILES=1 for the 83 MiB upload/download integration test.")
        }
        try await roundTrip(size: 83 * 1024 * 1024)
    }

    private func roundTrip(size: Int) async throws {
        _ = try endpoint("/")
        let source = try source(size: size)
        defer { try? FileManager.default.removeItem(at: source) }
        let encryptionProgress = ProgressRecorder()
        let encrypted = try await AttachmentFiles.work {
            try AttachmentFileCrypto.encryptChat(source, progress: { encryptionProgress.record($0) })
        }
        defer { try? FileManager.default.removeItem(at: encrypted.url) }
        XCTAssertEqual(encrypted.plaintextSize, size)
        XCTAssertTrue(encryptionProgress.values.contains(.encrypting(completed: size, total: size)))
        XCTAssertEqual(encryptionProgress.values.last, .preparingUpload)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        for type in [TaskifyFileServerType.originless, .blossom] {
            let server = TaskifyFileServerEntry(url: "https://files.example", type: type)
            let prepared = try await EncryptedFileUpload.prepare(file: encrypted.url,
                filename: "\(encrypted.sha256).bin", server: server, privateKey: identity, session: session)
            defer { if prepared.removesBody { try? FileManager.default.removeItem(at: prepared.body) } }
            // Exercise production preparation and transport against loopback without
            // weakening the production HTTPS requirement or sending user material.
            var request = prepared.request
            request.url = try endpoint("/\(type.rawValue)/upload")
            let uploadProgress = ProgressRecorder()
            let (data, response) = try await AttachmentUploadTransport.upload(request: request,
                file: prepared.body, session: session, progress: { uploadProgress.record($0) })
            let http = try XCTUnwrap(response as? HTTPURLResponse)
            let remote = try await EncryptedFileUpload.finish(data: data, response: http, server: server)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(json["sha256"] as? String, encrypted.sha256)
            XCTAssertEqual(json["size"] as? Int, size + 16)
            let expectedBytes = try AttachmentFiles.size(prepared.body, limit: AttachmentFiles.maximumBytes + 65_536)
            XCTAssertTrue(uploadProgress.values.contains(.uploading(completed: Int64(expectedBytes), total: Int64(expectedBytes))))
            XCTAssertEqual(uploadProgress.values.last, .awaitingServer)
            let attachment = try XCTUnwrap(NostrDirectMessageAttachment(url: remote, mimeType: "audio/mpeg",
                filename: "synthetic-audio.mp3", size: size, keyHex: encrypted.keyHex,
                nonceHex: encrypted.nonceHex, sha256: encrypted.sha256))
            let downloaded = try await AttachmentDownload.file(from: XCTUnwrap(URL(string: remote)))
            defer { try? FileManager.default.removeItem(at: downloaded) }
            let decrypted = try await AttachmentFiles.work {
                try AttachmentFileCrypto.decryptChat(downloaded, attachment: attachment)
            }
            defer { try? FileManager.default.removeItem(at: decrypted) }
            XCTAssertEqual(try AttachmentFiles.size(decrypted), size)
            XCTAssertEqual(try AttachmentFiles.sha256(decrypted), try AttachmentFiles.sha256(source))
        }
    }

    func testUploadLimitRejectionNamesTheServerAndRetainsStatus() async throws {
        let endpoint = try endpoint("/reject/upload")
        let source = try source(size: 1024)
        defer { try? FileManager.default.removeItem(at: source) }
        let server = TaskifyFileServerEntry(url: "https://files.example", type: .blossom)
        let prepared = try await EncryptedFileUpload.prepare(file: source, filename: "test.bin", server: server, privateKey: identity)
        var request = prepared.request
        request.url = endpoint
        let (data, response) = try await AttachmentUploadTransport.upload(request: request, file: source, session: .shared, progress: nil)
        do {
            _ = try await EncryptedFileUpload.finish(data: data, response: XCTUnwrap(response as? HTTPURLResponse), server: server)
            XCTFail("Server rejection was accepted")
        } catch AttachmentUploadError.server(let name, let status, _) {
            XCTAssertEqual(name, "files.example")
            XCTAssertEqual(status, 413)
        }
    }

    func testCancellingActiveUploadStopsTheRequestAndKeepsTheDraft() async throws {
        let endpoint = try endpoint("/slow/upload")
        let source = try source(size: 8 * 1024 * 1024)
        defer { try? FileManager.default.removeItem(at: source) }
        let server = TaskifyFileServerEntry(url: "https://files.example", type: .blossom)
        let prepared = try await EncryptedFileUpload.prepare(file: source, filename: "test.bin", server: server, privateKey: identity)
        var request = prepared.request
        request.url = endpoint
        let progress = ProgressRecorder()
        let task = Task {
            try await AttachmentUploadTransport.upload(request: request, file: source, session: .shared, progress: { progress.record($0) })
        }
        let deadline = Date().addingTimeInterval(5)
        while !progress.values.contains(where: {
            if case .uploading(let count, _) = $0 { return count > 0 }
            return false
        }), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Cancelled upload completed")
        } catch let error as URLError { XCTAssertEqual(error.code, .cancelled) }
        catch is CancellationError { }
        XCTAssertEqual(try AttachmentFiles.size(source), 8 * 1024 * 1024)
    }

    private final class ProgressRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var history: [AttachmentTransferProgress] = []
        var values: [AttachmentTransferProgress] {
            lock.lock(); defer { lock.unlock() }
            return history
        }
        func record(_ progress: AttachmentTransferProgress) {
            lock.lock(); defer { lock.unlock() }
            history.append(progress)
        }
    }
}

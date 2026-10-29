import Foundation
import XCTest
@testable import TaskifyCore

final class AttachmentDownloadTests: XCTestCase {
    func testDownloadingProgressReportsAPercentage() {
        let progress = AttachmentTransferProgress.downloading(completed: 512, total: 1_024)
        XCTAssertEqual(progress.fractionCompleted, 0.5)
        XCTAssertEqual(progress.message, "Downloading 50%…")
        XCTAssertNil(AttachmentTransferProgress.downloading(completed: 512, total: 0).fractionCompleted)
        XCTAssertEqual(AttachmentTransferProgress.downloading(completed: 512, total: 0).message,
                       "Downloading attachment…")
    }

    private func url(_ path: String) throws -> URL {
        guard let base = ProcessInfo.processInfo.environment["TASKIFY_DOWNLOAD_TEST_BASE_URL"], let url = URL(string: base + path) else {
            throw XCTSkip("Start Scripts/attachment-test-server.py and set TASKIFY_DOWNLOAD_TEST_BASE_URL to its loopback address.")
        }
        return url
    }
    func testDownloadWithoutContentLength() async throws {
        let updates = ProgressRecorder()
        let file = try await AttachmentDownload.file(
            from: url("/small"),
            limit: 16_384,
            progress: { updates.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(try Data(contentsOf: file), Data(repeating: 98, count: 8_192))
        XCTAssertFalse(updates.values.isEmpty)
        XCTAssertTrue(updates.values.contains { if case .downloading = $0 { return true }; return false })
    }
    func testActualAndAdvertisedSizeLimits() async throws {
        for path in ["/streamed-oversize", "/advertised-oversize"] {
            do {
                let file = try await AttachmentDownload.file(from: url(path), limit: 128 * 1024)
                try? FileManager.default.removeItem(at: file)
                XCTFail("Oversized download was accepted")
            } catch AttachmentFileError.tooLarge { } catch { throw error }
        }
    }
    func testHTTPFailure() async throws {
        do {
            let file = try await AttachmentDownload.file(from: url("/error"))
            try? FileManager.default.removeItem(at: file)
            XCTFail("HTTP error was accepted")
        } catch AttachmentFileError.server(let code) { XCTAssertEqual(code, 503) }
    }
    func testCancellation() async throws {
        let endpoint = try url("/slow")
        let task = Task { try await AttachmentDownload.file(from: endpoint) }
        try await Task.sleep(for: .milliseconds(80))
        task.cancel()
        do {
            let file = try await task.value
            try? FileManager.default.removeItem(at: file)
            XCTFail("Cancelled download completed")
        } catch let error as URLError { XCTAssertEqual(error.code, .cancelled) }
        catch is CancellationError { }
    }
}

private final class ProgressRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var history: [AttachmentTransferProgress] = []
    var values: [AttachmentTransferProgress] {
        lock.lock(); defer { lock.unlock() }
        return history
    }
    func record(_ value: AttachmentTransferProgress) {
        lock.lock(); defer { lock.unlock() }
        history.append(value)
    }
}

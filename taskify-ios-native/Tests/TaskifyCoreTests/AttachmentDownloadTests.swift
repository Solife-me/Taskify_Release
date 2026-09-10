import Foundation
import XCTest
@testable import TaskifyCore

final class AttachmentDownloadTests: XCTestCase {
    private func url(_ path: String) throws -> URL {
        guard let base = ProcessInfo.processInfo.environment["TASKIFY_DOWNLOAD_TEST_BASE_URL"], let url = URL(string: base + path) else {
            throw XCTSkip("Start Scripts/attachment-test-server.py and set TASKIFY_DOWNLOAD_TEST_BASE_URL to its loopback address.")
        }
        return url
    }
    func testDownloadWithoutContentLength() async throws {
        let file = try await AttachmentDownload.file(from: url("/small"), limit: 16_384)
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(try Data(contentsOf: file), Data(repeating: 98, count: 8_192))
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

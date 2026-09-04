import Foundation
import XCTest
@testable import TaskifyCore

final class ShareContractTests: XCTestCase {
    func testSuggestionIdentifiersAreScopedToTheAccountAndExcludeRawPublicKeys() {
        let recipient = ShareRecipient(id: String(repeating: "a", count: 64), name: "Alice", members: [String(repeating: "a", count: 64)],
            isGroup: false, discoveryRelays: ["wss://relay.example"])
        let first = recipient.suggestionID(account: String(repeating: "b", count: 64))
        let second = recipient.suggestionID(account: String(repeating: "c", count: 64))
        XCTAssertEqual(first.count, 64)
        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(first, recipient.id)
    }

    func testMultipartPreservesCiphertextAndSanitizesHeaders() throws {
        let bytes = Data([0, 255, 42, 13, 10, 0])
        let source = try AttachmentFiles.write(bytes)
        defer { try? FileManager.default.removeItem(at: source) }
        let body = try AttachmentFiles.multipart(file: source, filename: "file\"\r\nX-Injected: yes.bin", boundary: "BOUNDARY", nip96: true)
        defer { try? FileManager.default.removeItem(at: body) }
        let data = try Data(contentsOf: body)
        XCTAssertNotNil(data.range(of: bytes))
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("\r\nX-Injected"))
        XCTAssertTrue(text.contains("name=\"size\"\r\n\r\n6\r\n"))
        XCTAssertTrue(text.hasSuffix("--BOUNDARY--\r\n"))
    }

    func testOriginlessCIDAndServerRejectionParsing() throws {
        let entry = TaskifyFileServerEntry(url: "https://files.example", type: .originless)
        XCTAssertEqual(try EncryptedFileUpload.remoteURL(data: Data(#"{"url":"https://files.example/file"}"#.utf8), server: entry), "https://files.example/file")
        XCTAssertThrowsError(try EncryptedFileUpload.remoteURL(data: Data(#"{"url":"file:///private/data"}"#.utf8), server: entry))
    }
}

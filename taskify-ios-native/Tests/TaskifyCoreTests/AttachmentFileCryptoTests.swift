import CryptoKit
import Foundation
import XCTest
@testable import TaskifyCore

final class AttachmentFileCryptoTests: XCTestCase {
    func testChatFileInteropAcrossChunkBoundaries() throws {
        for size in [1, 15, 16, 17, AttachmentFiles.chunkSize - 1, AttachmentFiles.chunkSize, AttachmentFiles.chunkSize + 31] {
            let data = Data((0..<size).map { UInt8($0 % 251) })
            let source = try AttachmentFiles.write(data)
            defer { try? FileManager.default.removeItem(at: source) }
            let encrypted = try AttachmentFileCrypto.encryptChat(source)
            defer { try? FileManager.default.removeItem(at: encrypted.url) }
            let attachment = try XCTUnwrap(NostrDirectMessageAttachment(url: "https://example.com/file", mimeType: "application/octet-stream",
                keyHex: encrypted.keyHex, nonceHex: encrypted.nonceHex, sha256: encrypted.sha256))
            XCTAssertEqual(try NostrDirectMessageAttachmentCrypto.decrypt(Data(contentsOf: encrypted.url), attachment: attachment), data)
            let decrypted = try AttachmentFileCrypto.decryptChat(encrypted.url, attachment: attachment)
            defer { try? FileManager.default.removeItem(at: decrypted) }
            XCTAssertEqual(try Data(contentsOf: decrypted), data)
        }
    }

    func testTaskFileInteropAndLegacy() throws {
        let data = Data(repeating: 0x93, count: AttachmentFiles.chunkSize + 3)
        let source = try AttachmentFiles.write(data)
        defer { try? FileManager.default.removeItem(at: source) }
        let encrypted = try AttachmentFileCrypto.encryptTask(source, boardID: "test-board")
        defer { try? FileManager.default.removeItem(at: encrypted) }
        XCTAssertEqual(try TaskAttachmentCrypto.decrypt(Data(contentsOf: encrypted), boardID: "test-board"), data)
        let current = try TaskAttachmentCrypto.encrypt(data, boardID: "test-board")
        let key = SymmetricKey(data: SHA256.hash(data: Data("test-board".utf8)))
        let legacy = try XCTUnwrap(AES.GCM.seal(data, using: key).combined)
        for bytes in [current, legacy] {
            let input = try AttachmentFiles.write(bytes)
            defer { try? FileManager.default.removeItem(at: input) }
            let output = try AttachmentFileCrypto.decryptTask(input, boardID: "test-board")
            defer { try? FileManager.default.removeItem(at: output) }
            XCTAssertEqual(try Data(contentsOf: output), data)
        }
    }

    func testTamperingNeverReturnsPlaintextAndDeletesPartialOutput() throws {
        let input = try AttachmentFiles.write(Data(repeating: 0x51, count: AttachmentFiles.chunkSize + 13))
        defer { try? FileManager.default.removeItem(at: input) }
        let encrypted = try AttachmentFileCrypto.encryptChat(input)
        defer { try? FileManager.default.removeItem(at: encrypted.url) }
        let original = try Data(contentsOf: encrypted.url)
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(url: "https://example.com/file", mimeType: "application/octet-stream",
            keyHex: encrypted.keyHex, nonceHex: encrypted.nonceHex)) // omit hash to exercise GCM, not only SHA-256
        let directory = try AttachmentFiles.directory()
        for offset in [0, original.count - 1] {
            var corrupted = original
            corrupted[offset] ^= 0xff
            try corrupted.write(to: encrypted.url)
            let before = Set(try FileManager.default.contentsOfDirectory(atPath: directory.path))
            XCTAssertThrowsError(try AttachmentFileCrypto.decryptChat(encrypted.url, attachment: attachment))
            XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)), before)
        }
        try original.prefix(12).write(to: encrypted.url)
        XCTAssertThrowsError(try AttachmentFileCrypto.decryptChat(encrypted.url, attachment: attachment))
    }

    func testLimitBeforeReadingFile() throws {
        let url = try AttachmentFiles.create()
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(AttachmentFiles.maximumBytes + 1))
        try handle.close()
        XCTAssertThrowsError(try AttachmentFileCrypto.encryptChat(url))
        let resized = try FileHandle(forWritingTo: url)
        try resized.truncate(atOffset: UInt64(AttachmentFiles.maximumBytes))
        try resized.close()
        XCTAssertEqual(try AttachmentFiles.size(url), 500 * 1_024 * 1_024)
    }
    func test500MiBFileRoundTrip() throws {
        guard ProcessInfo.processInfo.environment["TASKIFY_TEST_LARGE_FILES"] == "1" else {
            throw XCTSkip("Set TASKIFY_TEST_LARGE_FILES=1 for the 500 MiB disk/memory integration test.")
        }
        let source = try AttachmentFiles.create()
        defer { try? FileManager.default.removeItem(at: source) }
        let writer = try FileHandle(forWritingTo: source)
        let chunk = Data((0..<AttachmentFiles.chunkSize).map { UInt8($0 % 251) })
        for _ in 0..<(AttachmentFiles.maximumBytes / chunk.count) { try writer.write(contentsOf: chunk) }
        try writer.close()
        let encrypted = try AttachmentFileCrypto.encryptChat(source)
        defer { try? FileManager.default.removeItem(at: encrypted.url) }
        XCTAssertEqual(encrypted.plaintextSize, AttachmentFiles.maximumBytes)
        XCTAssertEqual(try AttachmentFiles.size(encrypted.url, limit: AttachmentFiles.maximumBytes + 16), AttachmentFiles.maximumBytes + 16)
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(url: "https://example.com/file", mimeType: "application/octet-stream",
            keyHex: encrypted.keyHex, nonceHex: encrypted.nonceHex, sha256: encrypted.sha256))
        let decrypted = try AttachmentFileCrypto.decryptChat(encrypted.url, attachment: attachment)
        defer { try? FileManager.default.removeItem(at: decrypted) }
        XCTAssertEqual(try AttachmentFiles.sha256(source), try AttachmentFiles.sha256(decrypted))
    }

}

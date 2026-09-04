import CryptoKit
import Foundation
import ImageIO
import XCTest
import TaskifyWatchShared
@testable import TaskifyWatchChatRuntime

private final class PhotoCacheTransport: URLProtocol {
    private static let lock = NSLock()
    private static var data = Data()
    private static var offline = false
    private static var held: XCTestExpectation?
    private static var count = 0

    static func configure(data: Data = Data(), offline: Bool = false, held: XCTestExpectation? = nil) {
        lock.lock()
        defer { lock.unlock() }
        Self.data = data
        Self.offline = offline
        Self.held = held
        count = 0
    }
    static var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        Self.lock.lock()
        Self.count += 1
        let data = Self.data
        let offline = Self.offline
        let held = Self.held
        Self.lock.unlock()
        if let held { held.fulfill(); return }
        if offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        } else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
            )!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}

final class TaskifyWatchPhotoCacheTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PhotoCacheTransport.self]
        let session = URLSession(configuration: config)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }
    private func fixture() throws -> (attachment: TaskifyWatchChatAttachment, ciphertext: Data) {
        let context = try XCTUnwrap(CGContext(data: nil, width: 512, height: 256, bitsPerComponent: 8,
                                             bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.5, green: 0.2, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 512, height: 256))
        let png = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let key = SymmetricKey(size: .bits256)
        let nonceData = Data(repeating: 2, count: 16)
        let sealed = try AES.GCM.seal(png as Data, using: key, nonce: AES.GCM.Nonce(data: nonceData))
        let ciphertext = sealed.ciphertext + sealed.tag
        func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
        return (try XCTUnwrap(TaskifyWatchChatAttachment(
            url: URL(string: "https://photos.example/photo")!, mimeType: "image/png",
            keyHex: key.withUnsafeBytes { hex(Data($0)) }, nonceHex: hex(nonceData),
            ciphertextSHA256: hex(Data(SHA256.hash(data: ciphertext))), size: png.length
        )), ciphertext)
    }

    func testVerifiedThumbnailSurvivesRelaunchOfflineAndIsEncryptedOnDisk() async throws {
        let folder = try directory()
        let fixture = try fixture()
        PhotoCacheTransport.configure(data: fixture.ciphertext)
        let loader = TaskifyWatchPhotoLoader(session: session(), directory: folder)
        let image = try await loader.image(for: fixture.attachment)
        XCTAssertEqual(image.width, 400)
        XCTAssertEqual(PhotoCacheTransport.requestCount, 1)
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).first)
        let encrypted = try Data(contentsOf: file)
        XCTAssertNotEqual(Array(encrypted.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        PhotoCacheTransport.configure(offline: true)
        await loader.clearMemory()
        let restored = try await TaskifyWatchPhotoLoader(session: session(), directory: folder).image(for: fixture.attachment)
        XCTAssertEqual(restored.width, 400)
        XCTAssertEqual(PhotoCacheTransport.requestCount, 0)
        await loader.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testCachedPhotoCannotBypassChangedAuthenticationMetadataAndLegacyPhotosAreNotCached() async throws {
        let folder = try directory()
        let f = try fixture()
        PhotoCacheTransport.configure(data: f.ciphertext)
        let loader = TaskifyWatchPhotoLoader(session: session(), directory: folder)
        _ = try await loader.image(for: f.attachment)
        let changed = try XCTUnwrap(TaskifyWatchChatAttachment(
            url: f.attachment.url, mimeType: f.attachment.mimeType, keyHex: f.attachment.keyHex,
            nonceHex: f.attachment.nonceHex, ciphertextSHA256: f.attachment.ciphertextSHA256,
            size: (f.attachment.size ?? 0) + 1
        ))
        do {
            _ = try await loader.image(for: changed)
            XCTFail("Cached image must not bypass attachment verification")
        } catch {}
        XCTAssertEqual(PhotoCacheTransport.requestCount, 2)
        await loader.clear()
        let legacy = try XCTUnwrap(TaskifyWatchChatAttachment(
            url: f.attachment.url, mimeType: f.attachment.mimeType, keyHex: f.attachment.keyHex,
            nonceHex: f.attachment.nonceHex, size: f.attachment.size
        ))
        _ = try await loader.image(for: legacy)
        _ = try await loader.image(for: legacy)
        XCTAssertEqual(PhotoCacheTransport.requestCount, 4)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testClearingCancelsInFlightDownloadWithoutRepopulatingDisk() async throws {
        let folder = try directory()
        let f = try fixture()
        let started = expectation(description: "Download started")
        PhotoCacheTransport.configure(held: started)
        let loader = TaskifyWatchPhotoLoader(session: session(), directory: folder)
        let request = Task { try await loader.image(for: f.attachment) }
        await fulfillment(of: [started], timeout: 2)
        await loader.clear()
        do {
            _ = try await request.value
            XCTFail("Cleared downloads must not succeed")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testDiskBudgetAndCorruptThumbnailRecovery() async throws {
        let folder = try directory()
        let f = try fixture()
        PhotoCacheTransport.configure(data: f.ciphertext)
        let loader = TaskifyWatchPhotoLoader(session: session(), directory: folder, maximumDiskEntries: 1)
        _ = try await loader.image(for: f.attachment)
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).first)
        try Data("corrupt".utf8).write(to: file)
        await loader.clearMemory()
        _ = try await loader.image(for: f.attachment)
        XCTAssertEqual(PhotoCacheTransport.requestCount, 2)
        let second = try fixture()
        PhotoCacheTransport.configure(data: second.ciphertext)
        _ = try await loader.image(for: second.attachment)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).count, 1)
        let tiny = TaskifyWatchPhotoLoader(session: session(), directory: folder, maximumDiskBytes: 1)
        _ = try await tiny.image(for: second.attachment)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: folder.path).isEmpty)
    }
}

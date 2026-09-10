import Foundation
import ImageIO
import XCTest
@testable import TaskifyWatchChatRuntime

private final class AvatarTransport: URLProtocol {
    private static let lock = NSLock()
    private static var responseData = Data()
    private static var offline = false
    private static var count = 0
    private static var status = 200
    private static var headers: [String: String] = [:]
    private static var lastRequest: URLRequest?

    static func configure(data: Data = Data(), offline: Bool = false, status: Int = 200, headers: [String: String] = [:]) {
        lock.lock()
        defer { lock.unlock() }
        Self.responseData = data
        Self.offline = offline
        count = 0
        Self.status = status
        Self.headers = headers
        lastRequest = nil
    }

    static var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    static var request: URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return lastRequest
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.lock.lock()
        Self.count += 1
        Self.lastRequest = request
        let status = Self.status
        let headers = Self.headers
        let data = Self.responseData
        let offline = Self.offline
        Self.lock.unlock()
        if offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        } else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: headers
            )!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}

final class TaskifyWatchAvatarLoaderTests: XCTestCase {
    private let photoURL = URL(string: "https://profiles.example/avatar.png")!

    private func directory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AvatarTransport.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }

    private func photo(height: Int = 256) throws -> Data {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: 512, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.8, green: 0.3, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 512, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func files(in directory: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "png" }
    }

    func testThumbnailSurvivesMemoryClearAndIsAvailableBeforeRelaunchRefresh() async throws {
        let directory = try directory()
        AvatarTransport.configure(data: try photo())
        let loader = TaskifyWatchAvatarLoader(directory: directory, session: session())
        let first = try await loader.image(for: photoURL)
        XCTAssertEqual(first.width, 128)
        XCTAssertEqual(first.height, 64)
        XCTAssertEqual(AvatarTransport.requestCount, 1)
        XCTAssertEqual(try files(in: directory).count, 1)

        AvatarTransport.configure(offline: true)
        await loader.clearMemory()
        let fromDisk = try await loader.image(for: photoURL)
        XCTAssertEqual(fromDisk.width, 128)
        let relaunched = TaskifyWatchAvatarLoader(directory: directory, session: session())
        let immediate = await relaunched.cachedImage(for: photoURL)
        XCTAssertEqual(immediate?.width, 128)
        XCTAssertEqual(AvatarTransport.requestCount, 0)
        let afterRelaunch = try await relaunched.image(for: photoURL)
        XCTAssertEqual(afterRelaunch.width, 128)
        XCTAssertEqual(AvatarTransport.requestCount, 1)
    }

    func testExpiredPhotoIsImmediatelyAvailableAndSurvivesOfflineRefresh() async throws {
        let directory = try directory()
        AvatarTransport.configure(data: try photo())
        let loader = TaskifyWatchAvatarLoader(directory: directory, session: session())
        _ = try await loader.image(for: photoURL)
        let file = try XCTUnwrap(files(in: directory).first)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-8 * 24 * 60 * 60)], ofItemAtPath: file.path
        )
        AvatarTransport.configure(offline: true)
        let relaunched = TaskifyWatchAvatarLoader(directory: directory, session: session())
        let cached = await relaunched.cachedImage(for: photoURL)
        XCTAssertEqual(cached?.width, 128)
        XCTAssertEqual(AvatarTransport.requestCount, 0)
        let offline = try await relaunched.image(for: photoURL)
        XCTAssertEqual(offline.width, 128)
        XCTAssertEqual(AvatarTransport.requestCount, 1)

        AvatarTransport.configure(data: try photo())
        await relaunched.beginSession()
        _ = try await relaunched.image(for: photoURL)
        let modified = try file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        XCTAssertLessThan(Date().timeIntervalSince(try XCTUnwrap(modified)), 10)
    }

    func testChangedURLDownloadsNewPhotoAndConcurrentRequestsShareDownload() async throws {
        AvatarTransport.configure(data: try photo())
        let loader = TaskifyWatchAvatarLoader(directory: try directory(), session: session())
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<12 {
                group.addTask { _ = try await loader.image(for: self.photoURL) }
            }
            try await group.waitForAll()
        }
        XCTAssertEqual(AvatarTransport.requestCount, 1)
        _ = try await loader.image(for: URL(string: "https://profiles.example/avatar-v2.png")!)
        XCTAssertEqual(AvatarTransport.requestCount, 2)
    }

    func testDiskLimitsAndClearRemovePersistedPhotos() async throws {
        let directory = try directory()
        AvatarTransport.configure(data: try photo())
        let loader = TaskifyWatchAvatarLoader(directory: directory, session: session(), maximumDiskEntries: 2)
        for index in 0..<4 {
            _ = try await loader.image(for: URL(string: "https://profiles.example/\(index).png")!)
        }
        XCTAssertEqual(try files(in: directory).count, 2)
        await loader.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        let cached = await loader.cachedImage(for: URL(string: "https://profiles.example/3.png")!)
        XCTAssertNil(cached)

        let tiny = TaskifyWatchAvatarLoader(directory: directory, session: session(), maximumDiskBytes: 1)
        _ = try await tiny.image(for: photoURL)
        XCTAssertTrue(try files(in: directory).isEmpty)
    }

    func testInvalidResponseIsNotPersistedAndCorruptCacheIsReplaced() async throws {
        let directory = try directory()
        AvatarTransport.configure(data: Data("not an image".utf8))
        let loader = TaskifyWatchAvatarLoader(directory: directory, session: session())
        do {
            _ = try await loader.image(for: photoURL)
            XCTFail("Invalid profile photo should be rejected")
        } catch {}
        XCTAssertTrue(try files(in: directory).isEmpty)
        AvatarTransport.configure(data: try photo())
        _ = try await loader.image(for: photoURL)
        let file = try XCTUnwrap(files(in: directory).first)
        try Data("corrupt".utf8).write(to: file)
        await loader.clearMemory()
        let restored = try await loader.image(for: photoURL)
        XCTAssertEqual(restored.width, 128)
        XCTAssertEqual(AvatarTransport.requestCount, 2)
    }
    func testForegroundConditionallyRevalidatesAndSameURLReplacementUpdates() async throws {
        let directory = try directory()
        let modified = "Wed, 02 Sep 2026 12:00:00 GMT"
        AvatarTransport.configure(data: try photo(), headers: ["ETag": "\"v1\"", "Last-Modified": modified])
        let loader = TaskifyWatchAvatarLoader(directory: directory, session: session())
        _ = try await loader.image(for: photoURL)
        let relaunched = TaskifyWatchAvatarLoader(directory: directory, session: session())
        AvatarTransport.configure(status: 304)
        let revalidated = try await relaunched.image(for: photoURL)
        XCTAssertEqual(revalidated.height, 64)
        XCTAssertEqual(AvatarTransport.request?.value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
        XCTAssertEqual(AvatarTransport.request?.value(forHTTPHeaderField: "If-Modified-Since"), modified)
        _ = try await relaunched.image(for: photoURL)
        XCTAssertEqual(AvatarTransport.requestCount, 1)

        await relaunched.beginSession()
        AvatarTransport.configure(data: try photo(height: 512), headers: ["ETag": "\"v2\""])
        let replacement = try await relaunched.image(for: photoURL)
        XCTAssertEqual(replacement.height, 128)
        await relaunched.clearMemory()
        let persisted = await relaunched.cachedImage(for: photoURL)
        XCTAssertEqual(persisted?.height, 128)
    }

}

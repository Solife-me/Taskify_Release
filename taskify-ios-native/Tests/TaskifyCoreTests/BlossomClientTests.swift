import Foundation
import XCTest
@testable import TaskifyCore

final class BlossomClientTests: XCTestCase {
    private let testPrivateKey = try! Data(hex: String(repeating: "0", count: 63) + "1")

    func testAuthHeaderSignsAValidKind24242EventWithExpectedTags() throws {
        let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)
        let header = try BlossomClient.authHeader(
            privateKey: testPrivateKey,
            sha256Hex: "abc123",
            now: fixedNow
        )

        XCTAssertTrue(header.hasPrefix("Nostr "))
        let event = try decodedEvent(from: header)

        XCTAssertEqual(event.kind, 24_242)
        XCTAssertEqual(event.content, "Upload Blob")
        XCTAssertEqual(event.createdAt, 1_700_000_000)
        XCTAssertTrue(event.tags.contains(["t", "upload"]))
        XCTAssertTrue(event.tags.contains(["x", "abc123"]))
        XCTAssertTrue(event.tags.contains(["expiration", "1700003600"]))
        XCTAssertTrue(event.verify())
    }

    func testAuthHeaderIsBase64URLEncodedWithoutPadding() throws {
        let header = try BlossomClient.authHeader(privateKey: testPrivateKey, sha256Hex: "deadbeef")
        let token = String(header.dropFirst("Nostr ".count))

        XCTAssertFalse(token.contains("+"))
        XCTAssertFalse(token.contains("/"))
        XCTAssertFalse(token.contains("="))

        // Must still round-trip through a standard base64url decoder (re-add padding manually,
        // since Swift's Data(base64Encoded:) requires it).
        var padded = token.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        XCTAssertNotNil(Data(base64Encoded: padded))
    }

    func testFileServerTypeIsInferredFromHostname() {
        XCTAssertEqual(TaskifyFileServerType.inferred(for: "https://blossom.band"), .blossom)
        XCTAssertEqual(TaskifyFileServerType.inferred(for: "https://cdn.blossom.example.com"), .blossom)
        XCTAssertEqual(TaskifyFileServerType.inferred(for: "https://originless.solife.me"), .other)
        XCTAssertEqual(TaskifyFileServerType.inferred(for: "https://nostr.build"), .other)
    }

    private func decodedEvent(from header: String) throws -> NostrEvent {
        let token = String(header.dropFirst("Nostr ".count))
        var padded = token.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        let data = try XCTUnwrap(Data(base64Encoded: padded))
        return try JSONDecoder().decode(NostrEvent.self, from: data)
    }
}

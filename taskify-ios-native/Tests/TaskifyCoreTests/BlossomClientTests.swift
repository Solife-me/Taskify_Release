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
        XCTAssertEqual(TaskifyFileServerType.inferred(for: "https://originless.solife.me"), .originless)
        XCTAssertEqual(TaskifyFileServerType.inferred(for: "https://nostr.build"), .nip96)
        // "originless" wins if a hostname somehow matched both heuristics, matching the PWA's
        // inferFileServerType check order (originless checked before blossom).
        XCTAssertEqual(TaskifyFileServerType.inferred(for: "https://originless-blossom.example.com"), .originless)
    }

    func testNip98AuthHeaderSignsUploadURLMethodAndPayload() throws {
        let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)
        let uploadURL = try XCTUnwrap(URL(string: "https://files.example/api/v1/nip96"))
        let header = try Nip96Client.authHeader(
            privateKey: testPrivateKey,
            url: uploadURL,
            method: "POST",
            sha256Hex: "abc123",
            now: fixedNow
        )

        XCTAssertTrue(header.hasPrefix("Nostr "))
        let token = String(header.dropFirst("Nostr ".count))
        let data = try XCTUnwrap(Data(base64Encoded: token))
        let event = try JSONDecoder().decode(NostrEvent.self, from: data)

        XCTAssertEqual(event.kind, 27_235)
        XCTAssertEqual(event.content, "")
        XCTAssertEqual(event.createdAt, 1_700_000_000)
        XCTAssertTrue(event.tags.contains(["u", uploadURL.absoluteString]))
        XCTAssertTrue(event.tags.contains(["method", "POST"]))
        XCTAssertTrue(event.tags.contains(["payload", "abc123"]))
        XCTAssertTrue(event.verify())
    }

    func testNip96DiscoveryResolvesRelativeAPIURL() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://files.example"))
        let data = try JSONSerialization.data(withJSONObject: ["api_url": "/api/v1/nip96"])

        let result = try Nip96Client.parseDiscoveryResponse(data, baseURL: baseURL)

        XCTAssertEqual(result.apiURL?.absoluteString, "https://files.example/api/v1/nip96")
        XCTAssertNil(result.delegatedServerURL)
    }

    func testNip96DiscoveryRecognizesDelegatedServer() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://files.example"))
        let data = try JSONSerialization.data(withJSONObject: [
            "delegated_to_url": "https://uploads.example",
        ])

        let result = try Nip96Client.parseDiscoveryResponse(data, baseURL: baseURL)

        XCTAssertNil(result.apiURL)
        XCTAssertEqual(result.delegatedServerURL?.absoluteString, "https://uploads.example")
    }

    func testNip96UploadResponsePrefersNip94URLTag() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "url": "https://fallback.example/blob",
            "nip94_event": [
                "tags": [["url", "https://cdn.example/blob"]],
            ],
        ])

        XCTAssertEqual(
            try Nip96Client.remoteURL(from: data)?.absoluteString,
            "https://cdn.example/blob"
        )
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

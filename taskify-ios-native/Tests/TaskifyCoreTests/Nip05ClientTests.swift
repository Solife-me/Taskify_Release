import Foundation
import XCTest
@testable import TaskifyCore

final class Nip05ClientTests: XCTestCase {
    func testIdentifierWithoutNameUsesUnderscoreAndHTTPS() throws {
        let request = try Nip05Client.request(for: "Example.COM")

        XCTAssertEqual(request.name, "_")
        XCTAssertEqual(request.domain, "example.com")
        XCTAssertEqual(
            request.url.absoluteString,
            "https://example.com/.well-known/nostr.json?name=_"
        )
    }

    func testIdentifierWithNameIsNormalized() throws {
        let request = try Nip05Client.request(for: " Alice@Example.COM ")

        XCTAssertEqual(request.identifier, "alice@example.com")
        XCTAssertEqual(request.name, "alice")
        XCTAssertEqual(request.domain, "example.com")
    }

    func testResponseMatchesExpectedPublicKeyAndNormalizesRelays() throws {
        let key = String(repeating: "a", count: 64)
        let data = try JSONSerialization.data(withJSONObject: [
            "names": ["alice": key.uppercased()],
            "relays": [key: ["wss://relay.example", "wss://relay.example/", "http://bad.example"]],
        ])

        let result = try Nip05Client.parse(
            data,
            request: try Nip05Client.request(for: "alice@example.com")
        )

        XCTAssertEqual(result.publicKeyHex, key)
        XCTAssertEqual(result.relayURLs, ["wss://relay.example"])
        XCTAssertTrue(result.matches(publicKeyHex: key.uppercased()))
    }

    func testResponseRejectsMissingOrInvalidPublicKey() throws {
        let request = try Nip05Client.request(for: "alice@example.com")
        let missing = try JSONSerialization.data(withJSONObject: ["names": ["bob": String(repeating: "b", count: 64)]])
        let invalid = try JSONSerialization.data(withJSONObject: ["names": ["alice": "not-a-key"]])

        XCTAssertThrowsError(try Nip05Client.parse(missing, request: request))
        XCTAssertThrowsError(try Nip05Client.parse(invalid, request: request))
    }

    func testIdentifierRejectsURLsAndMalformedNames() {
        XCTAssertThrowsError(try Nip05Client.request(for: "https://example.com"))
        XCTAssertThrowsError(try Nip05Client.request(for: "alice@@example.com"))
        XCTAssertThrowsError(try Nip05Client.request(for: "alice@localhost"))
        XCTAssertThrowsError(try Nip05Client.request(for: ""))
    }
}

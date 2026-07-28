import Foundation
import XCTest
@testable import TaskifyCore

final class NpubCashClientTests: XCTestCase {
    private let senderPrivateKey = String(repeating: "0", count: 63) + "1"

    func testIdentityDerivesAddressFromNpub() {
        let identity = NpubCashClient.identity(npub: "npub1example")
        XCTAssertEqual(identity.npub, "npub1example")
        XCTAssertEqual(identity.address, "npub1example@npub.cash")
    }

    func testAuthHeaderProducesAValidSignedNIP98Event() throws {
        let identity = try NostrIdentity(privateKey: Data(hex: senderPrivateKey))
        let header = try NpubCashClient.authHeader(
            urlString: "https://npub.cash/api/v1/claim",
            method: "GET",
            identity: identity
        )

        XCTAssertTrue(header.hasPrefix("Nostr "))
        let base64 = String(header.dropFirst("Nostr ".count))
        let payload = try XCTUnwrap(Data(base64Encoded: base64))
        let event = try JSONDecoder().decode(NostrEvent.self, from: payload)

        XCTAssertEqual(event.kind, 27_235)
        XCTAssertEqual(event.publicKey, identity.publicKeyHex)
        XCTAssertTrue(event.tags.contains(["u", "https://npub.cash/api/v1/claim"]))
        XCTAssertTrue(event.tags.contains(["method", "GET"]))
        XCTAssertTrue(event.verify())
    }

    func testExtractBalanceHandlesVariousResponseShapes() {
        XCTAssertEqual(NpubCashClient.extractBalance(from: Data("42".utf8)), 42)
        XCTAssertEqual(NpubCashClient.extractBalance(from: Data(#"{"balance": 21}"#.utf8)), 21)
        XCTAssertEqual(
            NpubCashClient.extractBalance(from: Data(#"{"data": {"balance": 7}}"#.utf8)),
            7
        )
        XCTAssertEqual(NpubCashClient.extractBalance(from: Data("not json".utf8)), 0)
    }

    func testExtractTokensHandlesArrayNestedAndPlainTextShapes() {
        XCTAssertEqual(
            NpubCashClient.extractTokens(from: Data(#"["cashuAone", "cashuBtwo"]"#.utf8)),
            ["cashuAone", "cashuBtwo"]
        )
        XCTAssertEqual(
            NpubCashClient.extractTokens(from: Data(#"{"data": ["cashuAnested"]}"#.utf8)),
            ["cashuAnested"]
        )
        XCTAssertEqual(
            NpubCashClient.extractTokens(from: Data("Here is your token: cashuAplaintext, enjoy".utf8)),
            ["cashuAplaintext"]
        )
        XCTAssertEqual(NpubCashClient.extractTokens(from: Data("{}".utf8)), [])
    }
}

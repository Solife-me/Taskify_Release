import Foundation
import XCTest
@testable import TaskifyCore

final class IdentityImportTests: XCTestCase {
    // Generated with the PWA's nostr-tools, independently of the native encoder.
    private let nsec = "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz"
    private let publicKey = "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"

    func testPWAKeyAndClipboardFormattingKeepSameIdentity() throws {
        let wrapped = String(nsec.prefix(24)) + "\n\t " + String(nsec.dropFirst(24))
        for input in [nsec, nsec.uppercased(), "nostr:" + nsec,
                      " NOSTR:" + nsec.uppercased() + "\n", wrapped,
                      "\u{FEFF}" + nsec + "\u{200B}", String(repeating: "11", count: 32)] {
            let identity = try NostrIdentity(importedValue: input)
            XCTAssertEqual(identity.publicKeyHex, publicKey)
            XCTAssertEqual(identity.nsec, nsec)
        }
    }

    func testHexAcceptsBothLetterCases() throws {
        let hex = String(repeating: "ab", count: 32)
        let expected = try NostrIdentity(privateKey: Data(hex: hex))
        for input in [hex, hex.uppercased(), " \n" + hex.uppercased() + "\t"] {
            XCTAssertEqual(try NostrIdentity(importedValue: input), expected)
        }
    }

    func testInvalidKeysRemainRejected() throws {
        let identity = try NostrIdentity(importedValue: nsec)
        let wrongSize = try Bech32.encode(prefix: "nsec", data: Data(repeating: 1, count: 31))
        for input in ["", "nsec", String(nsec.dropLast()), String(nsec.dropLast()) + "q",
                      "N" + String(nsec.dropFirst()), identity.npub, wrongSize,
                      String(repeating: "0", count: 64), String(repeating: "f", count: 64),
                      "Private key: " + nsec, nsec + "?foo=bar", nsec + nsec] {
            XCTAssertThrowsError(try NostrIdentity(importedValue: input)) { error in
                XCTAssertTrue(error is NostrIdentityError)
            }
        }
    }
}

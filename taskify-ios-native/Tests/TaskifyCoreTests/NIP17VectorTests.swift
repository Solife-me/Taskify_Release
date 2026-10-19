import Foundation
import XCTest
@testable import TaskifyCore

/// The NIP-17 vectors shared with the web and CLI (taskify-core/fixtures/nip17-vectors.json):
/// every client opens the same gift wraps and rejects the same ones.
final class NIP17VectorTests: XCTestCase {
    private struct Account: Decodable {
        var secretKey: String
        var pubkey: String
    }

    private struct Expected: Decodable {
        var senderPubkey: String
        var rumorId: String
        var kind: Int
        var content: String
        var tags: [[String]]
        var createdAt: Int
        var recipients: [String]?
    }

    private struct Vector: Decodable {
        var name: String
        var receiver: String
        var wrap: NostrEvent
        var expected: Expected?
    }

    private struct VectorFile: Decodable {
        var accounts: [String: Account]
        var vectors: [Vector]
    }

    private static let vectorsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // TaskifyCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // taskify-ios-native
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("taskify-core/fixtures/nip17-vectors.json")

    func testGiftWrapsOpenAsTheSharedVectorsSay() throws {
        let file = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: Self.vectorsURL))
        XCTAssertTrue(file.vectors.contains { $0.expected != nil })
        XCTAssertTrue(file.vectors.contains { $0.expected == nil })

        for vector in file.vectors {
            let account = try XCTUnwrap(file.accounts[vector.receiver], vector.name)
            let receiver = try NostrIdentity(privateKey: Data(hex: account.secretKey))
            let opened = try? NIP17GiftWrap.unwrapRumor(vector.wrap, recipient: receiver)
            guard let expected = vector.expected else {
                XCTAssertNil(opened, "\(vector.name) must be rejected")
                continue
            }
            let rumor = try XCTUnwrap(opened, "\(vector.name) must open").rumor
            XCTAssertEqual(rumor.publicKey.lowercased(), expected.senderPubkey, vector.name)
            XCTAssertEqual(rumor.id.lowercased(), expected.rumorId, vector.name)
            XCTAssertEqual(rumor.kind, expected.kind, vector.name)
            XCTAssertEqual(rumor.content, expected.content, vector.name)
            XCTAssertEqual(rumor.tags, expected.tags, vector.name)
            XCTAssertEqual(rumor.createdAt, expected.createdAt, vector.name)
        }
    }
}

import Foundation
import Testing
@testable import TaskifyCore

struct NostrEventSigningTests {
    @Test("unsigned event signs with relay-valid schnorr signature over raw event id bytes")
    func signsRawEventIdBytes() throws {
        let boardInfo = try BoardKeyInfo(boardId: "test-board-id")
        let unsigned = UnsignedNostrEvent(
            pubkey: boardInfo.publicKeyHex,
            kind: 30301,
            tags: [["d", "task-123"], ["b", boardTagHash("test-board-id")], ["col", ""], ["status", "open"]],
            content: "payload"
        )

        let event = try unsigned.sign(privateKeyBytes: boardInfo.privateKeyBytes)
        #expect(try event.verifyId())

        let idBytes = try #require(Data(hexString: event.id))
        let sigBytes = try #require(Data(hexString: event.sig))
        let pubkeyBytes = Data(hexString: event.pubkey)!

        #expect(try Secp256k1Helpers.schnorrVerify(signature: sigBytes, message: idBytes, publicKeyBytes: pubkeyBytes))
    }
}

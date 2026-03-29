import Foundation
import Testing
@testable import TaskifyCore

@Suite("NostrIdentityService")
struct NostrIdentityServiceTests {

    @Test("normalizes 64-hex secret key input")
    func normalizesHexInput() throws {
        let raw = "  ABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD  "
        let normalized = try NostrIdentityService.normalizeSecretKeyInput(raw)
        #expect(normalized == "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd")
    }

    @Test("decodes nsec to 64-hex")
    func decodesNsec() throws {
        let nsec = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl"
        let normalized = try NostrIdentityService.normalizeSecretKeyInput(nsec)
        #expect(normalized == "0000000000000000000000000000000000000000000000000000000000000001")
    }

    @Test("rejects invalid secret key input")
    func rejectsInvalid() {
        #expect(throws: (any Error).self) {
            _ = try NostrIdentityService.normalizeSecretKeyInput("nope")
        }
    }

    @Test("derives npub from known secret key")
    func derivesNpubKnownVector() throws {
        let hex = "0000000000000000000000000000000000000000000000000000000000000001"
        let npub = try NostrIdentityService.deriveNpub(fromSecretKeyHex: hex)
        #expect(npub == "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d")
    }

    @Test("importIdentity returns normalized hex and npub")
    func importIdentity() throws {
        let nsec = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl"
        let identity = try NostrIdentityService.importIdentity(secretKeyInput: nsec)
        #expect(identity.nsecHex == "0000000000000000000000000000000000000000000000000000000000000001")
        #expect(identity.npub == "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d")
    }
}

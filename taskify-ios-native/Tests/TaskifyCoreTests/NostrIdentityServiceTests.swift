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

    @Test("derives nsec from known secret key")
    func derivesNsecKnownVector() throws {
        let hex = "0000000000000000000000000000000000000000000000000000000000000001"
        let nsec = try NostrIdentityService.deriveNsec(fromSecretKeyHex: hex)
        #expect(nsec == "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl")
    }

    @Test("importIdentity returns normalized hex and npub")
    func importIdentity() throws {
        let nsec = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl"
        let identity = try NostrIdentityService.importIdentity(secretKeyInput: nsec)
        #expect(identity.nsecHex == "0000000000000000000000000000000000000000000000000000000000000001")
        #expect(identity.npub == "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d")
    }

    @Test("normalizes npub and compressed public keys to raw hex")
    func normalizesPublicKeyInput() throws {
        let npub = "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d"
        let normalized = try NostrIdentityService.normalizePublicKeyInput(npub)
        #expect(normalized == "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")

        let compressed = "02" + normalized
        let compressedNormalized = try NostrIdentityService.normalizePublicKeyInput(compressed)
        #expect(compressedNormalized == normalized)
    }

    @Test("encodes raw public key hex as npub")
    func encodesPublicKeyHexAsNpub() throws {
        let raw = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        let encoded = try NostrIdentityService.encodeNpub(fromPublicKeyHex: raw)
        #expect(encoded == "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d")
    }
}

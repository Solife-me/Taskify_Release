/// Secp256k1Helpers.swift
/// Wraps nostr-sdk-ios crypto primitives for Nostr key operations,
/// while using raw secp256k1 Schnorr signing for relay-valid Nostr event signatures.

import Foundation
import NostrSDK
import Security
import secp256k1

private struct TaskifySignatureVerifier: SignatureVerifying { init() {} }

public enum Secp256k1Helpers {

    /// Returns (compressedPublicKey[33], conversationKey[32])
    public static func derivePublicKeyAndConversationKey(
        privateKeyBytes: Data
    ) throws -> (publicKey: Data, conversationKey: Data) {
        let privateKey = try makePrivateKey(privateKeyBytes)
        guard let keypair = Keypair(privateKey: privateKey) else {
            throw TaskifyCryptoError.secp256k1Error("Unable to derive keypair from private key")
        }

        let conversationKey = try NostrSDK.NIP44v2.conversationKey(privateKeyA: privateKey, publicKeyB: keypair.publicKey)
        let compressedPub = Data(hexString: "02\(keypair.publicKey.hex)")!
        return (compressedPub, conversationKey)
    }

    /// NIP-44 v2 conversation key for arbitrary peer public key.
    public static func deriveConversationKey(
        privateKeyBytes: Data,
        publicKeyHex: String
    ) throws -> Data {
        let privateKey = try makePrivateKey(privateKeyBytes)
        let normalizedPublicKey = try NostrIdentityService.normalizePublicKeyInput(publicKeyHex)
        guard let publicKey = PublicKey(hex: normalizedPublicKey) else {
            throw NostrIdentityService.IdentityError.invalidPublicKey
        }
        return try NostrSDK.NIP44v2.conversationKey(privateKeyA: privateKey, publicKeyB: publicKey)
    }

    public static func nip44ConversationKey(
        privateKeyBytes: Data,
        publicKeyHex: String
    ) throws -> Data {
        try deriveConversationKey(privateKeyBytes: privateKeyBytes, publicKeyHex: publicKeyHex)
    }

    /// Returns x-only pubkey (32 bytes) from private key.
    public static func xOnlyPublicKey(from privateKeyBytes: Data) throws -> Data {
        let privateKey = try makePrivateKey(privateKeyBytes)
        guard let keypair = Keypair(privateKey: privateKey) else {
            throw TaskifyCryptoError.secp256k1Error("Unable to derive x-only public key")
        }
        return keypair.publicKey.dataRepresentation
    }

    /// Signs the raw 32-byte event id bytes with Schnorr.
    /// This must sign the digest bytes directly, not the hex string representation,
    /// otherwise relays reject the event signature.
    public static func schnorrSign(message: Data, privateKeyBytes: Data) throws -> Data {
        guard message.count == 32 else {
            throw TaskifyCryptoError.secp256k1Error("Expected 32-byte event id, got \(message.count)")
        }
        let signingKey = try secp256k1.Schnorr.PrivateKey(dataRepresentation: [UInt8](privateKeyBytes))
        var msg = [UInt8](message)
        var aux = randomBytes(count: 64)
        let sig = try signingKey.signature(message: &msg, auxiliaryRand: &aux)
        return sig.dataRepresentation
    }

    /// Verifies Schnorr signature over raw 32-byte message bytes.
    public static func schnorrVerify(
        signature: Data,
        message: Data,
        publicKeyBytes: Data
    ) throws -> Bool {
        guard message.count == 32 else {
            throw TaskifyCryptoError.secp256k1Error("Expected 32-byte event id, got \(message.count)")
        }
        let sig = try secp256k1.Schnorr.SchnorrSignature(dataRepresentation: [UInt8](signature))
        let xonly = secp256k1.Schnorr.XonlyKey(dataRepresentation: [UInt8](publicKeyBytes))
        var msg = [UInt8](message)
        return xonly.isValid(sig, for: &msg)
    }

    private static func makePrivateKey(_ privateKeyBytes: Data) throws -> PrivateKey {
        guard privateKeyBytes.count == 32, let privateKey = PrivateKey(dataRepresentation: privateKeyBytes) else {
            throw TaskifyCryptoError.invalidKeyLength
        }
        return privateKey
    }

    private static func randomBytes(count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(status == errSecSuccess, "Failed to generate secure random bytes")
        return Data(bytes)
    }
}

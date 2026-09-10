import CryptoKit
import Foundation
import P256K

public enum TaskifyWatchNIP44V2Error: LocalizedError, Equatable {
    case invalidKey
    case invalidPayload
    case unsupportedVersion
    case authenticationFailed
    case invalidPadding

    public var errorDescription: String? {
        switch self {
        case .invalidKey: "The Nostr message encryption key is invalid."
        case .invalidPayload: "The encrypted Nostr message is malformed."
        case .unsupportedVersion: "The Nostr message uses an unsupported encryption version."
        case .authenticationFailed: "The encrypted Nostr message could not be authenticated."
        case .invalidPadding: "The encrypted Nostr message has invalid padding."
        }
    }
}

/// A watchOS-safe NIP-44 v2 implementation. The bounds deliberately match TaskifyCore so
/// ciphertext produced on Watch is interoperable with iPhone/PWA and untrusted relay payloads
/// cannot trigger an unbounded allocation.
public enum TaskifyWatchNIP44V2 {
    private static let maximumPayloadBytes = 2_000_000

    public static func conversationKey(privateKey: Data, publicKey: Data) throws -> Data {
        guard privateKey.count == 32, publicKey.count == 32 else {
            throw TaskifyWatchNIP44V2Error.invalidKey
        }
        do {
            let secretKey = try P256K.KeyAgreement.PrivateKey(dataRepresentation: privateKey)
            let peerKey = try P256K.KeyAgreement.PublicKey(
                dataRepresentation: Data([0x02]) + publicKey,
                format: .compressed
            )
            let sharedSecret = secretKey.sharedSecretFromKeyAgreement(with: peerKey, format: .compressed)
            let serializedPoint = sharedSecret.withUnsafeBytes { Data($0) }
            guard serializedPoint.count == 33 else {
                throw TaskifyWatchNIP44V2Error.invalidKey
            }
            let salt = SymmetricKey(data: Data("nip44-v2".utf8))
            return Data(HMAC<CryptoKit.SHA256>.authenticationCode(
                for: serializedPoint.dropFirst(),
                using: salt
            ))
        } catch let error as TaskifyWatchNIP44V2Error {
            throw error
        } catch {
            throw TaskifyWatchNIP44V2Error.invalidKey
        }
    }

    public static func encrypt(
        _ plaintext: Data,
        privateKey: Data,
        publicKey: Data,
        nonce: Data? = nil
    ) throws -> String {
        try encrypt(
            plaintext,
            conversationKey: conversationKey(privateKey: privateKey, publicKey: publicKey),
            nonce: nonce
        )
    }

    public static func decrypt(
        _ payload: String,
        privateKey: Data,
        publicKey: Data
    ) throws -> Data {
        try decrypt(
            payload,
            conversationKey: conversationKey(privateKey: privateKey, publicKey: publicKey)
        )
    }

    public static func encrypt(
        _ plaintext: Data,
        conversationKey: Data,
        nonce: Data? = nil
    ) throws -> String {
        guard !plaintext.isEmpty, plaintext.count <= maximumPayloadBytes else {
            throw TaskifyWatchNIP44V2Error.invalidPayload
        }
        let resolvedNonce = nonce ?? randomNonce()
        guard conversationKey.count == 32, resolvedNonce.count == 32 else {
            throw TaskifyWatchNIP44V2Error.invalidKey
        }
        let keys = deriveMessageKeys(conversationKey: conversationKey, nonce: resolvedNonce)
        let ciphertext = TaskifyWatchChaCha20.xor(
            pad(plaintext),
            key: keys.chachaKey,
            nonce: keys.chachaNonce
        )
        let authenticatedData = resolvedNonce + ciphertext
        let mac = Data(HMAC<CryptoKit.SHA256>.authenticationCode(
            for: authenticatedData,
            using: SymmetricKey(data: keys.hmacKey)
        ))
        return (Data([2]) + resolvedNonce + ciphertext + mac).base64EncodedString()
    }

    public static func decrypt(_ payload: String, conversationKey: Data) throws -> Data {
        let maximumEnvelopeBytes = paddedLength(for: maximumPayloadBytes) + 6 + 65
        guard conversationKey.count == 32,
              payload.utf8.count <= 4 * ((maximumEnvelopeBytes + 2) / 3),
              payload.count >= 132,
              payload.first != "#",
              let raw = Data(base64Encoded: payload),
              raw.count >= 99,
              raw.count <= maximumEnvelopeBytes else {
            throw TaskifyWatchNIP44V2Error.invalidPayload
        }
        guard raw[raw.startIndex] == 2 else {
            throw TaskifyWatchNIP44V2Error.unsupportedVersion
        }
        let nonce = raw.subdata(in: 1..<33)
        let ciphertext = raw.subdata(in: 33..<(raw.count - 32))
        let receivedMAC = raw.suffix(32)
        let keys = deriveMessageKeys(conversationKey: conversationKey, nonce: nonce)
        let authenticatedData = nonce + ciphertext
        let calculatedMAC = Data(HMAC<CryptoKit.SHA256>.authenticationCode(
            for: authenticatedData,
            using: SymmetricKey(data: keys.hmacKey)
        ))
        guard constantTimeEqual(calculatedMAC, receivedMAC) else {
            throw TaskifyWatchNIP44V2Error.authenticationFailed
        }
        return try unpad(TaskifyWatchChaCha20.xor(
            ciphertext,
            key: keys.chachaKey,
            nonce: keys.chachaNonce
        ))
    }

    private static func deriveMessageKeys(
        conversationKey: Data,
        nonce: Data
    ) -> (chachaKey: Data, chachaNonce: Data, hmacKey: Data) {
        let expanded = HKDF<CryptoKit.SHA256>.expand(
            pseudoRandomKey: SymmetricKey(data: conversationKey),
            info: nonce,
            outputByteCount: 76
        ).withUnsafeBytes { Data($0) }
        return (
            expanded.subdata(in: 0..<32),
            expanded.subdata(in: 32..<44),
            expanded.subdata(in: 44..<76)
        )
    }

    private static func pad(_ plaintext: Data) -> Data {
        let length = plaintext.count
        let prefix: [UInt8]
        if length >= 65_536 {
            prefix = [
                0, 0,
                UInt8(truncatingIfNeeded: length >> 24),
                UInt8(truncatingIfNeeded: length >> 16),
                UInt8(truncatingIfNeeded: length >> 8),
                UInt8(truncatingIfNeeded: length),
            ]
        } else {
            prefix = [
                UInt8(truncatingIfNeeded: length >> 8),
                UInt8(truncatingIfNeeded: length),
            ]
        }
        return Data(prefix) + plaintext + Data(
            repeating: 0,
            count: paddedLength(for: length) - length
        )
    }

    private static func unpad(_ padded: Data) throws -> Data {
        guard padded.count >= 34 else { throw TaskifyWatchNIP44V2Error.invalidPadding }
        let firstTwo = (Int(padded[0]) << 8) | Int(padded[1])
        let prefixLength: Int
        let plaintextLength: Int
        if firstTwo == 0 {
            guard padded.count >= 6 else { throw TaskifyWatchNIP44V2Error.invalidPadding }
            plaintextLength = (Int(padded[2]) << 24)
                | (Int(padded[3]) << 16)
                | (Int(padded[4]) << 8)
                | Int(padded[5])
            prefixLength = 6
            guard plaintextLength >= 65_536 else {
                throw TaskifyWatchNIP44V2Error.invalidPadding
            }
        } else {
            plaintextLength = firstTwo
            prefixLength = 2
        }
        guard plaintextLength >= 1,
              plaintextLength <= maximumPayloadBytes,
              padded.count == prefixLength + paddedLength(for: plaintextLength),
              prefixLength + plaintextLength <= padded.count else {
            throw TaskifyWatchNIP44V2Error.invalidPadding
        }
        return padded.subdata(in: prefixLength..<(prefixLength + plaintextLength))
    }

    private static func paddedLength(for length: Int) -> Int {
        if length <= 32 { return 32 }
        var nextPower = 1
        while nextPower < length { nextPower <<= 1 }
        let chunk = nextPower <= 256 ? 32 : nextPower / 8
        return chunk * (((length - 1) / chunk) + 1)
    }

    private static func randomNonce() -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    private static func constantTimeEqual<D: DataProtocol>(_ lhs: Data, _ rhs: D) -> Bool {
        let right = Data(rhs)
        guard lhs.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in lhs.indices {
            difference |= lhs[index] ^ right[index]
        }
        return difference == 0
    }
}

private enum TaskifyWatchChaCha20 {
    static func xor(_ input: Data, key: Data, nonce: Data) -> Data {
        precondition(key.count == 32 && nonce.count == 12)
        let inputBytes = [UInt8](input)
        let keyBytes = [UInt8](key)
        let nonceBytes = [UInt8](nonce)
        var output = inputBytes
        var counter: UInt32 = 0
        for offset in stride(from: 0, to: inputBytes.count, by: 64) {
            let keyStream = block(key: keyBytes, counter: counter, nonce: nonceBytes)
            for index in 0..<min(64, inputBytes.count - offset) {
                output[offset + index] = inputBytes[offset + index] ^ keyStream[index]
            }
            counter &+= 1
        }
        return Data(output)
    }

    private static func block(key: [UInt8], counter: UInt32, nonce: [UInt8]) -> [UInt8] {
        var state: [UInt32] = [
            0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574,
            word(key, 0), word(key, 4), word(key, 8), word(key, 12),
            word(key, 16), word(key, 20), word(key, 24), word(key, 28),
            counter, word(nonce, 0), word(nonce, 4), word(nonce, 8),
        ]
        let initial = state
        for _ in 0..<10 {
            quarterRound(&state, 0, 4, 8, 12)
            quarterRound(&state, 1, 5, 9, 13)
            quarterRound(&state, 2, 6, 10, 14)
            quarterRound(&state, 3, 7, 11, 15)
            quarterRound(&state, 0, 5, 10, 15)
            quarterRound(&state, 1, 6, 11, 12)
            quarterRound(&state, 2, 7, 8, 13)
            quarterRound(&state, 3, 4, 9, 14)
        }
        var output: [UInt8] = []
        output.reserveCapacity(64)
        for index in state.indices {
            let value = state[index] &+ initial[index]
            output.append(UInt8(truncatingIfNeeded: value))
            output.append(UInt8(truncatingIfNeeded: value >> 8))
            output.append(UInt8(truncatingIfNeeded: value >> 16))
            output.append(UInt8(truncatingIfNeeded: value >> 24))
        }
        return output
    }

    private static func quarterRound(
        _ state: inout [UInt32],
        _ a: Int,
        _ b: Int,
        _ c: Int,
        _ d: Int
    ) {
        state[a] &+= state[b]
        state[d] = rotateLeft(state[d] ^ state[a], by: 16)
        state[c] &+= state[d]
        state[b] = rotateLeft(state[b] ^ state[c], by: 12)
        state[a] &+= state[b]
        state[d] = rotateLeft(state[d] ^ state[a], by: 8)
        state[c] &+= state[d]
        state[b] = rotateLeft(state[b] ^ state[c], by: 7)
    }

    private static func rotateLeft(_ value: UInt32, by amount: UInt32) -> UInt32 {
        (value << amount) | (value >> (32 - amount))
    }

    private static func word(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(bytes[offset])
            | (UInt32(bytes[offset + 1]) << 8)
            | (UInt32(bytes[offset + 2]) << 16)
            | (UInt32(bytes[offset + 3]) << 24)
    }
}

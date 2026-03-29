/// NIP44.swift
/// NIP-44 v2 encryption/decryption — ChaCha20-Poly1305 + HKDF-SHA256 + HMAC-SHA256 MAC.
///
/// Spec: https://github.com/nostr-protocol/nips/blob/master/44.md
///
/// This implementation must be byte-for-bit compatible with nostr-tools nip44.v2
/// as used in the Taskify PWA and CLI.
///
/// Message format (base64-encoded):
///   version[1] || nonce[32] || ciphertext[variable] || MAC[32]
///
/// Key derivation:
///   conversationKey = ECDH(sender_sk, recipient_pk)  [done externally]
///   message_keys = HKDF-SHA256(ikm=conversationKey, info="nip44-v2", len=76)
///     chacha_key      = message_keys[0..32]
///     chacha_nonce    = message_keys[32..44]   (12 bytes)
///     hmac_key        = message_keys[44..76]

import CryptoKit
import Foundation

public enum NIP44 {

    static let version: UInt8 = 2
    static let nonceLength = 32
    static let macLength = 32

    // MARK: - Encrypt

    /// Encrypts a plaintext string using a NIP-44 conversation key.
    /// Returns the base64-encoded NIP-44 v2 payload.
    public static func encrypt(plaintext: String, conversationKey: Data) throws -> String {
        let nonce = Data((0..<nonceLength).map { _ in UInt8.random(in: 0...255) })
        return try encrypt(plaintext: plaintext, conversationKey: conversationKey, nonce: nonce)
    }

    /// Deterministic variant (for testing with known nonce).
    public static func encrypt(plaintext: String, conversationKey: Data, nonce: Data) throws -> String {
        guard nonce.count == nonceLength else { throw NIP44Error.invalidNonce }

        let keys = try deriveMessageKeys(conversationKey: conversationKey, nonce: nonce)
        let paddedPlaintext = pad(plaintext)

        // ChaCha20 encryption (bare stream cipher, no Poly1305)
        let ciphertext = try bareChaCha20(input: paddedPlaintext, key: keys.chachaKey, nonce: keys.chachaNonce)

        // HMAC-SHA256 over (nonce || ciphertext)
        var macInput = Data()
        macInput.append(nonce)
        macInput.append(ciphertext)
        let mac = HMAC<SHA256>.authenticationCode(for: macInput, using: SymmetricKey(data: keys.hmacKey))
        let macData = Data(mac)

        // Assemble: version(1) || nonce(32) || ciphertext || mac(32)
        var payload = Data()
        payload.append(version)
        payload.append(nonce)
        payload.append(ciphertext)
        payload.append(macData)

        return payload.base64EncodedString()
    }

    // MARK: - Decrypt

    /// Decrypts a base64-encoded NIP-44 v2 payload.
    public static func decrypt(payload: String, conversationKey: Data) throws -> String {
        guard let data = Data(base64Encoded: payload) else {
            throw NIP44Error.invalidBase64
        }
        guard !data.isEmpty, data[0] == version else {
            throw NIP44Error.unsupportedVersion
        }
        let minLength = 1 + nonceLength + 32 + macLength // version + nonce + min ciphertext + mac
        guard data.count >= minLength else { throw NIP44Error.payloadTooShort }

        let nonce = data[1..<(1 + nonceLength)]
        let mac = data[(data.count - macLength)...]
        let ciphertext = data[(1 + nonceLength)..<(data.count - macLength)]

        let keys = try deriveMessageKeys(conversationKey: conversationKey, nonce: Data(nonce))

        // Verify HMAC
        var macInput = Data()
        macInput.append(nonce)
        macInput.append(ciphertext)
        let expectedMac = HMAC<SHA256>.authenticationCode(for: macInput, using: SymmetricKey(data: keys.hmacKey))
        guard Data(expectedMac) == Data(mac) else { throw NIP44Error.macMismatch }

        // ChaCha20 decryption
        let paddedPlaintext = try bareChaCha20(input: Data(ciphertext), key: keys.chachaKey, nonce: keys.chachaNonce)

        return try unpad(paddedPlaintext)
    }

    // MARK: - Message Key Derivation

    private struct MessageKeys {
        let chachaKey: Data   // 32 bytes
        let chachaNonce: Data // 12 bytes
        let hmacKey: Data     // 32 bytes
    }

    private static func deriveMessageKeys(conversationKey: Data, nonce: Data) throws -> MessageKeys {
        // HKDF-SHA256(ikm=conversationKey, salt=nonce, info="nip44-v2", len=76)
        let hkdfKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: conversationKey),
            salt: nonce,
            info: Data("nip44-v2".utf8),
            outputByteCount: 76
        )
        let keyBytes = hkdfKey.withUnsafeBytes { Data($0) }
        return MessageKeys(
            chachaKey: keyBytes[0..<32],
            chachaNonce: keyBytes[32..<44],
            hmacKey: keyBytes[44..<76]
        )
    }

    // MARK: - Bare ChaCha20 (RFC 7539)

    /// Bare ChaCha20 stream cipher (no Poly1305 tag).
    /// Used for NIP-44 which does its own HMAC-SHA256 authentication.
    private static func bareChaCha20(input: Data, key: Data, nonce: Data) throws -> Data {
        guard key.count == 32 else { throw NIP44Error.invalidKey }
        guard nonce.count == 12 else { throw NIP44Error.invalidNonce }

        var keyWords = [UInt32](repeating: 0, count: 8)
        for i in 0..<8 {
            keyWords[i] = UInt32(littleEndian: key.withUnsafeBytes { $0.load(fromByteOffset: i * 4, as: UInt32.self) })
        }
        var nonceWords = [UInt32](repeating: 0, count: 3)
        for i in 0..<3 {
            nonceWords[i] = UInt32(littleEndian: nonce.withUnsafeBytes { $0.load(fromByteOffset: i * 4, as: UInt32.self) })
        }

        var output = Data(count: input.count)
        var blockCount: UInt32 = 0
        var offset = 0

        while offset < input.count {
            let block = chaCha20Block(key: keyWords, nonce: nonceWords, counter: blockCount)
            let blockBytes = block.withUnsafeBytes { Data($0) }
            let end = min(offset + 64, input.count)
            for i in offset..<end {
                output[i] = input[i] ^ blockBytes[i - offset]
            }
            offset += 64
            blockCount &+= 1
        }

        return output
    }

    private static func chaCha20Block(key: [UInt32], nonce: [UInt32], counter: UInt32) -> [UInt32] {
        let c: [UInt32] = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
        var s: [UInt32] = [
            c[0], c[1], c[2], c[3],
            key[0], key[1], key[2], key[3],
            key[4], key[5], key[6], key[7],
            counter, nonce[0], nonce[1], nonce[2],
        ]
        var w = s
        for _ in 0..<10 {
            quarterRound(&w, 0, 4, 8, 12)
            quarterRound(&w, 1, 5, 9, 13)
            quarterRound(&w, 2, 6, 10, 14)
            quarterRound(&w, 3, 7, 11, 15)
            quarterRound(&w, 0, 5, 10, 15)
            quarterRound(&w, 1, 6, 11, 12)
            quarterRound(&w, 2, 7, 8, 13)
            quarterRound(&w, 3, 4, 9, 14)
        }
        for i in 0..<16 { s[i] = s[i] &+ w[i] }
        return s
    }

    private static func quarterRound(_ s: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        s[a] = s[a] &+ s[b]; s[d] ^= s[a]; s[d] = rotl(s[d], 16)
        s[c] = s[c] &+ s[d]; s[b] ^= s[c]; s[b] = rotl(s[b], 12)
        s[a] = s[a] &+ s[b]; s[d] ^= s[a]; s[d] = rotl(s[d], 8)
        s[c] = s[c] &+ s[d]; s[b] ^= s[c]; s[b] = rotl(s[b], 7)
    }

    private static func rotl(_ x: UInt32, _ n: Int) -> UInt32 {
        (x << n) | (x >> (32 - n))
    }

    // MARK: - Padding (NIP-44 spec §4)

    /// Pads plaintext to the nearest power-of-2 chunk boundary.
    static func pad(_ plaintext: String) -> Data {
        let utf8 = Data(plaintext.utf8)
        let len = utf8.count
        let paddedLen = calcPaddedLength(len)
        var result = Data(count: 2 + paddedLen)
        // 2-byte big-endian length prefix
        result[0] = UInt8((len >> 8) & 0xFF)
        result[1] = UInt8(len & 0xFF)
        result[2..<(2 + len)] = utf8[...]
        // Remaining bytes are zero (already initialised to 0)
        return result
    }

    static func unpad(_ padded: Data) throws -> String {
        guard padded.count >= 2 else { throw NIP44Error.invalidPadding }
        let len = Int(padded[0]) << 8 | Int(padded[1])
        guard len >= 0, 2 + len <= padded.count else { throw NIP44Error.invalidPadding }
        let utf8 = padded[2..<(2 + len)]
        guard let str = String(data: utf8, encoding: .utf8) else { throw NIP44Error.invalidUTF8 }
        return str
    }

    /// NIP-44 padding: smallest power-of-2 multiple of 32 that fits len+2, clamped to [32, 65535].
    static func calcPaddedLength(_ len: Int) -> Int {
        guard len > 0 else { return 32 }
        let chunk = 32
        let nextPow2 = Int(pow(2.0, ceil(log2(Double(len + 2)))))
        return max(32, min(65535, (max(nextPow2, chunk) + chunk - 1) / chunk * chunk))
    }
}

// MARK: - Errors

public enum NIP44Error: Error, LocalizedError {
    case invalidBase64
    case unsupportedVersion
    case payloadTooShort
    case macMismatch
    case invalidNonce
    case invalidKey
    case invalidPadding
    case invalidUTF8

    public var errorDescription: String? {
        switch self {
        case .invalidBase64: return "NIP-44: Invalid base64 payload"
        case .unsupportedVersion: return "NIP-44: Unsupported version byte"
        case .payloadTooShort: return "NIP-44: Payload too short"
        case .macMismatch: return "NIP-44: MAC verification failed"
        case .invalidNonce: return "NIP-44: Invalid nonce length"
        case .invalidKey: return "NIP-44: Invalid key length"
        case .invalidPadding: return "NIP-44: Invalid padding"
        case .invalidUTF8: return "NIP-44: Decrypted bytes are not valid UTF-8"
        }
    }
}

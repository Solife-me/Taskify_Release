/// BoardCrypto.swift
/// Taskify board encryption/decryption — must produce bit-for-bit compatible
/// output with the PWA (taskify-core/src/boardCrypto.ts) and CLI (calendarCrypto.ts).
///
/// Two distinct schemes are used:
///
/// 1. TASK EVENTS (kind 30301)
///    Key derivation: SHA-256("taskify-board-aes-v1" || UTF8(boardId)) → raw AES-256-GCM key
///    Encryption:     AES-256-GCM, random 12-byte IV prepended to ciphertext → base64
///    Source:         taskify-core/src/boardCrypto.ts  (encryptToBoard / decryptFromBoard)
///
///    Legacy key (pre-fix): SHA-256(UTF8(boardId)) — the same value as the public board tag.
///    The decryptTaskPayload function falls back to this for events written before the fix.
///
/// 2. CALENDAR EVENTS (kind 30310 / 30311)
///    Key derivation: SHA-256("taskify-board-nostr-key-v1" || UTF8(boardId))
///                    → secp256k1 private key → self-ECDH conversation key (NIP-44 v2)
///    Encryption:     NIP-44 v2 (HKDF-SHA256 + ChaCha20-Poly1305 + HMAC-SHA256 MAC)
///    Source:         taskify-cli/src/calendarCrypto.ts
///                    (encryptCalendarPayloadForBoard / decryptCalendarPayloadForBoard)
///
/// 3. BOARD TAG HASH
///    SHA-256(UTF8(boardId)) → lowercase hex
///    Source:         taskify-runtime-nostr/src/boardKeys.ts (boardTagHash)

import CryptoKit
import Foundation

// MARK: - Board Tag Hash

/// Returns the hex-encoded SHA-256 of the board ID.
/// Matches `boardTagHash(boardId)` in boardKeys.ts.
public func boardTagHash(_ boardId: String) -> String {
    let data = Data(boardId.utf8)
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}

// MARK: - Task Event Crypto (AES-256-GCM)

/// Derives the AES-256-GCM key for task events on a given board.
/// Key = SHA-256("taskify-board-aes-v1" || UTF8(boardId))
///
/// The label ensures this key is cryptographically distinct from the public board tag,
/// which is SHA-256(UTF8(boardId)) with no label.
private func deriveBoardAESKey(_ boardId: String) throws -> SymmetricKey {
    let label = Data("taskify-board-aes-v1".utf8)
    var material = label
    material.append(Data(boardId.utf8))
    let digest = SHA256.hash(data: material)
    return SymmetricKey(data: digest)
}

/// Derives the legacy AES-256-GCM key for events written before the key domain-separation fix.
/// Legacy key = SHA-256(UTF8(boardId)) — identical to the public board tag.
private func deriveLegacyBoardAESKey(_ boardId: String) throws -> SymmetricKey {
    let data = Data(boardId.utf8)
    let digest = SHA256.hash(data: data)
    return SymmetricKey(data: digest)
}

/// Encrypts a plaintext string for storage in a kind-30301 task event.
/// Output format: base64(IV[12] || AES-GCM-ciphertext)
public func encryptTaskPayload(_ plaintext: String, boardId: String) throws -> String {
    let key = try deriveBoardAESKey(boardId)
    let plaintextData = Data(plaintext.utf8)
    let sealed = try AES.GCM.seal(plaintextData, using: key)
    // Combine nonce (12 bytes) + ciphertext + GCM tag (16 bytes)
    guard let nonce = sealed.nonce.withUnsafeBytes({ Data($0) }) as Data? else {
        throw TaskifyCryptoError.encryptionFailed
    }
    var combined = Data()
    combined.append(nonce)
    combined.append(sealed.ciphertext)
    combined.append(sealed.tag)
    return combined.base64EncodedString()
}

/// Decrypts a base64-encoded AES-GCM ciphertext from a kind-30301 task event.
/// Tries the secure labeled key first; falls back to the legacy key for events
/// written before the key domain-separation fix.
public func decryptTaskPayload(_ base64Ciphertext: String, boardId: String) throws -> String {
    guard let combined = Data(base64Encoded: base64Ciphertext) else {
        throw TaskifyCryptoError.invalidBase64
    }
    guard combined.count > 28 else { // 12 IV + 1 data min + 16 tag
        throw TaskifyCryptoError.decryptionFailed
    }
    let nonceData = combined.prefix(12)
    let ciphertextAndTag = combined.dropFirst(12)
    guard ciphertextAndTag.count >= 16 else { throw TaskifyCryptoError.decryptionFailed }
    let ciphertext = ciphertextAndTag.dropLast(16)
    let tag = ciphertextAndTag.suffix(16)
    let nonce = try AES.GCM.Nonce(data: nonceData)
    let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)

    // Try secure labeled key first.
    if let plainData = try? AES.GCM.open(sealedBox, using: try deriveBoardAESKey(boardId)),
       let plaintext = String(data: plainData, encoding: .utf8) {
        return plaintext
    }
    // Fall back to legacy key (SHA-256(boardId) = the public tag).
    let legacyKey = try deriveLegacyBoardAESKey(boardId)
    let plainData = try AES.GCM.open(sealedBox, using: legacyKey)
    guard let plaintext = String(data: plainData, encoding: .utf8) else {
        throw TaskifyCryptoError.invalidUTF8
    }
    return plaintext
}

// MARK: - Calendar Event Crypto (NIP-44 v2 / secp256k1)

/// Derives the secp256k1 keypair for calendar events on a given board.
///
/// Matches `deriveBoardKeyPair(boardId)` in boardKeys.ts:
///   material = "taskify-board-nostr-key-v1" || UTF8(boardId)
///   sk = SHA-256(material)
///
/// Returns (privateKeyBytes: 32 bytes, publicKeyBytes: 33 bytes compressed)
public func deriveBoardCalendarKeyPair(_ boardId: String) throws -> BoardCalendarKeyPair {
    let label = "taskify-board-nostr-key-v1"
    var material = Data(label.utf8)
    material.append(Data(boardId.utf8))
    let skBytes = SHA256.hash(data: material)
    let skData = Data(skBytes)
    return try BoardCalendarKeyPair(privateKeyBytes: skData)
}

/// Encrypts a JSON-serialisable payload for a calendar event using NIP-44 v2.
public func encryptCalendarPayload(_ payload: Any, boardId: String) throws -> String {
    let json = try JSONSerialization.data(withJSONObject: payload)
    guard let jsonStr = String(data: json, encoding: .utf8) else {
        throw TaskifyCryptoError.encryptionFailed
    }
    let keyPair = try deriveBoardCalendarKeyPair(boardId)
    return try NIP44.encrypt(plaintext: jsonStr, conversationKey: keyPair.conversationKey)
}

/// Decrypts a NIP-44 v2 ciphertext from a calendar event.
/// Falls back to AES-GCM (legacy CLI format) if NIP-44 decryption fails.
public func decryptCalendarPayload(_ ciphertext: String, boardId: String) throws -> Any {
    let keyPair = try deriveBoardCalendarKeyPair(boardId)

    // Primary: NIP-44 v2
    if let plaintext = try? NIP44.decrypt(payload: ciphertext, conversationKey: keyPair.conversationKey),
       let data = plaintext.data(using: .utf8),
       let json = try? JSONSerialization.jsonObject(with: data) {
        return json
    }

    // Fallback: AES-GCM (legacy format published by older CLI versions).
    // decryptTaskPayload itself tries the secure key then the legacy key.
    let plaintext = try decryptTaskPayload(ciphertext, boardId: boardId)
    guard let data = plaintext.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) else {
        throw TaskifyCryptoError.decryptionFailed
    }
    return json
}

// MARK: - BoardCalendarKeyPair

/// Holds the derived secp256k1 keys for a board's calendar events.
public struct BoardCalendarKeyPair {
    public let privateKeyBytes: Data  // 32 bytes
    public let publicKeyBytes: Data   // 33 bytes compressed
    /// NIP-44 conversation key = ECDH shared secret (self-signed: sk × pk)
    public let conversationKey: Data  // 32 bytes

    public init(privateKeyBytes: Data) throws {
        guard privateKeyBytes.count == 32 else {
            throw TaskifyCryptoError.invalidKeyLength
        }
        self.privateKeyBytes = privateKeyBytes
        // Derive public key and self-ECDH conversation key via secp256k1
        // (implemented in Secp256k1Helpers.swift)
        let (pub, convKey) = try Secp256k1Helpers.derivePublicKeyAndConversationKey(privateKeyBytes: privateKeyBytes)
        self.publicKeyBytes = pub
        self.conversationKey = convKey
    }
}

// MARK: - Errors

public enum TaskifyCryptoError: Error, LocalizedError {
    case encryptionFailed
    case decryptionFailed
    case invalidBase64
    case invalidUTF8
    case invalidKeyLength
    case secp256k1Error(String)

    public var errorDescription: String? {
        switch self {
        case .encryptionFailed: return "Encryption failed"
        case .decryptionFailed: return "Decryption failed"
        case .invalidBase64: return "Invalid base64 input"
        case .invalidUTF8: return "Decrypted bytes are not valid UTF-8"
        case .invalidKeyLength: return "Invalid key length"
        case .secp256k1Error(let msg): return "secp256k1 error: \(msg)"
        }
    }
}

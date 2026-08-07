import CryptoKit
import Foundation
import P256K

public enum BoardCryptoError: LocalizedError {
    case invalidCiphertext
    case invalidPrivateKey

    public var errorDescription: String? {
        switch self {
        case .invalidCiphertext: "The board event could not be decrypted."
        case .invalidPrivateKey: "The board signing key is invalid."
        }
    }
}

public enum BoardCrypto {
    private static let signingDomain = Data("taskify-board-nostr-key-v1".utf8)
    private static let encryptionDomain = Data("taskify-board-aes-v1".utf8)

    public static func boardTag(for boardID: String) -> String {
        Data(SHA256.hash(data: Data(boardID.utf8))).hexString
    }

    public static func signingPrivateKey(for boardID: String) -> Data {
        Data(SHA256.hash(data: signingDomain + Data(boardID.utf8)))
    }

    public static func signingPublicKey(for boardID: String) throws -> Data {
        let privateKey = signingPrivateKey(for: boardID)
        do {
            let key = try P256K.Schnorr.PrivateKey(dataRepresentation: privateKey)
            return Data(key.xonly.bytes)
        } catch {
            throw BoardCryptoError.invalidPrivateKey
        }
    }

    public static func encryptionKey(for boardID: String) -> SymmetricKey {
        SymmetricKey(data: SHA256.hash(data: encryptionDomain + Data(boardID.utf8)))
    }

    public static func encrypt(_ plaintext: Data, boardID: String) throws -> String {
        let sealed = try AES.GCM.seal(plaintext, using: encryptionKey(for: boardID))
        guard let combined = sealed.combined else { throw BoardCryptoError.invalidCiphertext }
        return combined.base64EncodedString()
    }

    public static func encrypt(_ plaintext: Data, boardID: String, nonce: Data) throws -> String {
        guard nonce.count == 12 else { throw BoardCryptoError.invalidCiphertext }
        let sealed = try AES.GCM.seal(
            plaintext,
            using: encryptionKey(for: boardID),
            nonce: try AES.GCM.Nonce(data: nonce)
        )
        guard let combined = sealed.combined else { throw BoardCryptoError.invalidCiphertext }
        return combined.base64EncodedString()
    }

    public static func decrypt(_ content: String, boardID: String) throws -> Data {
        guard let data = Data(base64Encoded: content) else { throw BoardCryptoError.invalidCiphertext }
        do {
            let box = try AES.GCM.SealedBox(combined: data)
            return try AES.GCM.open(box, using: encryptionKey(for: boardID))
        } catch {
            throw BoardCryptoError.invalidCiphertext
        }
    }
}

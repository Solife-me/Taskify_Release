import CryptoKit
import Foundation
import P256K

public enum NostrIdentityError: LocalizedError {
    case invalidPrivateKey

    public var errorDescription: String? {
        "That nsec looks invalid. Paste a valid nsec or 64-character secret key."
    }
}

public struct NostrIdentity: Equatable, Sendable {
    public let privateKey: Data
    public let publicKey: Data

    public init(privateKey: Data) throws {
        guard privateKey.count == 32 else { throw NostrIdentityError.invalidPrivateKey }
        do {
            let key = try P256K.Schnorr.PrivateKey(dataRepresentation: privateKey)
            self.privateKey = privateKey
            self.publicKey = Data(key.xonly.bytes)
        } catch {
            throw NostrIdentityError.invalidPrivateKey
        }
    }

    public init(importedValue: String) throws {
        // Clipboard text may contain line wrapping or invisible separators. Only remove
        // formatting; preserve letter case so Bech32 still rejects mixed-case keys.
        let formatting = CharacterSet.whitespacesAndNewlines
            .union(CharacterSet(charactersIn: "\u{200B}\u{FEFF}"))
        var value = importedValue.unicodeScalars.filter { !formatting.contains($0) }
            .map(String.init).joined()
        if value.lowercased().hasPrefix("nostr:") {
            value = String(value.dropFirst(6))
        }
        do {
            let keyData: Data
            if value.lowercased().hasPrefix("nsec1") {
                keyData = try Bech32.decode(value, expectedPrefix: "nsec")
            } else {
                guard value.count == 64,
                      value.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) else {
                    throw NostrIdentityError.invalidPrivateKey
                }
                keyData = try Data(hex: value)
            }
            try self.init(privateKey: keyData)
        } catch {
            throw NostrIdentityError.invalidPrivateKey
        }
    }

    public static func generate() throws -> NostrIdentity {
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<32 {
            let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
            if let identity = try? NostrIdentity(privateKey: Data(bytes)) {
                return identity
            }
        }
        throw NostrIdentityError.invalidPrivateKey
    }

    public var privateKeyHex: String { privateKey.hexString }
    public var publicKeyHex: String { publicKey.hexString }
    public var nsec: String { (try? Bech32.encode(prefix: "nsec", data: privateKey)) ?? "" }
    public var npub: String { (try? Bech32.encode(prefix: "npub", data: publicKey)) ?? "" }

    /// Authenticate a Taskify Worker request without sending the account secret key.
    public func taskifyRequestHeaders(
        body: Data,
        timestamp: Int = Int(Date().timeIntervalSince1970)
    ) throws -> [String: String] {
        let hash = CryptoKit.SHA256.hash(data: Data("\(timestamp).".utf8) + body)
        let key = try P256K.Schnorr.PrivateKey(dataRepresentation: privateKey)
        var message = Array(hash)
        let signature = try key.signature(message: &message, auxiliaryRand: nil, strict: false)
        return [
            "X-Taskify-Npub": publicKeyHex,
            "X-Taskify-Timestamp": String(timestamp),
            "X-Taskify-Sig": signature.dataRepresentation.hexString,
        ]
    }
}

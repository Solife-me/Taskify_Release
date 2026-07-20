import Foundation
import P256K

public enum NostrIdentityError: LocalizedError {
    case invalidPrivateKey

    public var errorDescription: String? {
        "Enter a 64-character hexadecimal secret key or an nsec value."
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
        let trimmed = importedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let keyData: Data
        if trimmed.lowercased().hasPrefix("nsec1") {
            keyData = try Bech32.decode(trimmed, expectedPrefix: "nsec")
        } else {
            keyData = try Data(hex: trimmed.lowercased())
        }
        try self.init(privateKey: keyData)
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
}

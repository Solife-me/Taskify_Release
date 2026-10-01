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

    /// The text a version-2 Worker request signature covers: a label, the method, the host, the
    /// path with its query, the timestamp, and the body's SHA-256 in hex, one per line. Must match
    /// `taskifyAuthV2Message` in worker/src/nostr-auth.ts, the PWA, and the Watch signer.
    public static func taskifyRequestMessage(method: String, url: URL, timestamp: Int, body: Data) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host?.lowercased(), !host.isEmpty else { return nil }
        let scheme = components.scheme?.lowercased()
        var hostField = host
        if let port = components.port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) {
            hostField += ":\(port)"
        }
        var target = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if let query = components.percentEncodedQuery { target += "?\(query)" }
        return [
            "taskify-request-v2",
            method.uppercased(),
            hostField,
            target,
            String(timestamp),
            Data(CryptoKit.SHA256.hash(data: body)).hexString,
        ].joined(separator: "\n")
    }

    /// Authenticate a Taskify Worker request without sending the account secret key. The
    /// signature covers the method, host, route, and exact body; the Worker accepts it for a
    /// minute, and for voice and Watch publishing only once.
    public func taskifyRequestHeaders(
        method: String,
        url: URL,
        body: Data,
        timestamp: Int = Int(Date().timeIntervalSince1970)
    ) throws -> [String: String] {
        guard let text = Self.taskifyRequestMessage(method: method, url: url, timestamp: timestamp, body: body) else {
            throw URLError(.badURL)
        }
        let hash = CryptoKit.SHA256.hash(data: Data(text.utf8))
        let key = try P256K.Schnorr.PrivateKey(dataRepresentation: privateKey)
        var message = Array(hash)
        let signature = try key.signature(message: &message, auxiliaryRand: nil, strict: false)
        return [
            "X-Taskify-Auth": "v2",
            "X-Taskify-Npub": publicKeyHex,
            "X-Taskify-Timestamp": String(timestamp),
            "X-Taskify-Sig": signature.dataRepresentation.hexString,
        ]
    }
}

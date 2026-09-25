import CommonCrypto
import CryptoKit
import Foundation
import P256K

public enum NWCError: LocalizedError, Equatable {
    case invalidConnection(String)
    case walletError(code: String?, message: String)
    case timedOut
    case relayUnavailable
    case invalidResponse
    case missingMethod(String)
    case invoiceAmountMismatch(expected: UInt64, actual: UInt64?)
    case paymentUnconfirmed

    public var errorDescription: String? {
        switch self {
        case let .invalidConnection(reason): reason
        case let .walletError(_, message): message
        case .timedOut: "Timed out waiting for the wallet to respond."
        case .relayUnavailable: "Couldn't reach the wallet's relay."
        case .invalidResponse: "The wallet sent a response this app can't read."
        case let .missingMethod(method): "This wallet connection doesn't allow \(method)."
        case .paymentUnconfirmed:
            "Your wallet hasn't confirmed this payment yet. Check your wallet's history before trying again."
        case let .invoiceAmountMismatch(expected, actual):
            "The wallet returned an invoice for \(actual.map(String.init) ?? "no") sats instead of \(expected)."
        }
    }
}

/// A parsed `nostr+walletconnect://` connection (NIP-47).
public struct NWCConnection: Equatable, Sendable {
    public let uri: String
    public let walletPublicKey: String
    public let relays: [String]
    public let clientSecretKey: Data
    public let clientPublicKey: String
    public let walletLightningAddress: String?
    public let walletName: String?

    public init(uri rawValue: String) throws {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let schemeRange = trimmed.range(of: "nostr+walletconnect:", options: [.caseInsensitive, .anchored]) else {
            throw NWCError.invalidConnection("A wallet connection starts with nostr+walletconnect://")
        }
        var remainder = String(trimmed[schemeRange.upperBound...])
        while remainder.hasPrefix("/") { remainder.removeFirst() }
        let parts = remainder.split(separator: "?", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty else {
            throw NWCError.invalidConnection("The wallet connection is missing its wallet key or settings.")
        }
        guard let walletKey = Self.hexKey(parts[0].removingPercentEncoding ?? parts[0], expectingPrefix: "npub") else {
            throw NWCError.invalidConnection("The wallet connection has an invalid wallet key.")
        }
        var query = URLComponents()
        query.percentEncodedQuery = parts[1]
        let items = query.queryItems ?? []
        var relays: [String] = []
        for item in items where item.name == "relay" {
            guard let value = item.value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let url = URL(string: value),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "wss" || scheme == "ws" else { continue }
            if !relays.contains(value) { relays.append(value) }
        }
        guard !relays.isEmpty else {
            throw NWCError.invalidConnection("The wallet connection has no relay.")
        }
        guard let secretValue = items.first(where: { $0.name == "secret" })?.value,
              let secretHex = Self.hexKey(secretValue, expectingPrefix: "nsec"),
              let secret = try? Data(hex: secretHex),
              let key = try? P256K.Schnorr.PrivateKey(dataRepresentation: secret) else {
            throw NWCError.invalidConnection("The wallet connection has an invalid secret.")
        }
        uri = trimmed
        walletPublicKey = walletKey
        self.relays = relays
        clientSecretKey = secret
        clientPublicKey = Data(key.xonly.bytes).hexString
        let lud16 = items.first(where: { $0.name == "lud16" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        walletLightningAddress = (lud16?.isEmpty ?? true) ? nil : lud16?.lowercased()
        let name = items.first(where: { $0.name == "name" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        walletName = (name?.isEmpty ?? true) ? nil : name
    }

    public static func == (lhs: NWCConnection, rhs: NWCConnection) -> Bool {
        lhs.uri == rhs.uri
    }

    private static func hexKey(_ value: String, expectingPrefix prefix: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        if lower.count == 64, lower.allSatisfy(\.isHexDigit) { return lower }
        guard lower.hasPrefix(prefix + "1"),
              let data = try? Bech32.decode(lower, expectedPrefix: prefix),
              data.count == 32 else { return nil }
        return data.hexString
    }
}

/// NIP-04 encryption (AES-256-CBC over the secp256k1 shared x-coordinate), which NIP-47
/// wallets accept by default.
public enum NIP04 {
    public static func encrypt(_ plaintext: String, privateKey: Data, publicKey: String) throws -> String {
        let key = try sharedKey(privateKey: privateKey, publicKey: publicKey)
        var iv = Data(count: kCCBlockSizeAES128)
        let status = iv.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, kCCBlockSizeAES128, $0.baseAddress!) }
        guard status == errSecSuccess else { throw NWCError.invalidResponse }
        let cipher = try crypt(Data(plaintext.utf8), key: key, iv: iv, operation: CCOperation(kCCEncrypt))
        return "\(cipher.base64EncodedString())?iv=\(iv.base64EncodedString())"
    }

    public static func decrypt(_ payload: String, privateKey: Data, publicKey: String) throws -> String {
        let parts = payload.components(separatedBy: "?iv=")
        guard parts.count == 2,
              let cipher = Data(base64Encoded: parts[0]),
              let iv = Data(base64Encoded: parts[1]),
              iv.count == kCCBlockSizeAES128 else { throw NWCError.invalidResponse }
        let key = try sharedKey(privateKey: privateKey, publicKey: publicKey)
        let plain = try crypt(cipher, key: key, iv: iv, operation: CCOperation(kCCDecrypt))
        guard let text = String(data: plain, encoding: .utf8) else { throw NWCError.invalidResponse }
        return text
    }

    static func sharedKey(privateKey: Data, publicKey: String) throws -> Data {
        guard let peer = try? Data(hex: publicKey), peer.count == 32, privateKey.count == 32 else {
            throw NWCError.invalidConnection("Invalid key for wallet encryption.")
        }
        do {
            let secret = try P256K.KeyAgreement.PrivateKey(dataRepresentation: privateKey)
            let peerKey = try P256K.KeyAgreement.PublicKey(dataRepresentation: Data([0x02]) + peer, format: .compressed)
            let shared = secret.sharedSecretFromKeyAgreement(with: peerKey, format: .compressed)
            let point = shared.withUnsafeBytes { Data($0) }
            guard point.count == 33 else { throw NWCError.invalidResponse }
            return Data(point.dropFirst())
        } catch let error as NWCError {
            throw error
        } catch {
            throw NWCError.invalidConnection("Invalid key for wallet encryption.")
        }
    }

    private static func crypt(_ input: Data, key: Data, iv: Data, operation: CCOperation) throws -> Data {
        var output = Data(count: input.count + kCCBlockSizeAES128)
        let outputCapacity = output.count
        var moved = 0
        let status = output.withUnsafeMutableBytes { out in
            input.withUnsafeBytes { inBytes in
                key.withUnsafeBytes { keyBytes in
                    iv.withUnsafeBytes { ivBytes in
                        CCCrypt(
                            operation,
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, key.count,
                            ivBytes.baseAddress,
                            inBytes.baseAddress, input.count,
                            out.baseAddress, outputCapacity,
                            &moved
                        )
                    }
                }
            }
        }
        guard status == kCCSuccess else { throw NWCError.invalidResponse }
        return output.prefix(moved)
    }
}

/// Amount (msat) encoded in a BOLT11 invoice's prefix; nil when the invoice has no amount.
public enum Bolt11Amount {
    public static func millisatoshis(_ invoice: String) throws -> UInt64? {
        var lower = invoice.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.hasPrefix("lightning:") { lower.removeFirst("lightning:".count) }
        guard lower.hasPrefix("ln"), let separator = lower.lastIndex(of: "1") else {
            throw NWCError.invalidResponse
        }
        let hrp = lower[lower.index(lower.startIndex, offsetBy: 2)..<separator]
        guard let digitStart = hrp.firstIndex(where: \.isNumber) else { return nil }
        var digits = String(hrp[digitStart...])
        var unit: Character? = nil
        if let last = digits.last, !last.isNumber {
            unit = last
            digits.removeLast()
        }
        guard !digits.isEmpty, digits.allSatisfy(\.isNumber), let value = UInt64(digits) else {
            throw NWCError.invalidResponse
        }
        let (result, overflow): (UInt64, Bool)
        switch unit {
        case nil: (result, overflow) = value.multipliedReportingOverflow(by: 100_000_000_000)
        case "m": (result, overflow) = value.multipliedReportingOverflow(by: 100_000_000)
        case "u": (result, overflow) = value.multipliedReportingOverflow(by: 100_000)
        case "n": (result, overflow) = value.multipliedReportingOverflow(by: 100)
        case "p":
            guard value % 10 == 0 else { throw NWCError.invalidResponse }
            return value / 10
        default: throw NWCError.invalidResponse
        }
        guard !overflow else { throw NWCError.invalidResponse }
        return result
    }
}

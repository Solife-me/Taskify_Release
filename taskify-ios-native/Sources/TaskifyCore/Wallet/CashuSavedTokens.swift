import Cdk
import CryptoKit
import Foundation
import P256K

/// Asking a mint whether a token's proofs are spent (NUT-07), for any mint, without adding it to
/// the wallet. Used by close-out (C9-3): a saved token redeemed in another wallet must not block
/// the wallet from closing.
public enum CashuNUT07 {
    /// POSTs a JSON body to a URL and returns the response body.
    public typealias Post = @Sendable (URL, Data) async throws -> Data

    public enum TokenState: Equatable, Sendable {
        /// At least one proof can still be redeemed: the token holds money.
        case unspent
        /// Every proof is spent: the token was redeemed, here or elsewhere.
        case spent
        /// The token could not be read, or its mint could not be asked.
        case unknown
    }

    private static let domainSeparator = Data("Secp256k1_HashToCurve_Cashu_".utf8)

    /// NUT-00 `hash_to_curve`: the point Y a mint records for a proof's secret, compressed.
    public static func hashToCurve(_ message: Data) throws -> Data {
        let messageHash = Data(SHA256.hash(data: domainSeparator + message))
        for counter in UInt32(0)..<UInt32(1 << 16) {
            var littleEndian = counter.littleEndian
            let counterBytes = Data(bytes: &littleEndian, count: 4)
            let candidate = Data([0x02]) + Data(SHA256.hash(data: messageHash + counterBytes))
            if let point = try? P256K.KeyAgreement.PublicKey(dataRepresentation: candidate, format: .compressed) {
                return point.dataRepresentation
            }
        }
        throw CashuWalletError.invalidPaymentRequest
    }

    public static func state(ofToken encodedToken: String, post: Post = Self.urlSessionPost) async -> TokenState {
        guard let token = try? Token.decode(encodedToken: encodedToken.trimmingCharacters(in: .whitespacesAndNewlines)),
              let mintURL = try? token.mintUrl().url,
              let base = URL(string: mintURL.hasSuffix("/") ? String(mintURL.dropLast()) : mintURL),
              let proofs = try? token.proofsSimple(), !proofs.isEmpty,
              let ys = try? proofs.map({ try hashToCurve(Data($0.secret.utf8)).hexString }) else {
            return .unknown
        }
        struct Response: Decodable {
            struct Entry: Decodable { let Y: String; let state: String }
            let states: [Entry]
        }
        guard let body = try? JSONSerialization.data(withJSONObject: ["Ys": ys]),
              let data = try? await post(base.appendingPathComponent("v1/checkstate"), body),
              let response = try? JSONDecoder().decode(Response.self, from: data) else {
            return .unknown
        }
        let states = Dictionary(response.states.map { ($0.Y.lowercased(), $0.state.uppercased()) }, uniquingKeysWith: { first, _ in first })
        guard ys.allSatisfy({ states[$0] != nil }) else { return .unknown }
        return ys.allSatisfy { states[$0] == "SPENT" } ? .spent : .unspent
    }

    public static let urlSessionPost: Post = { url, body in
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) == true else {
            throw URLError(.badServerResponse)
        }
        return data
    }
}

/// A token this device saved instead of redeeming: a received token waiting to be redeemed, a
/// token from the inbox, or a payment to a request this device made.
public struct CashuSavedToken: Identifiable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable {
        case pendingReceive
        case incomingToken
        case paymentDelivery
    }

    public let id: String
    public let source: Source
    public let token: String
    public let amount: UInt64?
    public let mintURL: String?

    public init(id: String, source: Source, token: String, amount: UInt64?, mintURL: String?) {
        self.id = id
        self.source = source
        self.token = token
        self.amount = amount
        self.mintURL = mintURL
    }
}

/// What close-out does with saved tokens once each one's state is known.
public struct CashuSavedTokenCloseOutPlan: Equatable, Sendable {
    /// Redeemed elsewhere: removed, with a copy kept in the removed-token log.
    public let removeAsSpent: [CashuSavedToken]
    /// Still money: these block close-out until moved out (copied and redeemed elsewhere).
    public let stillHoldFunds: [CashuSavedToken]
    /// Could not be checked: the user may remove them, keeping a copy.
    public let removableByUser: [CashuSavedToken]

    public init(tokens: [CashuSavedToken], states: [String: CashuNUT07.TokenState]) {
        removeAsSpent = tokens.filter { states[$0.id] == .spent }
        stillHoldFunds = tokens.filter { states[$0.id] == .unspent }
        removableByUser = tokens.filter { states[$0.id] == nil || states[$0.id] == .unknown }
    }
}

/// Saved tokens removed from this device, newest first, so a token removed by mistake can still
/// be copied and redeemed (C9-3).
public enum CashuRemovedTokenLog {
    public enum Reason: String, Codable, Sendable {
        case spentElsewhere
        case removedByUser
    }

    public struct Entry: Identifiable, Codable, Equatable, Sendable {
        public let id: String
        public let token: String
        public let amount: UInt64?
        public let mintURL: String?
        public let reason: Reason
        public let removedAt: Date
    }

    public static func defaultURL() throws -> URL {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("TaskifyWallet", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("removed-saved-tokens.json")
    }

    public static func load(from url: URL) -> [Entry] {
        guard let data = FileManager.default.contents(atPath: url.path),
              let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return entries.sorted { $0.removedAt > $1.removedAt }
    }

    public static func append(_ token: CashuSavedToken, reason: Reason, at date: Date = Date(), to url: URL) throws {
        var entries = load(from: url)
        entries.append(Entry(
            id: "\(token.id)-\(Int(date.timeIntervalSince1970 * 1000))",
            token: token.token,
            amount: token.amount,
            mintURL: token.mintURL,
            reason: reason,
            removedAt: date
        ))
        try JSONEncoder().encode(entries.sorted { $0.removedAt > $1.removedAt }).write(to: url, options: .atomic)
    }
}

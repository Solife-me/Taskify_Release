import Cdk
import Foundation
import TaskifyCore

/// What is left of the Taskify wallet after December 1, 2026 (C9-2), read from this device's
/// storage alone: no mint is asked and nothing is written. Matches the PWA's `walletRecovery`:
/// each mint's notes as one token, saved tokens, unclaimed sent tokens, and the 12 words.
public struct CashuWalletRecoverySnapshot: Sendable {
    public struct MintNotes: Identifiable, Sendable {
        public var id: String { mintURL }
        public let mintURL: String
        public let amount: UInt64
        /// The mint's unspent and in-flight notes as one Cashu token (V3).
        public let token: String
    }

    public struct Token: Identifiable, Sendable {
        public let id: String
        public let amount: UInt64?
        public let mintURL: String?
        public let token: String
    }

    public let mints: [MintNotes]
    public let savedTokens: [Token]
    public let unclaimedSentTokens: [Token]

    public init(mints: [MintNotes], savedTokens: [Token], unclaimedSentTokens: [Token]) {
        self.mints = mints
        self.savedTokens = savedTokens
        self.unclaimedSentTokens = unclaimedSentTokens
    }

    public static let empty = CashuWalletRecoverySnapshot(mints: [], savedTokens: [], unclaimedSentTokens: [])

    public var isEmpty: Bool { mints.isEmpty && savedTokens.isEmpty && unclaimedSentTokens.isEmpty }
}

public enum CashuWalletRecovery {
    /// Encodes proofs from one mint as a V3 (`cashuA`) token, which every Cashu wallet reads.
    public static func encodeV3Token(mintURL: String, proofs: [Proof], unit: String = "sat") throws -> String {
        let entries: [[String: Any]] = proofs.map { proof in
            ["amount": proof.amount.value, "id": proof.keysetId, "secret": proof.secret, "C": proof.c]
        }
        let object: [String: Any] = ["token": [["mint": mintURL, "proofs": entries]], "unit": unit]
        let json = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        return "cashuA" + json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Reads the wallet's files. `databaseURL` is the CDK SQLite store; the JSON files are the
    /// ones `CashuWalletService` keeps beside it.
    public static func load(
        databaseURL: URL,
        outgoingTokensURL: URL,
        pendingReceivesURL: URL
    ) async -> CashuWalletRecoverySnapshot {
        var mints: [CashuWalletRecoverySnapshot.MintNotes] = []
        if FileManager.default.fileExists(atPath: databaseURL.path),
           let database = try? WalletSqliteDatabase(filePath: databaseURL.path),
           let infos = try? await database.getProofs(
               mintUrl: nil,
               unit: .sat,
               state: [.unspent, .pending, .reserved, .pendingSpent],
               spendingConditions: nil
           ) {
            let byMint = Dictionary(grouping: infos, by: { $0.mintUrl.url })
            for (mintURL, entries) in byMint.sorted(by: { $0.key < $1.key }) {
                let proofs = entries.map(\.proof)
                let amount = proofs.reduce(UInt64(0)) { $0 &+ $1.amount.value }
                guard amount > 0, let token = try? encodeV3Token(mintURL: mintURL, proofs: proofs) else { continue }
                mints.append(.init(mintURL: mintURL, amount: amount, token: token))
            }
        }

        let saved = ((try? JSONDecoder().decode([CashuPendingReceive].self, from: Data(contentsOf: pendingReceivesURL))) ?? [])
            .map { CashuWalletRecoverySnapshot.Token(id: $0.id, amount: $0.amount, mintURL: $0.mintURL, token: $0.token) }
        let unclaimed = ((try? JSONDecoder().decode([CashuOutgoingToken].self, from: Data(contentsOf: outgoingTokensURL))) ?? [])
            .filter { $0.status == .ready || $0.status == .partiallyRedeemed }
            .map { CashuWalletRecoverySnapshot.Token(id: $0.id, amount: $0.amount, mintURL: $0.mintURL, token: $0.token) }
        return CashuWalletRecoverySnapshot(mints: mints, savedTokens: saved, unclaimedSentTokens: unclaimed)
    }

    /// The JSON file `CashuWalletService` keeps saved receives in, beside its outgoing tokens.
    public static func pendingReceivesURL(forOutgoingTokensURL url: URL) -> URL {
        url.deletingPathExtension().appendingPathExtension("pending-receives.json")
    }
}

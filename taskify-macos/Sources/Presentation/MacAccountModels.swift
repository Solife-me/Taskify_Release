import Foundation
import TaskifyCore

public struct MacSavedAccount: Codable, Equatable, Identifiable, Sendable {
    public var publicKeyHex: String
    public var npub: String
    public var privateKeyHex: String
    public var label: String?

    public var id: String { publicKeyHex }

    public init(
        publicKeyHex: String,
        npub: String,
        privateKeyHex: String,
        label: String? = nil
    ) {
        self.publicKeyHex = publicKeyHex
        self.npub = npub
        self.privateKeyHex = privateKeyHex
        self.label = label
    }

    public init(identity: NostrIdentity, label: String? = nil) {
        self.init(
            publicKeyHex: identity.publicKeyHex,
            npub: identity.npub,
            privateKeyHex: identity.privateKeyHex,
            label: label
        )
    }

    public var identity: NostrIdentity? {
        guard let data = try? Data(hex: privateKeyHex) else { return nil }
        return try? NostrIdentity(privateKey: data)
    }
}

public struct MacAccountSummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let npub: String
    public let label: String
    public let isCurrent: Bool
    public let isPrimary: Bool

    public init(
        id: String,
        npub: String,
        label: String,
        isCurrent: Bool,
        isPrimary: Bool
    ) {
        self.id = id
        self.npub = npub
        self.label = label
        self.isCurrent = isCurrent
        self.isPrimary = isPrimary
    }
}

public enum MacAccountCollection {
    public static func upsert(_ account: MacSavedAccount, into accounts: [MacSavedAccount]) -> [MacSavedAccount] {
        var result = accounts
        if let index = result.firstIndex(where: { $0.publicKeyHex == account.publicKeyHex }) {
            result[index] = account
        } else {
            result.append(account)
        }
        return result
    }

    public static func remove(_ accountID: String, from accounts: [MacSavedAccount]) -> [MacSavedAccount] {
        accounts.filter { $0.publicKeyHex != accountID }
    }

    public static func summaries(
        accounts: [MacSavedAccount],
        currentAccountID: String?,
        primaryAccountID: String?
    ) -> [MacAccountSummary] {
        accounts.map { account in
            let trimmedLabel = account.label?.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayLabel = trimmedLabel.flatMap { $0.isEmpty ? nil : $0 }
                ?? String(account.npub.prefix(16))
            return MacAccountSummary(
                id: account.publicKeyHex,
                npub: account.npub,
                label: displayLabel,
                isCurrent: account.publicKeyHex == currentAccountID,
                isPrimary: account.publicKeyHex == primaryAccountID
            )
        }
    }
}

public enum MacAccountStoragePaths {
    public static func storeURL(primaryURL: URL, accountID: String, usesPrimaryStore: Bool) -> URL {
        guard !usesPrimaryStore else { return primaryURL }
        return accountDirectory(primaryURL: primaryURL, accountID: accountID)
            .appendingPathComponent("taskify-store.json", isDirectory: false)
    }

    public static func outboxURL(primaryURL: URL, accountID: String, usesPrimaryStore: Bool) -> URL {
        guard !usesPrimaryStore else { return primaryURL }
        return accountDirectory(primaryURL: primaryURL, accountID: accountID)
            .appendingPathComponent("nostr-outbox.json", isDirectory: false)
    }

    private static func accountDirectory(primaryURL: URL, accountID: String) -> URL {
        primaryURL.deletingLastPathComponent()
            .appendingPathComponent("taskify-accounts", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
    }
}

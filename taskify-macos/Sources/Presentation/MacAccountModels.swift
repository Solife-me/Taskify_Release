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

    /// A saved vault row is trusted only when all public metadata is derived from its private
    /// key. This prevents a damaged or edited vault from pointing one account id at another
    /// account's key or scoped storage directory.
    public var normalizedVaultEntry: MacSavedAccount? {
        guard let identity,
              identity.publicKeyHex == publicKeyHex.lowercased(),
              identity.npub.lowercased() == npub.lowercased() else { return nil }
        return MacSavedAccount(identity: identity, label: label)
    }

    public var isValidVaultEntry: Bool { normalizedVaultEntry != nil }
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

public struct MacAccountRemovalPlan: Equatable, Sendable {
    public let removedAccountID: String
    public let activeAccountID: String
    public let promotedPrimaryAccountID: String?
    public let remainingAccountIDs: [String]

    public init(
        removedAccountID: String,
        activeAccountID: String,
        promotedPrimaryAccountID: String?,
        remainingAccountIDs: [String]
    ) {
        self.removedAccountID = removedAccountID
        self.activeAccountID = activeAccountID
        self.promotedPrimaryAccountID = promotedPrimaryAccountID
        self.remainingAccountIDs = remainingAccountIDs
    }
}

public enum MacAccountCollection {
    public static func upsert(_ account: MacSavedAccount, into accounts: [MacSavedAccount]) -> [MacSavedAccount] {
        let account = account.normalizedVaultEntry ?? account
        var result = accounts
        if let index = result.firstIndex(where: {
            $0.publicKeyHex.caseInsensitiveCompare(account.publicKeyHex) == .orderedSame
        }) {
            result[index] = account
        } else {
            result.append(account)
        }
        return result
    }

    public static func remove(_ accountID: String, from accounts: [MacSavedAccount]) -> [MacSavedAccount] {
        accounts.filter { $0.publicKeyHex.caseInsensitiveCompare(accountID) != .orderedSame }
    }

    /// Computes the account and primary-account transition before any Keychain or store changes.
    /// A removed current account falls back to the primary; a removed primary promotes the first
    /// remaining account and keeps the current account selected when it is a different account.
    public static func removalPlan(
        accountID: String,
        currentAccountID: String,
        primaryAccountID: String?,
        accounts: [MacSavedAccount]
    ) -> MacAccountRemovalPlan? {
        let accounts = validAccounts(accounts)
        guard accounts.count > 1,
              accounts.contains(where: {
                  $0.publicKeyHex.caseInsensitiveCompare(accountID) == .orderedSame
              }) else { return nil }
        let remaining = remove(accountID, from: accounts)
        guard let fallbackAccountID = remaining.first?.publicKeyHex else { return nil }
        let removesPrimary = primaryAccountID?.caseInsensitiveCompare(accountID) == .orderedSame
        let promotesPrimary = removesPrimary ? fallbackAccountID : nil
        let activeAccountID: String
        if currentAccountID.caseInsensitiveCompare(accountID) != .orderedSame {
            activeAccountID = currentAccountID
        } else if !removesPrimary,
                  let primaryAccountID,
                  remaining.contains(where: {
                      $0.publicKeyHex.caseInsensitiveCompare(primaryAccountID) == .orderedSame
                  }) {
            activeAccountID = primaryAccountID
        } else {
            activeAccountID = fallbackAccountID
        }
        return MacAccountRemovalPlan(
            removedAccountID: accountID,
            activeAccountID: activeAccountID,
            promotedPrimaryAccountID: promotesPrimary,
            remainingAccountIDs: remaining.map(\.publicKeyHex)
        )
    }

    /// Drop malformed and duplicate vault rows, canonicalizing accepted ids to lowercase.
    public static func validAccounts(_ accounts: [MacSavedAccount]) -> [MacSavedAccount] {
        var seen = Set<String>()
        return accounts.compactMap(\.normalizedVaultEntry).filter {
            seen.insert($0.publicKeyHex.lowercased()).inserted
        }
    }

    /// Chooses the account represented by the current Keychain item only when that id is already
    /// present in the vault. An unknown global id falls back to the saved primary instead of
    /// allowing the generic primary store to be opened for an unrelated account.
    public static func startupAccount(
        storedIdentityID: String?,
        accounts: [MacSavedAccount],
        primaryAccountID: String?
    ) -> MacSavedAccount? {
        let accounts = validAccounts(accounts)
        if let storedIdentityID,
           let stored = accounts.first(where: {
               $0.publicKeyHex.caseInsensitiveCompare(storedIdentityID) == .orderedSame
           }) {
            return stored
        }
        if let primaryAccountID,
           let primary = accounts.first(where: {
               $0.publicKeyHex.caseInsensitiveCompare(primaryAccountID) == .orderedSame
           }) {
            return primary
        }
        return accounts.first
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

    public static func accountDirectory(primaryURL: URL, accountID: String) -> URL {
        primaryURL.deletingLastPathComponent()
            .appendingPathComponent("taskify-accounts", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
    }
}

/// Moves the generic primary store into an account-keyed folder before another account becomes
/// primary. Keeping this as data rather than ad-hoc file code lets the runtime roll the move back
/// if either Keychain write fails.
public struct MacPrimaryStorageRelocation {
    public struct Move: Equatable, Sendable {
        public let source: URL
        public let destination: URL
    }

    public let moves: [Move]
    private var appliedMoves: [Move] = []

    public init(
        primaryStoreURL: URL,
        primaryOutboxURL: URL,
        accountID: String,
        fileManager: FileManager = .default
    ) {
        let destinationDirectory = MacAccountStoragePaths.accountDirectory(
            primaryURL: primaryStoreURL,
            accountID: accountID
        )
        let splitSource = primaryStoreURL.deletingLastPathComponent()
            .appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true)
        let splitDestination = destinationDirectory
            .appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true)
        let legacyDestination = destinationDirectory
            .appendingPathComponent("taskify-store.json", isDirectory: false)
        let outboxDestination = destinationDirectory
            .appendingPathComponent("nostr-outbox.json", isDirectory: false)

        var moves: [Move] = []
        if fileManager.fileExists(atPath: splitSource.path) {
            moves.append(Move(source: splitSource, destination: splitDestination))
        } else if fileManager.fileExists(atPath: primaryStoreURL.path) {
            moves.append(Move(source: primaryStoreURL, destination: legacyDestination))
        }
        if fileManager.fileExists(atPath: primaryOutboxURL.path) {
            moves.append(Move(source: primaryOutboxURL, destination: outboxDestination))
        }
        self.moves = moves
    }

    /// Builds the inverse move used when a secondary account becomes primary after the previous
    /// primary account is removed.
    public init(
        promotingAccountID: String,
        primaryStoreURL: URL,
        primaryOutboxURL: URL,
        fileManager: FileManager = .default
    ) {
        let sourceDirectory = MacAccountStoragePaths.accountDirectory(
            primaryURL: primaryStoreURL,
            accountID: promotingAccountID
        )
        let splitSource = sourceDirectory
            .appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true)
        let splitDestination = primaryStoreURL.deletingLastPathComponent()
            .appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true)
        let legacySource = sourceDirectory
            .appendingPathComponent("taskify-store.json", isDirectory: false)
        let outboxSource = sourceDirectory
            .appendingPathComponent("nostr-outbox.json", isDirectory: false)

        var moves: [Move] = []
        if fileManager.fileExists(atPath: splitSource.path) {
            moves.append(Move(source: splitSource, destination: splitDestination))
        } else if fileManager.fileExists(atPath: legacySource.path) {
            moves.append(Move(source: legacySource, destination: primaryStoreURL))
        }
        if fileManager.fileExists(atPath: outboxSource.path) {
            moves.append(Move(source: outboxSource, destination: primaryOutboxURL))
        }
        self.moves = moves
    }

    public mutating func apply(fileManager: FileManager = .default) throws {
        guard !moves.isEmpty else { return }
        guard appliedMoves.isEmpty else { return }
        for move in moves where fileManager.fileExists(atPath: move.destination.path) {
            throw CocoaError(.fileWriteFileExists, userInfo: [NSFilePathErrorKey: move.destination.path])
        }
        try fileManager.createDirectory(
            at: moves[0].destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        do {
            for move in moves {
                try fileManager.moveItem(at: move.source, to: move.destination)
                appliedMoves.append(move)
            }
        } catch {
            try? rollback(fileManager: fileManager)
            throw error
        }
    }

    public mutating func rollback(fileManager: FileManager = .default) throws {
        var rollbackError: Error?
        for move in appliedMoves.reversed() {
            do {
                if fileManager.fileExists(atPath: move.source.path) {
                    throw CocoaError(.fileWriteFileExists, userInfo: [NSFilePathErrorKey: move.source.path])
                }
                try fileManager.createDirectory(
                    at: move.source.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try fileManager.moveItem(at: move.destination, to: move.source)
            } catch {
                rollbackError = rollbackError ?? error
            }
        }
        appliedMoves.removeAll()
        if let rollbackError { throw rollbackError }
    }
}

/// Per-account preferences live in a dedicated UserDefaults suite. The task store and outbox are
/// already account-scoped; using the same boundary for Bible/Scripture state, relays and synced
/// settings prevents one account's local state from being observed or republished by another.
public enum MacAccountPreferences {
    private static let migrationMarkerKey = "taskify.accountPreferences.legacyImported.v1"
    private static let deviceMigrationMarkerKey = "taskify.accountPreferences.legacyMigrationCompleted.v1"

    public static func suiteName(bundleIdentifier: String, accountID: String) -> String {
        "\(bundleIdentifier).account.\(accountID.lowercased()).preferences"
    }

    public static func makeDefaults(
        bundleIdentifier: String,
        accountID: String,
        migratingFrom legacyDefaults: UserDefaults? = nil
    ) -> UserDefaults {
        let suite = suiteName(bundleIdentifier: bundleIdentifier, accountID: accountID)
        guard let defaults = UserDefaults(suiteName: suite) else {
            preconditionFailure("Could not open account-scoped preferences for \(accountID).")
        }
        if let legacyDefaults {
            migrateLegacyTaskifyValues(from: legacyDefaults, to: defaults)
        }
        return defaults
    }

    /// Existing single-account installs kept these values in `.standard`. Copy every Taskify key
    /// once when the primary account first receives its dedicated suite; device-level wallet and
    /// appearance settings may also be copied, but account code only reads the account-scoped keys.
    public static func migrateLegacyTaskifyValues(
        from legacyDefaults: UserDefaults,
        to accountDefaults: UserDefaults
    ) {
        guard !legacyDefaults.bool(forKey: deviceMigrationMarkerKey),
              !accountDefaults.bool(forKey: migrationMarkerKey) else { return }
        for (key, value) in legacyDefaults.dictionaryRepresentation()
        where key.hasPrefix("taskify.")
            && key != migrationMarkerKey
            && key != deviceMigrationMarkerKey {
            if accountDefaults.object(forKey: key) == nil {
                accountDefaults.set(value, forKey: key)
            }
        }
        legacyDefaults.set(true, forKey: deviceMigrationMarkerKey)
        accountDefaults.set(true, forKey: migrationMarkerKey)
    }
}

/// Mac-only presentation choices that still belong to the account whose tasks they describe.
/// Keys intentionally match the native presentation settings so the primary account's one-time
/// legacy migration carries existing choices forward.
public struct MacAccountViewPreferences: Equatable, Sendable {
    public static let completedTabKey = "taskify.view.completedTab"
    public static let hideCompletedSubtasksKey = "taskify.view.hideCompletedSubtasks"

    public let completedTabEnabled: Bool
    public let hideCompletedSubtasks: Bool

    public init(defaults: UserDefaults) {
        completedTabEnabled = (defaults.object(forKey: Self.completedTabKey) as? Bool) ?? true
        hideCompletedSubtasks = (defaults.object(forKey: Self.hideCompletedSubtasksKey) as? Bool) ?? false
    }
}

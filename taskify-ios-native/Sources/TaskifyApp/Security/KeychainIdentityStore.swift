import Foundation
import Security
import TaskifyCore

enum KeychainIdentityError: LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status): "The native identity could not be stored securely (\(status))."
        }
    }
}

struct KeychainIdentityStore {
    #if os(macOS)
    private let service = Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac"
#else
    private let service = "solife.me.Taskify.Native"
#endif
    private let account = "nostr-identity-private-key"
    private var sharedAccessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "TaskifyKeychainAccessGroup") as? String
    }

    func loadOrCreate() throws -> NostrIdentity {
        if let storedKey = try loadPrivateKey() {
            return try NostrIdentity(privateKey: storedKey)
        }
        let identity = try NostrIdentity.generate()
        try save(identity)
        return identity
    }

    func load() throws -> NostrIdentity? {
        guard let storedKey = try loadPrivateKey() else { return nil }
        return try NostrIdentity(privateKey: storedKey)
    }

    func save(_ identity: NostrIdentity) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let sharedAccessGroup { query[kSecAttrAccessGroup as String] = sharedAccessGroup }
        do {
            try TaskifyKeychainItem.save(query, value: identity.privateKey)
        } catch let failure as TaskifyKeychainItem.Failure {
            throw KeychainIdentityError.keychain(failure.status)
        }
    }

    private func loadPrivateKey() throws -> Data? {
        if let sharedAccessGroup,
           let shared = try loadPrivateKey(accessGroup: sharedAccessGroup) {
            return shared
        }
        guard let legacy = try loadPrivateKey(accessGroup: nil) else { return nil }
        if sharedAccessGroup != nil {
            let identity = try NostrIdentity(privateKey: legacy)
            try save(identity)
        }
        return legacy
    }

    private func loadPrivateKey(accessGroup: String?) throws -> Data? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        do {
            return try TaskifyKeychainItem.load(query)
        } catch let failure as TaskifyKeychainItem.Failure {
            throw KeychainIdentityError.keychain(failure.status)
        }
    }
}

struct KeychainWalletSeedStore {
    #if os(macOS)
    private let service = Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac"
#else
    private let service = "solife.me.Taskify.Native"
#endif
    private let account = "cashu-wallet-mnemonic-v1"

    func loadOrCreate() throws -> String {
        if let stored = try load() { return stored }
        let mnemonic = try CashuWalletService.generateMnemonic()
        try save(mnemonic)
        return mnemonic
    }

    func save(_ mnemonic: String) throws {
        let normalized = CashuWalletService.normalizedMnemonic(mnemonic)
        guard CashuWalletService.validateMnemonic(normalized) else {
            throw CashuWalletError.invalidRecoveryPhrase
        }
        do {
            try TaskifyKeychainItem.save(itemQuery, value: Data(normalized.utf8))
        } catch let failure as TaskifyKeychainItem.Failure {
            throw KeychainIdentityError.keychain(failure.status)
        }
    }

    func load() throws -> String? {
        let data: Data?
        do {
            data = try TaskifyKeychainItem.load(itemQuery)
        } catch let failure as TaskifyKeychainItem.Failure {
            throw KeychainIdentityError.keychain(failure.status)
        }
        guard let data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private var itemQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

struct KeychainP2PKKeyStore {
    #if os(macOS)
    private let service = Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac"
#else
    private let service = "solife.me.Taskify.Native"
#endif
    private let account = "cashu-p2pk-recipient-keys-v1"

    func load() throws -> CashuP2PKKeyRing {
        let data: Data?
        do {
            data = try TaskifyKeychainItem.load(itemQuery)
        } catch let failure as TaskifyKeychainItem.Failure {
            throw KeychainIdentityError.keychain(failure.status)
        }
        guard let data else { return CashuP2PKKeyRing() }
        return try JSONDecoder().decode(CashuP2PKKeyRing.self, from: data)
    }

    private var itemQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func save(_ keyRing: CashuP2PKKeyRing) throws {
        let data = try JSONEncoder().encode(keyRing)
        // Background payment-request redemption runs after the first unlock, so these keys use
        // the same device-only accessibility class as the wallet seed (the helper's default).
        do {
            try TaskifyKeychainItem.save(itemQuery, value: data)
        } catch let failure as TaskifyKeychainItem.Failure {
            throw KeychainIdentityError.keychain(failure.status)
        }
    }
}

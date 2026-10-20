import Foundation
import Security
import TaskifyCore
import TaskifyWallet

// The wallet's keychain items, kept apart from the identity store so the extensions that share
// that file don't link the wallet (C10-5).

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

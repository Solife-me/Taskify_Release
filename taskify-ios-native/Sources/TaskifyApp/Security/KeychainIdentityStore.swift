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
    private let service = "solife.me.Taskify.Native"
    private let account = "nostr-identity-private-key"

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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: identity.privateKey,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw KeychainIdentityError.keychain(updateStatus) }

        var item = query
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainIdentityError.keychain(addStatus) }
    }

    private func loadPrivateKey() throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainIdentityError.keychain(status) }
        return result as? Data
    }
}

struct KeychainWalletSeedStore {
    private let service = "solife.me.Taskify.Native"
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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(normalized.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw KeychainIdentityError.keychain(updateStatus) }

        var item = query
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainIdentityError.keychain(addStatus) }
    }

    func load() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainIdentityError.keychain(status) }
        guard let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

import Foundation
import Security
import TaskifyCore

enum KeychainIdentityError: LocalizedError {
    case keychain(OSStatus)
    case verificationFailed

    var errorDescription: String? {
        switch self {
        case .keychain(let status): "The native identity could not be stored securely (\(status))."
        case .verificationFailed: "The active account identity could not be verified after saving."
        }
    }
}

struct KeychainIdentityStore {
    private let service: String
    private let account = "nostr-identity-private-key"
    private let usesSharedAccessGroup: Bool

    init(service: String? = nil, usesSharedAccessGroup: Bool = true) {
        self.usesSharedAccessGroup = usesSharedAccessGroup
        if let service {
            self.service = service
        } else {
#if os(macOS)
            self.service = Bundle.main.bundleIdentifier ?? "solife.me.Taskify.Mac"
#else
            self.service = "solife.me.Taskify.Native"
#endif
        }
    }

    private var sharedAccessGroup: String? {
        guard usesSharedAccessGroup else { return nil }
        return Bundle.main.object(forInfoDictionaryKey: "TaskifyKeychainAccessGroup") as? String
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
        try savePrivateKey(identity)
        guard try load()?.publicKeyHex == identity.publicKeyHex else {
            throw KeychainIdentityError.verificationFailed
        }
    }

#if os(macOS)
    func clearForLocalReset() throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        TaskifyKeychainItem.delete(query)
        if let sharedAccessGroup {
            query[kSecAttrAccessGroup as String] = sharedAccessGroup
            TaskifyKeychainItem.delete(query)
        }
        guard try loadPrivateKey() == nil else { throw KeychainIdentityError.verificationFailed }
    }
#endif

    private func savePrivateKey(_ identity: NostrIdentity) throws {
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
            try savePrivateKey(identity)
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

#if os(iOS)
enum ICloudKeyRecoveryError: LocalizedError {
    case unavailable
    case keychain(OSStatus)
    case missingBackup
    case invalidBackup

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Taskify couldn’t access its iCloud Keychain recovery storage."
        case .keychain(let status):
            "Taskify couldn’t access iCloud Keychain recovery (\(status)). Try again while this device is unlocked."
        case .missingBackup:
            "This backup is no longer available on this device. Check iCloud Keychain and try again."
        case .invalidBackup:
            "The recovery key doesn’t match this Taskify account."
        }
    }
}

extension KeychainIdentityStore {
    // A separate service keeps local reset, signing, and shared extensions independent of recovery.
    // One item per npub lets multiple Taskify accounts coexist without replacing another key.
    private func recoveryQuery(npub: String? = nil) throws -> [String: Any] {
        guard let accessGroup = Bundle.main.object(forInfoDictionaryKey: "TaskifyRecoveryKeychainAccessGroup") as? String,
              !accessGroup.isEmpty else { throw ICloudKeyRecoveryError.unavailable }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "\(service).identity-recovery",
            kSecAttrAccessGroup as String: accessGroup,
            kSecAttrSynchronizable as String: true,
        ]
        query[kSecAttrAccount as String] = npub
        return query
    }

    func iCloudRecoveryAccounts() throws -> [String] {
        var query = try recoveryQuery()
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        query[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw ICloudKeyRecoveryError.keychain(status) }
        guard let items = result as? [[String: Any]] else { throw ICloudKeyRecoveryError.invalidBackup }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }

    func iCloudRecoveryIdentity(npub: String) throws -> NostrIdentity? {
        let query = try recoveryQuery(npub: npub)
        let key: Data?
        do {
            key = try TaskifyKeychainItem.load(query)
        } catch let failure as TaskifyKeychainItem.Failure {
            throw ICloudKeyRecoveryError.keychain(failure.status)
        }
        guard let key else { return nil }
        guard let identity = try? NostrIdentity(privateKey: key), identity.npub == npub else {
            throw ICloudKeyRecoveryError.invalidBackup
        }
        return identity
    }

    func saveICloudRecoveryIdentity(_ identity: NostrIdentity) throws {
        var item = try recoveryQuery(npub: identity.npub)
        item[kSecValueData as String] = identity.privateKey
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw ICloudKeyRecoveryError.keychain(status)
        }
        // An existing valid copy is sufficient. The read verifies local storage only.
        guard try iCloudRecoveryIdentity(npub: identity.npub) != nil else {
            throw ICloudKeyRecoveryError.missingBackup
        }
    }

    func removeICloudRecoveryIdentity(npub: String) throws {
        let query = try recoveryQuery(npub: npub)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ICloudKeyRecoveryError.keychain(status)
        }
    }
}
#endif

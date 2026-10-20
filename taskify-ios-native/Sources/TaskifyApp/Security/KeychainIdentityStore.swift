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

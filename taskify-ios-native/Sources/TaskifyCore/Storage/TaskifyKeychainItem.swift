import Foundation
import Security

/// One generic-password Keychain item, identified by `query` (class, service, account, and an
/// optional access group).
///
/// On macOS, items go to the data protection keychain, which honours the accessibility class as
/// iOS does; the legacy file-based keychain ignores it (audit F3D-3). A build without a signed
/// application identifier cannot use the data protection keychain (`errSecMissingEntitlement`), so
/// it keeps using the legacy item. An existing legacy item moves across the first time the data
/// protection keychain accepts it.
public enum TaskifyKeychainItem {
    public struct Failure: Error, Equatable {
        public let status: OSStatus
    }

    public static func load(_ query: [String: Any]) throws -> Data? {
#if os(macOS)
        if let data = try? read(dataProtection(query)) { return data }
        guard let legacy = try read(query) else { return nil }
        if (try? write(dataProtection(query), value: legacy, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)) != nil {
            SecItemDelete(query as CFDictionary)
        }
        return legacy
#else
        return try read(query)
#endif
    }

    public static func save(
        _ query: [String: Any],
        value: Data,
        accessible: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ) throws {
#if os(macOS)
        if (try? write(dataProtection(query), value: value, accessible: accessible)) != nil {
            // Without the data protection flag this addresses only the legacy keychain.
            SecItemDelete(query as CFDictionary)
            return
        }
#endif
        try write(query, value: value, accessible: accessible)
    }

    public static func delete(_ query: [String: Any]) {
#if os(macOS)
        SecItemDelete(dataProtection(query) as CFDictionary)
#endif
        SecItemDelete(query as CFDictionary)
    }

#if os(macOS)
    private static func dataProtection(_ query: [String: Any]) -> [String: Any] {
        var query = query
        query[kSecUseDataProtectionKeychain as String] = true
        return query
    }
#endif

    private static func read(_ query: [String: Any]) throws -> Data? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status) }
        return result as? Data
    }

    private static func write(_ query: [String: Any], value: Data, accessible: CFString) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: accessible,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw Failure(status: updateStatus) }
        var item = query
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw Failure(status: addStatus) }
    }
}

/// KeychainStore.swift
/// Secure storage for Taskify profile credentials (nsec, profiles list).
/// Uses iOS Keychain Services via Security framework.

import Foundation
import Security

public enum KeychainStore {

    private static let service = "ai.taskify.ios"
    private static let profileStore = ProfileIdentityStore(secureStore: Adapter())

    // MARK: - Profile storage

    /// Saves the active profile to the Keychain.
    public static func saveProfile(_ profile: TaskifyProfile) throws {
        try profileStore.saveProfile(profile)
    }

    /// Loads the active profile from the Keychain.
    public static func loadActiveProfile() throws -> TaskifyProfile? {
        try profileStore.loadActiveProfile()
    }

    /// Returns all saved profile names.
    public static func allProfileNames() throws -> [String] {
        try profileStore.allProfileNames()
    }

    public static func saveProfileNames(_ names: [String]) throws {
        try profileStore.saveProfileNames(names)
    }

    /// Deletes a profile from the Keychain.
    public static func deleteProfile(name: String) throws {
        try profileStore.deleteProfile(name: name)
    }

    public static func clearActiveProfile() throws {
        try profileStore.clearActiveProfile()
    }

    // MARK: - Low-level Keychain operations

    public static func set(_ data: Data, key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.writeFailed(addStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainError.writeFailed(status)
        }
    }

    public static func get(key: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.readFailed(status) }
        return result as? Data
    }

    public static func delete(key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.deleteFailed(status)
        }
    }

    private struct Adapter: SecureStore {
        func set(_ data: Data, key: String) throws { try KeychainStore.set(data, key: key) }
        func get(key: String) throws -> Data? { try KeychainStore.get(key: key) }
        func delete(key: String) throws { try KeychainStore.delete(key: key) }
    }
}

// MARK: - Errors

public enum KeychainError: Error, LocalizedError {
    case writeFailed(OSStatus)
    case readFailed(OSStatus)
    case deleteFailed(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .writeFailed(let s): return "Keychain write failed: \(s)"
        case .readFailed(let s): return "Keychain read failed: \(s)"
        case .deleteFailed(let s): return "Keychain delete failed: \(s)"
        }
    }
}

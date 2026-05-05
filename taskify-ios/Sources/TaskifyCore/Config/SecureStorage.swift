/// SecureStorage — thin wrapper around KeychainStore for simple key/value operations.
/// Used by the PWA bridging layer for device key retrieval.

import Foundation

public enum SecureStorageKey {
    case device
    case profile(String)
    case custom(String)
}

public final class SecureStorage {
    
    /// Singleton default instance.
    public static let `default` = SecureStorage()
    
    public init() {}
    
    /// Retrieve a key from the keychain, returning its hex representation.
    public func retrieveKey(_ key: SecureStorageKey) throws -> String {
        let keyString: String
        switch key {
        case .device:
            keyString = "device_key"
        case .profile(let name):
            keyString = "profile:\(name)"
        case .custom(let name):
            keyString = name
        }
        
        guard let data = try KeychainStore.get(key: keyString) else {
            throw SecureStorageError.notFound
        }
        return data.map { String(format: "%02x", $0) }.joined()
    }
    
    /// Store a key in the keychain.
    public func storeKey(_ key: SecureStorageKey, value: String) throws {
        let keyString: String
        switch key {
        case .device:
            keyString = "device_key"
        case .profile(let name):
            keyString = "profile:\(name)"
        case .custom(let name):
            keyString = name
        }
        
        let data = Data(hex: value)
        guard data != nil else {
            throw SecureStorageError.invalidHex
        }
        try KeychainStore.set(data!, key: keyString)
    }
    
    /// Delete a key from the keychain.
    public func deleteKey(_ key: SecureStorageKey) throws {
        let keyString: String
        switch key {
        case .device:
            keyString = "device_key"
        case .profile(let name):
            keyString = "profile:\(name)"
        case .custom(let name):
            keyString = name
        }
        try KeychainStore.delete(key: keyString)
    }
}

// MARK: - Errors

public enum SecureStorageError: Error, LocalizedError {
    case notFound
    case invalidHex
    
    public var errorDescription: String? {
        switch self {
        case .notFound: return "Key not found in secure storage"
        case .invalidHex: return "Invalid hex string"
        }
    }
}

// MARK: - Helper

private extension Data {
    init?(hex: String) {
        let cleaned = hex.replacingOccurrences(of: "0x", with: "")
        guard cleaned.count % 2 == 0, cleaned.count > 0 else { return nil }
        var bytes = [UInt8]()
        var i = cleaned.startIndex
        while i < cleaned.endIndex {
            let j = cleaned.index(i, offsetBy: 2)
            guard let byte = UInt8(cleaned[i..<j], radix: 16) else { return nil }
            bytes.append(byte)
            i = j
        }
        self.init(bytes)
    }
}

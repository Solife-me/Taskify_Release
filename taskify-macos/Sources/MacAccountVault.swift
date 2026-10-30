import Foundation
import Security
import TaskifyCore

enum MacAccountVaultError: LocalizedError {
    case verificationFailed

    var errorDescription: String? {
        "The saved-account list could not be verified after writing it."
    }
}

struct MacAccountVaultState: Codable, Equatable {
    var primaryAccountID: String?
    var accounts: [MacSavedAccount] = []
}

struct MacAccountVault {
    private let service: String
    private let usesSharedAccessGroup: Bool
    private let account = "saved-accounts"

    init(service: String, usesSharedAccessGroup: Bool) {
        self.service = service
        self.usesSharedAccessGroup = usesSharedAccessGroup
    }

    func load() throws -> MacAccountVaultState {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let sharedAccessGroup { query[kSecAttrAccessGroup as String] = sharedAccessGroup }
        guard let data = try TaskifyKeychainItem.load(query) else {
            return MacAccountVaultState()
        }
        return try JSONDecoder().decode(MacAccountVaultState.self, from: data)
    }

    func save(_ state: MacAccountVaultState) throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let sharedAccessGroup { query[kSecAttrAccessGroup as String] = sharedAccessGroup }
        try TaskifyKeychainItem.save(query, value: JSONEncoder().encode(state))
        guard try load() == state else { throw MacAccountVaultError.verificationFailed }
    }

    private var sharedAccessGroup: String? {
        guard usesSharedAccessGroup else { return nil }
        return Bundle.main.object(forInfoDictionaryKey: "TaskifyKeychainAccessGroup") as? String
    }
}

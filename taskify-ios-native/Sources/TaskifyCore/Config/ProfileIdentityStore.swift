import Foundation

public struct ProfileIdentityStore {
    private let secureStore: SecureStore

    private enum Keys {
        static let activeProfile = "active_profile"
        static let profileNames = "profile_names"
        static func profile(_ name: String) -> String { "profile:\(name)" }
    }

    public init(secureStore: SecureStore) {
        self.secureStore = secureStore
    }

    public func saveProfile(_ profile: TaskifyProfile) throws {
        var sanitized = profile
        sanitized.relays = normalizeRelayList(profile.relays)
        let data = try JSONEncoder().encode(sanitized)
        try secureStore.set(data, key: Keys.profile(sanitized.name))
        try secureStore.set(Data(sanitized.name.utf8), key: Keys.activeProfile)

        var names = try allProfileNames()
        if !names.contains(sanitized.name) {
            names.append(sanitized.name)
            try saveProfileNames(names)
        }
    }

    public func loadActiveProfile() throws -> TaskifyProfile? {
        guard let nameData = try secureStore.get(key: Keys.activeProfile),
              let name = String(data: nameData, encoding: .utf8),
              let data = try secureStore.get(key: Keys.profile(name))
        else {
            return nil
        }
        var profile = try JSONDecoder().decode(TaskifyProfile.self, from: data)
        let sanitizedRelays = normalizeRelayList(profile.relays)
        if sanitizedRelays != profile.relays {
            profile.relays = sanitizedRelays
            try saveProfile(profile)
        }
        return profile
    }

    public func allProfileNames() throws -> [String] {
        guard let data = try secureStore.get(key: Keys.profileNames) else { return [] }
        return (try? JSONDecoder().decode([String].self, from: data)) ?? []
    }

    public func saveProfileNames(_ names: [String]) throws {
        let data = try JSONEncoder().encode(names)
        try secureStore.set(data, key: Keys.profileNames)
    }

    public func deleteProfile(name: String) throws {
        try secureStore.delete(key: Keys.profile(name))
        var names = try allProfileNames()
        names.removeAll { $0 == name }
        try saveProfileNames(names)

        // If deleted profile was active, clear active profile pointer.
        if let activeData = try secureStore.get(key: Keys.activeProfile),
           let activeName = String(data: activeData, encoding: .utf8),
           activeName == name {
            try secureStore.delete(key: Keys.activeProfile)
        }
    }

    public func clearActiveProfile() throws {
        try secureStore.delete(key: Keys.activeProfile)
    }
}

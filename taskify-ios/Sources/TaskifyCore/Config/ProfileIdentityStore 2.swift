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
        let data = try JSONEncoder().encode(profile)
        try secureStore.set(data, key: Keys.profile(profile.name))
        try secureStore.set(Data(profile.name.utf8), key: Keys.activeProfile)

        var names = try allProfileNames()
        if !names.contains(profile.name) {
            names.append(profile.name)
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
        return try JSONDecoder().decode(TaskifyProfile.self, from: data)
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
}

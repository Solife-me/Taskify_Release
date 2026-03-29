import Foundation

public enum ContactPreferencesStore {
    private static let syncPrefix = "ai.taskify.contacts.sync."
    private static let profilePrefix = "ai.taskify.profile.metadata."
    private static let nip05Prefix = "ai.taskify.contacts.nip05."

    public static func loadSyncMetadata(npub: String) -> ContactSyncMetadata {
        guard let data = UserDefaults.standard.data(forKey: syncPrefix + npub),
              let decoded = try? JSONDecoder().decode(ContactSyncMetadata.self, from: data) else {
            return ContactSyncMetadata()
        }
        return decoded
    }

    public static func saveSyncMetadata(_ metadata: ContactSyncMetadata, npub: String) {
        guard let data = try? JSONEncoder().encode(metadata) else { return }
        UserDefaults.standard.set(data, forKey: syncPrefix + npub)
    }

    public static func loadProfileMetadata(npub: String) -> TaskifyProfileMetadata {
        guard let data = UserDefaults.standard.data(forKey: profilePrefix + npub),
              let decoded = try? JSONDecoder().decode(TaskifyProfileMetadata.self, from: data) else {
            return TaskifyProfileMetadata()
        }
        return decoded
    }

    public static func saveProfileMetadata(_ metadata: TaskifyProfileMetadata, npub: String) {
        guard let data = try? JSONEncoder().encode(metadata) else { return }
        UserDefaults.standard.set(data, forKey: profilePrefix + npub)
    }

    public static func loadNip05Checks(npub: String) -> [String: Nip05CheckState] {
        guard let data = UserDefaults.standard.data(forKey: nip05Prefix + npub),
              let decoded = try? JSONDecoder().decode([String: Nip05CheckState].self, from: data) else {
            return [:]
        }
        return decoded
    }

    public static func saveNip05Checks(_ checks: [String: Nip05CheckState], npub: String) {
        guard let data = try? JSONEncoder().encode(checks) else { return }
        UserDefaults.standard.set(data, forKey: nip05Prefix + npub)
    }
}

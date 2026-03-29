import Foundation

public enum RelayBlocklistStore {
    private static let key = "taskify.blocked-relays"
    // As of 2026-03-27, iOS ATS rejects this relay's system trust chain (-9802).
    private static let bundledBlockedHosts: Set<String> = ["relay.primal.net"]

    public static func normalize(_ relay: String) -> String? {
        let trimmed = relay.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard !contains(trimmed) else { return nil }
        return trimmed
    }

    public static func contains(_ relay: String, userDefaults: UserDefaults = .standard) -> Bool {
        let key = normalizedKey(relay)
        guard !key.isEmpty else { return false }
        if let host = relayHost(relay), bundledBlockedHosts.contains(host) {
            return true
        }
        return blockedRelays(userDefaults: userDefaults).contains(key)
    }

    public static func add(_ relay: String, userDefaults: UserDefaults = .standard) {
        let key = normalizedKey(relay)
        guard !key.isEmpty else { return }
        var blocked = blockedRelays(userDefaults: userDefaults)
        blocked.insert(key)
        save(blocked, userDefaults: userDefaults)
    }

    public static func blockedRelays(userDefaults: UserDefaults = .standard) -> Set<String> {
        guard let values = userDefaults.array(forKey: key) as? [String] else { return [] }
        return Set(values.map(normalizedKey).filter { !$0.isEmpty })
    }

    private static func save(_ blocked: Set<String>, userDefaults: UserDefaults) {
        userDefaults.set(Array(blocked).sorted(), forKey: key)
    }

    private static func normalizedKey(_ relay: String) -> String {
        let trimmed = relay.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        guard var components = URLComponents(string: trimmed) else {
            return trimmed.lowercased()
        }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        if components.path == "/" {
            components.path = ""
        }
        return components.string?.lowercased() ?? trimmed.lowercased()
    }

    private static func relayHost(_ relay: String) -> String? {
        URLComponents(string: relay)?.host?.lowercased()
    }
}

import Foundation

/// Account-scoped credentials for short-lived metadata connections. The sync engine
/// updates this on sign-in/sign-out; transport owners can supply a different identity.
public actor NostrRelayAuthentication {
    public static let shared = NostrRelayAuthentication()
    private var identity: NostrIdentity?

    public func setIdentity(_ identity: NostrIdentity?) { self.identity = identity }
    public func currentIdentity() -> NostrIdentity? { identity }
}

/// Tracks only blocked wire requests, and permits one replay per request per challenge.
struct NostrRelayAuthReplay {
    private(set) var challenge: String?
    private(set) var authEventID: String?
    private(set) var accepted = false
    private var frames: [String: String] = [:]
    private var blocked = Set<String>()
    private var replayed = Set<String>()

    mutating func record(key: String, frame: String) {
        guard frames[key] != nil || frames.count < 128 else { return }
        frames[key] = frame
    }

    mutating func remove(key: String) {
        frames.removeValue(forKey: key)
        blocked.remove(key)
        replayed.remove(key)
    }

    mutating func begin(challenge: String, authEventID: String) -> Bool {
        guard self.challenge != challenge else { return false }
        self.challenge = challenge
        self.authEventID = authEventID
        accepted = false
        replayed.removeAll()
        return true
    }

    mutating func block(key: String) -> Bool {
        guard frames[key] != nil, !replayed.contains(key) else { return false }
        blocked.insert(key)
        return true
    }

    mutating func acknowledge(eventID: String, accepted: Bool) -> [String]? {
        guard eventID == authEventID else { return nil }
        self.accepted = accepted
        return accepted ? takeReplays() : []
    }

    mutating func takeReplays() -> [String] {
        guard accepted else { return [] }
        let keys = blocked.subtracting(replayed)
        replayed.formUnion(keys)
        blocked.subtract(keys)
        return keys.sorted().compactMap { frames[$0] }
    }
}

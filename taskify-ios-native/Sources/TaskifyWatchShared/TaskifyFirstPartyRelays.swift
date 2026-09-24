import Foundation

/// Relays Taskify operates. Matches the runtime's `FIRST_PARTY_RELAYS` (taskify-runtime-nostr).
public enum TaskifyFirstPartyRelays {
    public static let relayURL = "wss://relay.solife.me"
    public static let pushRelayURL = "wss://push.solife.me"
    public static let urls: Set<String> = [relayURL, pushRelayURL]

    public static func isFirstParty(_ relayURL: String) -> Bool {
        urls.contains(normalized(relayURL))
    }

    /// Where the Watch publishes a board change. Watch traffic is proxied through Taskify's
    /// servers, and public relays rate-limit their shared IPs per IP, so the Watch sends only to
    /// Taskify's own relays; the phone fans the change out to the board's public relays from its
    /// own connection when it applies the queued Watch command. Public copies arrive once the
    /// phone next syncs.
    public static func watchPublishTargets(boardRelayURLs: [String]) -> [String] {
        var seen = Set<String>()
        let firstParty = boardRelayURLs
            .map(normalized)
            .filter { urls.contains($0) && seen.insert($0).inserted }
        return firstParty.isEmpty ? [relayURL] : firstParty
    }

    private static func normalized(_ relayURL: String) -> String {
        var value = relayURL.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
}

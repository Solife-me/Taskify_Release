import Foundation

public struct Nip05Resolution: Equatable, Sendable {
    public var nip05: String
    public var pubkey: String
    public var relays: [String]

    public init(nip05: String, pubkey: String, relays: [String] = []) {
        self.nip05 = nip05
        self.pubkey = pubkey
        self.relays = relays
    }
}

public enum Nip05Resolver {
    public static func resolve(_ value: String) async throws -> Nip05Resolution {
        guard let normalized = normalizeNip05(value) else {
            throw Nip05Error.invalidAddress
        }
        let parts = normalized.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2 else { throw Nip05Error.invalidAddress }

        let name = String(parts[0])
        let domain = String(parts[1])
        guard let url = URL(string: "https://\(domain)/.well-known/nostr.json?name=\(name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? name)") else {
            throw Nip05Error.invalidAddress
        }

        let (data, _) = try await URLSession.shared.data(from: url)
        guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Nip05Error.invalidResponse
        }
        let names = parsed["names"] as? [String: Any]
        let relays = parsed["relays"] as? [String: Any]
        guard let matched = names?[name] as? String else {
            throw Nip05Error.notFound
        }
        let pubkey = try NostrIdentityService.normalizePublicKeyInput(matched)
        let relayHints = normalizeRelayList((relays?[pubkey] as? [String]) ?? [])
        return Nip05Resolution(nip05: normalized, pubkey: pubkey, relays: relayHints)
    }
}

public enum Nip05Error: Error, LocalizedError {
    case invalidAddress
    case invalidResponse
    case notFound

    public var errorDescription: String? {
        switch self {
        case .invalidAddress:
            return "Enter a valid NIP-05 address."
        case .invalidResponse:
            return "The NIP-05 response was invalid."
        case .notFound:
            return "No pubkey found for that NIP-05 address."
        }
    }
}

import Foundation

public enum Nip05Error: LocalizedError, Equatable {
    case invalidIdentifier
    case invalidResponse
    case nameNotFound
    case publicKeyMismatch
    case requestFailed(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier:
            "Enter a NIP-05 address such as name@example.com."
        case .invalidResponse:
            "The NIP-05 server returned an invalid response."
        case .nameNotFound:
            "That NIP-05 address was not found."
        case .publicKeyMismatch:
            "The NIP-05 address does not verify this Nostr public key."
        case let .requestFailed(status):
            "The NIP-05 server returned HTTP \(status)."
        }
    }
}

public struct Nip05Request: Equatable, Sendable {
    public let identifier: String
    public let name: String
    public let domain: String
    public let url: URL
}

public struct Nip05Resolution: Equatable, Sendable {
    public let identifier: String
    public let publicKeyHex: String
    public let relayURLs: [String]

    public func matches(publicKeyHex: String) -> Bool {
        self.publicKeyHex.caseInsensitiveCompare(publicKeyHex) == .orderedSame
    }
}

public enum Nip05Client {
    public static func request(for rawIdentifier: String) throws -> Nip05Request {
        let trimmed = rawIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty,
              !trimmed.contains("://"),
              !trimmed.contains("/"),
              !trimmed.contains("?") else {
            throw Nip05Error.invalidIdentifier
        }

        let pieces = trimmed.split(separator: "@", omittingEmptySubsequences: false)
        let name: String
        let domain: String
        switch pieces.count {
        case 1:
            name = "_"
            domain = String(pieces[0])
        case 2:
            name = String(pieces[0])
            domain = String(pieces[1])
        default:
            throw Nip05Error.invalidIdentifier
        }
        guard !name.isEmpty,
              domain.contains("."),
              !domain.hasPrefix("."),
              !domain.hasSuffix("."),
              domain.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            throw Nip05Error.invalidIdentifier
        }
        var components = URLComponents()
        components.scheme = "https"
        components.host = domain
        components.path = "/.well-known/nostr.json"
        components.queryItems = [URLQueryItem(name: "name", value: name)]
        guard let url = components.url else { throw Nip05Error.invalidIdentifier }
        let identifier = name == "_" ? domain : "\(name)@\(domain)"
        return Nip05Request(identifier: identifier, name: name, domain: domain, url: url)
    }

    public static func resolve(
        _ identifier: String,
        session: URLSession = .shared
    ) async throws -> Nip05Resolution {
        let nip05Request = try request(for: identifier)
        var request = URLRequest(url: nip05Request.url)
        request.timeoutInterval = 12
        request.cachePolicy = .reloadRevalidatingCacheData
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Nip05Error.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw Nip05Error.requestFailed(http.statusCode)
        }
        return try parse(data, request: nip05Request)
    }

    public static func verify(
        _ identifier: String,
        publicKeyHex: String,
        session: URLSession = .shared
    ) async throws -> Nip05Resolution {
        let resolution = try await resolve(identifier, session: session)
        guard resolution.matches(publicKeyHex: publicKeyHex) else {
            throw Nip05Error.publicKeyMismatch
        }
        return resolution
    }

    public static func parse(_ data: Data, request: Nip05Request) throws -> Nip05Resolution {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let names = object["names"] as? [String: Any],
              let rawKey = names.first(where: {
                  $0.key.caseInsensitiveCompare(request.name) == .orderedSame
              })?.value as? String,
              let key = try? Data(hex: rawKey),
              key.count == 32 else {
            throw Nip05Error.nameNotFound
        }
        let publicKeyHex = key.hexString
        let relayMap = object["relays"] as? [String: Any]
        let rawRelays = relayMap?.first(where: {
            $0.key.caseInsensitiveCompare(publicKeyHex) == .orderedSame
        })?.value as? [String] ?? []
        return Nip05Resolution(
            identifier: request.identifier,
            publicKeyHex: publicKeyHex,
            relayURLs: TaskifyRelayURL.normalizedList(rawRelays)
        )
    }
}

import Foundation

/// A Lightning address of the form `<npub>@npub.cash` that resolves deterministically from a
/// Nostr identity — no signup step, matching the PWA's `deriveNpubCashIdentity`.
public struct NpubCashIdentity: Equatable, Sendable {
    public let npub: String
    public let address: String
}

public struct NpubCashClaimResult: Equatable, Sendable {
    public let tokens: [String]
    public let balance: Int
}

public enum NpubCashError: LocalizedError, Equatable {
    case invalidResponse
    case requestFailed(status: Int, message: String?)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "npub.cash returned an unexpected response."
        case .requestFailed(_, let message): message ?? "npub.cash request failed."
        }
    }
}

/// Client for npub.cash's NIP-98-authenticated balance/claim API, matching the PWA's
/// `wallet/npubCash.ts`. Claimed tokens are plain Cashu tokens redeemed through the normal
/// wallet receive path — this type only handles identity derivation, request signing, and
/// response parsing.
public enum NpubCashClient {
    public static let domain = "npub.cash"
    private static let apiBase = "https://npub.cash/api/v1"

    public static func identity(npub: String) -> NpubCashIdentity {
        NpubCashIdentity(npub: npub, address: "\(npub)@\(domain)")
    }

    public static func fetchBalance(
        identity: NostrIdentity,
        session: URLSession = .shared
    ) async throws -> Int {
        let data = try await request(path: "balance", method: "GET", identity: identity, session: session)
        return extractBalance(from: data)
    }

    /// Fetches the pending balance and, if positive, the tokens covering it. Matches the PWA's
    /// two-step balance-then-claim sequence so an empty inbox skips the second request.
    public static func claim(
        identity: NostrIdentity,
        session: URLSession = .shared
    ) async throws -> NpubCashClaimResult {
        let balance = try await fetchBalance(identity: identity, session: session)
        guard balance > 0 else { return NpubCashClaimResult(tokens: [], balance: 0) }
        let data = try await request(path: "claim", method: "GET", identity: identity, session: session)
        return NpubCashClaimResult(tokens: extractTokens(from: data), balance: balance)
    }

    static func authHeader(
        urlString: String,
        method: String,
        identity: NostrIdentity,
        now: Date = Date()
    ) throws -> String {
        let event = try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: Int(now.timeIntervalSince1970),
            kind: 27_235,
            tags: [["u", urlString], ["method", method]],
            content: ""
        )
        return "Nostr \(try JSONEncoder().encode(event).base64EncodedString())"
    }

    private static func request(
        path: String,
        method: String,
        identity: NostrIdentity,
        session: URLSession
    ) async throws -> Data {
        let urlString = "\(apiBase)/\(path)"
        guard let url = URL(string: urlString) else { throw NpubCashError.invalidResponse }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue(
            try authHeader(urlString: urlString, method: method, identity: identity),
            forHTTPHeaderField: "Authorization"
        )
        urlRequest.setValue("application/json,text/plain", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw NpubCashError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw NpubCashError.requestFailed(
                status: http.statusCode,
                message: (message?.isEmpty == false) ? message : nil
            )
        }
        return data
    }

    // MARK: - Parsing

    static func extractBalance(from data: Data) -> Int {
        guard let json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return 0
        }
        return balanceValue(json) ?? 0
    }

    private static func balanceValue(_ value: Any) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String, let parsed = Int(string) { return parsed }
        if let dict = value as? [String: Any] {
            for key in ["balance", "data", "amount"] {
                if let nested = dict[key], let resolved = balanceValue(nested) {
                    return resolved
                }
            }
        }
        return nil
    }

    static func extractTokens(from data: Data) -> [String] {
        var seen = Set<String>()
        var tokens: [String] = []
        if let json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
            collectTokens(from: json, seen: &seen, into: &tokens)
        }
        if tokens.isEmpty, let text = String(data: data, encoding: .utf8) {
            for match in tokensInText(text) where !seen.contains(match) {
                seen.insert(match)
                tokens.append(match)
            }
        }
        return tokens
    }

    private static func collectTokens(from value: Any, seen: inout Set<String>, into tokens: inout [String]) {
        if let string = value as? String {
            for match in tokensInText(string) where !seen.contains(match) {
                seen.insert(match)
                tokens.append(match)
            }
        } else if let array = value as? [Any] {
            for entry in array { collectTokens(from: entry, seen: &seen, into: &tokens) }
        } else if let dict = value as? [String: Any] {
            for entry in dict.values { collectTokens(from: entry, seen: &seen, into: &tokens) }
        }
    }

    private static let tokenExpression = try! NSRegularExpression(
        pattern: #"cashu[A-Za-z0-9_-]+"#,
        options: [.caseInsensitive]
    )

    private static func tokensInText(_ text: String) -> [String] {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return tokenExpression.matches(in: text, range: range).compactMap {
            Range($0.range, in: text).map { String(text[$0]) }
        }
    }
}

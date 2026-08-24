import Foundation

public struct SolifeConfig: Equatable, Sendable {
    public let domain: String
    public let mintUrl: String
    public let customAddressPriceSats: Int
    public let authKind: Int
}

public struct SolifeAddress: Equatable, Sendable {
    public let handle: String
    public let address: String
    public let mintUrl: String
    public let mintOverride: Bool
}

public struct SolifeAddressPurchase: Equatable, Sendable {
    public let purchaseID: String
    public let handle: String?
    public let address: String
    public let priceSats: Int
    public let bolt11: String
    public let status: String
    public let error: String?

    public var isSettled: Bool {
        status == "address_claimed" || status == "expired" || status == "error"
    }
}

public enum SolifeCustomAddressClaim: Equatable, Sendable {
    case address(SolifeAddress)
    case purchase(SolifeAddressPurchase)
}

public struct SolifeAddressAvailability: Equatable, Sendable {
    public let available: Bool
    public let handle: String
    public let address: String
    public let priceSats: Int
    public let reason: String?
}

public struct SolifeAccount: Equatable, Sendable {
    public let npub: String
    public let lightningAddress: String
    public let lightningAddressMintUrl: String
    public let lightningAddressMintOverride: Bool
    public let addresses: [SolifeAddress]
    public let addressPurchases: [SolifeAddressPurchase]
}

public enum SolifeError: LocalizedError, Equatable {
    case invalidResponse
    case requestFailed(status: Int, message: String?)
    case authenticationFailed

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "solife.me returned an unexpected response."
        case .requestFailed(_, let message): message ?? "solife.me request failed."
        case .authenticationFailed: "Unable to sign in to solife.me."
        }
    }
}

struct SolifeSession: Equatable, Sendable {
    let token: String?
}

/// Client for solife.me's Lightning-address service: a pure forwarder for the default
/// `<npub>@solife.me` address (see `address(npub:)` — no account, no auth, no network call), plus
/// authenticated custom-handle management for users who want a vanity address instead. Auth
/// mirrors the PWA's `wallet/solife.ts`: a NIP-98-style challenge signed with the Nostr identity,
/// exchanged for a bearer token, re-done per action exactly like the PWA (no session caching).
public enum SolifeClient {
    public static let domain = "solife.me"
    private static let baseURL = "https://solife.me"

    public static func address(npub: String) -> String {
        "\(npub)@\(domain)"
    }

    /// Resolves the address shown on Receive without requiring an account fetch on every launch.
    /// A custom address was already authenticated when the user selected it, so its persisted
    /// value remains authoritative while the account is not loaded. Once fresh account data is
    /// available, a selection that is no longer owned falls back to the account default.
    public static func preferredReceiveAddress(
        selectedAddress: String?,
        account: SolifeAccount?,
        derivedAddress: String?
    ) -> String? {
        let selected = normalizedAddress(selectedAddress)
        if let selected {
            if account == nil || account?.addresses.contains(where: {
                normalizedAddress($0.address) == selected
            }) == true {
                return selected
            }
        }

        if let accountAddress = normalizedAddress(account?.lightningAddress) {
            return accountAddress
        }
        return normalizedAddress(derivedAddress)
    }

    private static func normalizedAddress(_ address: String?) -> String? {
        let normalized = address?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }

    public static func fetchConfig(session: URLSession = .shared) async throws -> SolifeConfig {
        let data = try await request(path: "/api/config", method: "GET", session: session)
        return try parseConfig(data)
    }

    /// Unauthenticated — matches the PWA, which checks handle availability before a user signs in.
    public static func fetchAddressAvailability(
        handle: String,
        session: URLSession = .shared
    ) async throws -> SolifeAddressAvailability {
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "handle", value: handle)]
        let query = components.percentEncodedQuery ?? ""
        let data = try await request(
            path: "/api/addresses/availability?\(query)",
            method: "GET",
            session: session
        )
        return try parseAvailability(data)
    }

    public static func fetchAccount(
        identity: NostrIdentity,
        session: URLSession = .shared
    ) async throws -> (config: SolifeConfig, account: SolifeAccount) {
        let config = try await fetchConfig(session: session)
        let solifeSession = try await createSession(identity: identity, config: config, session: session)
        let data = try await request(path: "/api/me", method: "GET", token: solifeSession.token, session: session)
        return (config, try parseAccount(data, fallbackMintURL: config.mintUrl))
    }

    /// Claims a custom handle. A price of zero settles immediately (`.address`); otherwise the
    /// server returns an invoice to pay before the handle is claimed (`.purchase`).
    public static func claimCustomAddress(
        identity: NostrIdentity,
        handle: String,
        relays: [String],
        mintURL: String?,
        session: URLSession = .shared
    ) async throws -> (config: SolifeConfig, claim: SolifeCustomAddressClaim) {
        let config = try await fetchConfig(session: session)
        let solifeSession = try await createSession(identity: identity, config: config, session: session)
        var body: [String: Any] = ["handle": handle, "relays": relays]
        if let mintURL { body["mintUrl"] = mintURL }
        let data = try await request(
            path: "/api/addresses",
            method: "POST",
            body: body,
            token: solifeSession.token,
            session: session
        )
        return (config, try parseClaim(data))
    }

    /// Polls a purchase's settlement state after its invoice has been paid.
    public static func verifyAddressPurchase(
        identity: NostrIdentity,
        purchaseID: String,
        session: URLSession = .shared
    ) async throws -> (config: SolifeConfig, purchase: SolifeAddressPurchase) {
        let config = try await fetchConfig(session: session)
        let solifeSession = try await createSession(identity: identity, config: config, session: session)
        let encodedID = purchaseID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? purchaseID
        let data = try await request(
            path: "/api/address-purchases/\(encodedID)/verify",
            method: "POST",
            token: solifeSession.token,
            session: session
        )
        return (config, try parsePurchase(data))
    }

    /// Changes which mint receives payments for the default (non-custom) address. Pass `nil` to
    /// reset to the server default.
    public static func updateDefaultMint(
        identity: NostrIdentity,
        mintURL: String?,
        session: URLSession = .shared
    ) async throws -> (mintURL: String, mintOverride: Bool) {
        let config = try await fetchConfig(session: session)
        let solifeSession = try await createSession(identity: identity, config: config, session: session)
        var body: [String: Any] = [:]
        body["mintUrl"] = mintURL ?? NSNull()
        let data = try await request(
            path: "/api/me/mint",
            method: "PATCH",
            body: body,
            token: solifeSession.token,
            session: session
        )
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }
        return (
            (json["mintUrl"] as? String) ?? config.mintUrl,
            (json["mintOverride"] as? Bool) ?? false
        )
    }

    /// Changes which mint receives payments for one custom address.
    public static func updateCustomAddressMint(
        identity: NostrIdentity,
        handle: String,
        mintURL: String?,
        session: URLSession = .shared
    ) async throws -> SolifeAddress {
        let config = try await fetchConfig(session: session)
        let solifeSession = try await createSession(identity: identity, config: config, session: session)
        let encodedHandle = handle.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? handle
        let data = try await request(
            path: "/api/addresses/\(encodedHandle)",
            method: "PATCH",
            body: ["mintUrl": mintURL ?? ""],
            token: solifeSession.token,
            session: session
        )
        return try parseAddress(data, fallbackMintURL: config.mintUrl)
    }

    // MARK: - Auth

    static func createSession(
        identity: NostrIdentity,
        config: SolifeConfig,
        session: URLSession = .shared
    ) async throws -> SolifeSession {
        let challengeData = try await request(
            path: "/api/auth/challenge",
            method: "POST",
            body: ["pubkey": identity.publicKeyHex],
            session: session
        )
        guard let challengeJSON = try? JSONSerialization.jsonObject(with: challengeData) as? [String: Any],
              let challenge = challengeJSON["challenge"] as? String, !challenge.isEmpty else {
            throw SolifeError.authenticationFailed
        }
        let message = (challengeJSON["message"] as? String) ?? "Sign in to \(config.domain): \(challenge)"
        let kind = (challengeJSON["kind"] as? Int).flatMap { $0 != 0 ? $0 : nil } ?? config.authKind

        let event = try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: kind,
            tags: [["challenge", challenge], ["domain", config.domain]],
            content: message
        )
        guard let eventJSON = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(event)) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }

        let verifyData = try await request(
            path: "/api/auth/verify",
            method: "POST",
            body: [
                "pubkey": identity.publicKeyHex,
                "challenge": challenge,
                "event": eventJSON,
            ],
            session: session
        )
        let verifyJSON = (try? JSONSerialization.jsonObject(with: verifyData) as? [String: Any]) ?? [:]
        return SolifeSession(token: verifyJSON["token"] as? String)
    }

    // MARK: - Networking

    private static func request(
        path: String,
        method: String,
        body: [String: Any]? = nil,
        token: String? = nil,
        session: URLSession
    ) async throws -> Data {
        guard let url = URL(string: "\(baseURL)\(path)") else { throw SolifeError.invalidResponse }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw SolifeError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["error"] as? String) ?? ($0["message"] as? String) }
            throw SolifeError.requestFailed(status: http.statusCode, message: message)
        }
        return data
    }

    // MARK: - Parsing

    static func parseConfig(_ data: Data) throws -> SolifeConfig {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }
        let domain = (json["domain"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SolifeConfig(
            domain: (domain?.isEmpty == false) ? domain! : Self.domain,
            mintUrl: (json["mintUrl"] as? String) ?? "",
            customAddressPriceSats: (json["customAddressPriceSats"] as? Int) ?? 0,
            authKind: (json["authKind"] as? Int) ?? 27_235
        )
    }

    static func parseAvailability(_ data: Data) throws -> SolifeAddressAvailability {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }
        return SolifeAddressAvailability(
            available: (json["available"] as? Bool) ?? false,
            handle: (json["handle"] as? String) ?? "",
            address: (json["address"] as? String) ?? "",
            priceSats: (json["priceSats"] as? Int) ?? 0,
            reason: json["reason"] as? String
        )
    }

    private static func parseAddress(_ json: [String: Any], fallbackMintURL: String) -> SolifeAddress {
        let mintURL = (json["mintUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SolifeAddress(
            handle: (json["handle"] as? String) ?? "",
            address: (json["address"] as? String) ?? "",
            mintUrl: (mintURL?.isEmpty == false) ? mintURL! : fallbackMintURL,
            mintOverride: (json["mintOverride"] as? Bool) ?? false
        )
    }

    static func parseAddress(_ data: Data, fallbackMintURL: String) throws -> SolifeAddress {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }
        return parseAddress(json, fallbackMintURL: fallbackMintURL)
    }

    private static func parsePurchase(_ json: [String: Any]) -> SolifeAddressPurchase {
        SolifeAddressPurchase(
            purchaseID: (json["purchaseId"] as? String) ?? "",
            handle: json["handle"] as? String,
            address: ((json["address"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            priceSats: (json["priceSats"] as? Int) ?? 0,
            bolt11: (json["bolt11"] as? String) ?? "",
            status: (json["status"] as? String) ?? "",
            error: json["error"] as? String
        )
    }

    static func parsePurchase(_ data: Data) throws -> SolifeAddressPurchase {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }
        return parsePurchase(json)
    }

    static func parseClaim(_ data: Data) throws -> SolifeCustomAddressClaim {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }
        if json["purchaseId"] is String, json["address"] is String {
            return .purchase(parsePurchase(json))
        }
        return .address(parseAddress(json, fallbackMintURL: ""))
    }

    static func parseAccount(_ data: Data, fallbackMintURL: String) throws -> SolifeAccount {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SolifeError.invalidResponse
        }
        let mintURL = (json["lightningAddressMintUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedFallback = (mintURL?.isEmpty == false) ? mintURL! : fallbackMintURL
        let addresses = (json["addresses"] as? [[String: Any]] ?? []).map {
            parseAddress($0, fallbackMintURL: resolvedFallback)
        }
        let purchases = (json["addressPurchases"] as? [[String: Any]] ?? []).map(parsePurchase)
        return SolifeAccount(
            npub: (json["npub"] as? String) ?? "",
            lightningAddress: (json["lightningAddress"] as? String) ?? "",
            lightningAddressMintUrl: resolvedFallback,
            lightningAddressMintOverride: (json["lightningAddressMintOverride"] as? Bool) ?? false,
            addresses: addresses,
            addressPurchases: purchases
        )
    }
}

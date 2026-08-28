import CryptoKit
import Foundation

public enum DMPushRegistrationError: LocalizedError, Equatable {
    case invalidServer
    case invalidResponse
    case requestFailed(status: Int, message: String?)

    public var errorDescription: String? {
        switch self {
        case .invalidServer: "The push server address must be a secure HTTPS URL."
        case .invalidResponse: "The push server returned an invalid response."
        case .requestFailed(_, let message): message ?? "The push server rejected this device."
        }
    }
}

public struct DMPushRegistrationResponse: Decodable, Equatable, Sendable {
    public let enabled: Bool
    public let remainingRegistrations: Int?
}

public enum DMPushRegistrationClient {
    private struct RegistrationPayload: Encodable {
        let deviceToken: String
        let environment: String
    }

    public static func registrationURL(baseURL: URL, installationID: String) -> URL {
        baseURL
            .appendingPathComponent("v1", isDirectory: true)
            .appendingPathComponent("registrations", isDirectory: true)
            .appendingPathComponent(installationID, isDirectory: false)
    }

    public static func authHeader(
        privateKey: Data,
        url: URL,
        method: String,
        body: Data,
        now: Date = Date()
    ) throws -> String {
        let event = try NostrEvent.signed(
            privateKey: privateKey,
            createdAt: Int(now.timeIntervalSince1970),
            kind: 27_235,
            tags: [
                ["u", url.absoluteString],
                ["method", method.uppercased()],
                ["payload", Data(SHA256.hash(data: body)).hexString],
            ],
            content: ""
        )
        return "Nostr \(try JSONEncoder().encode(event).base64EncodedString())"
    }

    public static func register(
        deviceToken: String,
        environment: String,
        installationID: String,
        baseURL: URL,
        identity: NostrIdentity,
        session: URLSession = .shared
    ) async throws -> DMPushRegistrationResponse {
        let payload = RegistrationPayload(deviceToken: deviceToken, environment: environment)
        let body = try JSONEncoder().encode(payload)
        return try await request(
            method: "PUT",
            body: body,
            installationID: installationID,
            baseURL: baseURL,
            identity: identity,
            session: session
        )
    }

    public static func unregister(
        installationID: String,
        baseURL: URL,
        identity: NostrIdentity,
        session: URLSession = .shared
    ) async throws -> DMPushRegistrationResponse {
        try await request(
            method: "DELETE",
            body: Data("{}".utf8),
            installationID: installationID,
            baseURL: baseURL,
            identity: identity,
            session: session
        )
    }

    private static func request(
        method: String,
        body: Data,
        installationID: String,
        baseURL: URL,
        identity: NostrIdentity,
        session: URLSession
    ) async throws -> DMPushRegistrationResponse {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host != nil else {
            throw DMPushRegistrationError.invalidServer
        }
        let url = registrationURL(baseURL: baseURL, installationID: installationID)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            try authHeader(
                privateKey: identity.privateKey,
                url: url,
                method: method,
                body: body
            ),
            forHTTPHeaderField: "Authorization"
        )
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DMPushRegistrationError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw DMPushRegistrationError.requestFailed(status: http.statusCode, message: message)
        }
        guard let decoded = try? JSONDecoder().decode(DMPushRegistrationResponse.self, from: data) else {
            throw DMPushRegistrationError.invalidResponse
        }
        return decoded
    }
}

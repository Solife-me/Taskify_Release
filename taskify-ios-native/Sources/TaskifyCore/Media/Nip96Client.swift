import CryptoKit
import Foundation

public enum Nip96Error: LocalizedError, Equatable {
    case invalidServer
    case invalidDiscoveryResponse
    case missingAPIURL
    case tooManyDelegations
    case invalidUploadResponse
    case requestFailed(status: Int, message: String?)
    case processingTimedOut

    public var errorDescription: String? {
        switch self {
        case .invalidServer:
            "The NIP-96 server address is not configured correctly."
        case .invalidDiscoveryResponse:
            "The NIP-96 server returned invalid discovery information."
        case .missingAPIURL:
            "The NIP-96 server did not publish an upload address."
        case .tooManyDelegations:
            "The NIP-96 server redirected discovery too many times."
        case .invalidUploadResponse:
            "The NIP-96 server did not return an attachment URL."
        case .requestFailed(let status, let message):
            if let message, !message.isEmpty {
                "The NIP-96 server rejected the upload (\(status)): \(message)"
            } else {
                "The NIP-96 server rejected the upload (\(status))."
            }
        case .processingTimedOut:
            "The NIP-96 server is still processing the attachment. Try again shortly."
        }
    }
}

public struct Nip96ServerInfo: Equatable, Sendable {
    public let baseURL: URL
    public let apiURL: URL
    public let delegatedServerURL: URL?
}

public struct Nip96DiscoveryResponse: Equatable, Sendable {
    public let apiURL: URL?
    public let delegatedServerURL: URL?
}

/// NIP-96 discovery and upload support matching the PWA's `Nip96Client.ts` contract.
/// Authorization uses a signed NIP-98 kind-27235 event over the exact upload URL, HTTP method,
/// and SHA-256 of the encrypted bytes. Taskify encrypts attachments before this layer sees them.
public enum Nip96Client {
    public static let authEventKind = 27_235
    public static let discoveryPath = ".well-known/nostr/nip96.json"

    public static func authHeader(
        privateKey: Data,
        url: URL,
        method: String,
        sha256Hex: String,
        now: Date = Date()
    ) throws -> String {
        let event = try NostrEvent.signed(
            privateKey: privateKey,
            createdAt: Int(now.timeIntervalSince1970),
            kind: authEventKind,
            tags: [
                ["u", url.absoluteString],
                ["method", method.uppercased()],
                ["payload", sha256Hex],
            ],
            content: ""
        )
        return "Nostr \(try JSONEncoder().encode(event).base64EncodedString())"
    }

    public static func parseDiscoveryResponse(
        _ data: Data,
        baseURL: URL
    ) throws -> Nip96DiscoveryResponse {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Nip96Error.invalidDiscoveryResponse
        }
        let apiRaw = (payload["api_url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let delegatedRaw = (payload["delegated_to_url"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let apiURL = apiRaw.flatMap { $0.isEmpty ? nil : resolvedURL($0, relativeTo: baseURL) }
        let delegatedURL = delegatedRaw.flatMap { $0.isEmpty ? nil : resolvedURL($0, relativeTo: baseURL) }
        guard apiURL != nil || delegatedURL != nil else { throw Nip96Error.missingAPIURL }
        return Nip96DiscoveryResponse(apiURL: apiURL, delegatedServerURL: delegatedURL)
    }

    public static func remoteURL(from data: Data) throws -> URL? {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Nip96Error.invalidUploadResponse
        }
        if let nip94 = (payload["nip94_event"] ?? payload["nip94"]) as? [String: Any],
           let tags = nip94["tags"] as? [[Any]] {
            for tag in tags where tag.count >= 2 {
                guard tag[0] as? String == "url", let raw = tag[1] as? String else { continue }
                if let url = validatedRemoteURL(raw) { return url }
            }
        }
        if let raw = payload["url"] as? String { return validatedRemoteURL(raw) }
        return nil
    }

    public static func discover(
        server: URL,
        session: URLSession = .shared,
        maximumDelegations: Int = 3
    ) async throws -> Nip96ServerInfo {
        try validateHTTPS(server)
        return try await discover(
            originalServer: server,
            currentServer: server,
            session: session,
            remainingDelegations: maximumDelegations
        )
    }

    public static func upload(
        _ data: Data,
        filename: String,
        privateKey: Data,
        server: URL,
        session: URLSession = .shared,
        processingTimeout: TimeInterval = 12
    ) async throws -> String {
        let info = try await discover(server: server, session: session)
        let payloadHash = Data(SHA256.hash(data: data)).hexString
        let auth = try authHeader(
            privateKey: privateKey,
            url: info.apiURL,
            method: "POST",
            sha256Hex: payloadHash
        )
        let boundary = "TaskifyNative-\(UUID().uuidString)"
        let bodyURL = try makeMultipartUploadFile(
            data: data,
            filename: filename,
            boundary: boundary
        )
        defer { try? FileManager.default.removeItem(at: bodyURL) }

        var request = URLRequest(url: info.apiURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(auth, forHTTPHeaderField: "Authorization")

        let (responseData, response) = try await session.upload(for: request, fromFile: bodyURL)
        guard let http = response as? HTTPURLResponse else { throw Nip96Error.invalidUploadResponse }
        var finalData = responseData
        var finalStatus = http.statusCode

        if http.statusCode == 202,
           let processingURL = processingURL(from: responseData, relativeTo: info.apiURL) {
            let result = try await pollProcessing(
                url: processingURL,
                authorization: auth,
                session: session,
                timeout: processingTimeout
            )
            finalData = result.data
            finalStatus = result.status
        }

        guard (200..<300).contains(finalStatus), finalStatus != 202 else {
            if finalStatus == 202 { throw Nip96Error.processingTimedOut }
            throw Nip96Error.requestFailed(status: finalStatus, message: responseMessage(from: finalData))
        }
        guard let remoteURL = try remoteURL(from: finalData) else {
            throw Nip96Error.invalidUploadResponse
        }
        return remoteURL.absoluteString
    }

    private static func discover(
        originalServer: URL,
        currentServer: URL,
        session: URLSession,
        remainingDelegations: Int
    ) async throws -> Nip96ServerInfo {
        guard remainingDelegations >= 0 else { throw Nip96Error.tooManyDelegations }
        let discoveryURL = currentServer.appendingPathComponent(discoveryPath, isDirectory: false)
        var request = URLRequest(url: discoveryURL)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 30
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Nip96Error.invalidDiscoveryResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw Nip96Error.requestFailed(status: http.statusCode, message: responseMessage(from: data))
        }
        let parsed = try parseDiscoveryResponse(data, baseURL: currentServer)
        if let apiURL = parsed.apiURL {
            try validateHTTPS(apiURL)
            return Nip96ServerInfo(
                baseURL: originalServer,
                apiURL: apiURL,
                delegatedServerURL: currentServer == originalServer ? nil : currentServer
            )
        }
        guard let delegated = parsed.delegatedServerURL else { throw Nip96Error.missingAPIURL }
        try validateHTTPS(delegated)
        return try await discover(
            originalServer: originalServer,
            currentServer: delegated,
            session: session,
            remainingDelegations: remainingDelegations - 1
        )
    }

    private static func pollProcessing(
        url: URL,
        authorization: String,
        session: URLSession,
        timeout: TimeInterval
    ) async throws -> (status: Int, data: Data) {
        let deadline = Date().addingTimeInterval(timeout)
        var delayNanoseconds: UInt64 = 750_000_000
        var lastData = Data()
        while Date() < deadline {
            var request = URLRequest(url: url)
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
            request.timeoutInterval = min(30, max(1, timeout))
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw Nip96Error.invalidUploadResponse }
            lastData = data
            if http.statusCode != 202 { return (http.statusCode, data) }
            try await Task.sleep(nanoseconds: delayNanoseconds)
            delayNanoseconds = min(UInt64(Double(delayNanoseconds) * 1.5), 3_200_000_000)
        }
        return (202, lastData)
    }

    private static func makeMultipartUploadFile(
        data: Data,
        filename: String,
        boundary: String
    ) throws -> URL {
        let safeFilename = filename
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-nip96-\(UUID().uuidString).multipart")
        FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: fileURL)
        do {
            try handle.write(contentsOf: Data("--\(boundary)\r\n".utf8))
            try handle.write(contentsOf: Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeFilename)\"\r\n".utf8))
            try handle.write(contentsOf: Data("Content-Type: application/octet-stream\r\n\r\n".utf8))
            try handle.write(contentsOf: data)
            try handle.write(contentsOf: Data("\r\n--\(boundary)\r\n".utf8))
            try handle.write(contentsOf: Data("Content-Disposition: form-data; name=\"filename\"\r\n\r\n\(safeFilename)\r\n".utf8))
            try handle.write(contentsOf: Data("--\(boundary)\r\n".utf8))
            try handle.write(contentsOf: Data("Content-Disposition: form-data; name=\"content_type\"\r\n\r\napplication/octet-stream\r\n".utf8))
            try handle.write(contentsOf: Data("--\(boundary)\r\n".utf8))
            try handle.write(contentsOf: Data("Content-Disposition: form-data; name=\"size\"\r\n\r\n\(data.count)\r\n".utf8))
            try handle.write(contentsOf: Data("--\(boundary)--\r\n".utf8))
            try handle.close()
            return fileURL
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: fileURL)
            throw error
        }
    }

    private static func processingURL(from data: Data, relativeTo baseURL: URL) -> URL? {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = payload["processing_url"] as? String else { return nil }
        return resolvedURL(raw, relativeTo: baseURL)
    }

    private static func responseMessage(from data: Data) -> String? {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        for key in ["message", "error", "reason", "detail"] {
            if let value = payload[key] as? String, !value.isEmpty { return value }
        }
        return nil
    }

    private static func resolvedURL(_ value: String, relativeTo baseURL: URL) -> URL? {
        URL(string: value, relativeTo: baseURL)?.absoluteURL
    }

    private static func validatedRemoteURL(_ value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { return nil }
        return url
    }

    private static func validateHTTPS(_ url: URL) throws {
        guard url.scheme?.lowercased() == "https", url.host?.isEmpty == false else {
            throw Nip96Error.invalidServer
        }
    }
}

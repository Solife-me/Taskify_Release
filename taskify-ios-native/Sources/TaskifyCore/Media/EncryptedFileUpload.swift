import Foundation

public struct EncryptedFileUploadRequest: Sendable {
    public let request: URLRequest
    public let body: URL
    public let removesBody: Bool
    public let server: TaskifyFileServerEntry
}

/// Shared by in-app transfers and the share extension's background URL session.
/// The input must already be authenticated ciphertext; only ciphertext touches the host.
public enum EncryptedFileUpload {
    public static func prepare(file: URL, filename: String, server: TaskifyFileServerEntry,
                               privateKey: Data?, directory: URL? = nil,
                               session: URLSession = .shared) async throws -> EncryptedFileUploadRequest {
        guard let base = URL(string: server.url), base.scheme?.lowercased() == "https", base.host != nil else {
            throw BlossomError.invalidServer
        }
        _ = try AttachmentFiles.size(file, limit: AttachmentFiles.maximumBytes + 32)
        var endpoint = base.appendingPathComponent("upload")
        if server.type == .nip96 { endpoint = try await Nip96Client.discover(server: base, session: session).apiURL }
        var request = URLRequest(url: endpoint)
        request.httpMethod = server.type == .blossom ? "PUT" : "POST"
        request.timeoutInterval = 120 // inactivity timeout; the resource budget allows slow large transfers
        if server.type != .originless {
            guard let privateKey else { throw URLError(.userAuthenticationRequired) }
            let hash = try AttachmentFiles.sha256(file)
            let auth = try server.type == .blossom
                ? BlossomClient.authHeader(privateKey: privateKey, sha256Hex: hash)
                : Nip96Client.authHeader(privateKey: privateKey, url: endpoint, method: "POST", sha256Hex: hash)
            request.setValue(auth, forHTTPHeaderField: "Authorization")
        }
        let body: URL
        if server.type == .blossom {
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            body = file
        } else {
            let boundary = "Taskify-\(UUID().uuidString)"
            body = try AttachmentFiles.multipart(file: file, filename: filename, boundary: boundary,
                                                  nip96: server.type == .nip96, directory: directory)
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        }
        return EncryptedFileUploadRequest(request: request, body: body, removesBody: body != file, server: server)
    }

    public static func upload(file: URL, filename: String, server: TaskifyFileServerEntry,
                              privateKey: Data?, session: URLSession = .shared,
                              progress: AttachmentProgressHandler? = nil) async throws -> String {
        progress?(.preparingUpload)
        let prepared = try await prepare(file: file, filename: filename, server: server, privateKey: privateKey, session: session)
        defer { if prepared.removesBody { try? FileManager.default.removeItem(at: prepared.body) } }
        let (data, response) = try await AttachmentUploadTransport.upload(request: prepared.request,
            file: prepared.body, session: session, progress: progress)
        guard let http = response as? HTTPURLResponse else { throw Nip96Error.invalidUploadResponse }
        return try await finish(data: data, response: http, server: server, authorization: prepared.request.value(forHTTPHeaderField: "Authorization"), session: session)
    }

    public static func finish(data: Data, response: HTTPURLResponse, server: TaskifyFileServerEntry,
                              authorization: String? = nil, session: URLSession = .shared) async throws -> String {
        var payload = data
        var status = response.statusCode
        if server.type == .nip96, status == 202 {
            guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                  let path = json["processing_url"] as? String,
                  let base = response.url,
                  let url = URL(string: path, relativeTo: base)?.absoluteURL,
                  url.scheme == "https", url.host == base.host, (url.port ?? 443) == (base.port ?? 443) else { throw Nip96Error.invalidUploadResponse }
            let deadline = Date().addingTimeInterval(60)
            while status == 202, Date() < deadline {
                try await Task.sleep(for: .seconds(1))
                var request = URLRequest(url: url)
                request.timeoutInterval = 15
                request.setValue(authorization, forHTTPHeaderField: "Authorization")
                let (next, nextResponse) = try await session.data(for: request)
                payload = next
                status = (nextResponse as? HTTPURLResponse)?.statusCode ?? 0
            }
        }
        guard (200..<300).contains(status), status != 202 else {
            let json = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any]
            if status == 202 { throw Nip96Error.processingTimedOut }
            let message = json?["message"] as? String ?? json?["error"] as? String
            throw AttachmentUploadError.server(server: server.displayLabel, status: status, message: message)
        }
        return try remoteURL(data: payload, server: server)
    }

    public static func remoteURL(data: Data, server: TaskifyFileServerEntry) throws -> String {
        if server.type == .nip96, let url = try Nip96Client.remoteURL(from: data) { return url.absoluteString }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw Nip96Error.invalidUploadResponse
        }
        for key in ["url", "cidUrl", "gatewayUrl", "fileUrl", "ipfs"] {
            if let text = json[key] as? String, let url = validated(text) { return url.absoluteString }
        }
        if let cid = json["cid"] as? String, let url = TaskifyIPFSGateway.url(forCID: cid) { return url }
        if let path = json["path"] as? String, !path.isEmpty {
            if let url = validated(path) { return url.absoluteString }
            if let base = URL(string: server.url), let url = validated(base.appendingPathComponent(path).absoluteString) {
                return url.absoluteString
            }
        }
        throw Nip96Error.invalidUploadResponse
    }

    private static func validated(_ value: String) -> URL? {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
        return url
    }
}

public enum AttachmentUploadError: LocalizedError {
    case server(server: String, status: Int, message: String?)

    public var errorDescription: String? {
        switch self {
        case let .server(server, status, message):
            if status == 413 { return "\(server) rejected this file because its upload limit is smaller than the file (413)." }
            if status == 415 { return "\(server) does not accept encrypted file uploads of this type (415)." }
            let detail = message?.trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(server) rejected the upload (\(status))." + (detail.flatMap { $0.isEmpty ? nil : " \(String($0.prefix(300)))" } ?? "")
        }
    }
}

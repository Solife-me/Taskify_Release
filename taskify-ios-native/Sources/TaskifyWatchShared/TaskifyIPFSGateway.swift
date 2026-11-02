import Foundation

/// Builds and resolves retrieval URLs for content-addressed uploads.
///
/// Originless returns only a CID and does not serve blobs itself -- `GET {server}/ipfs/{cid}` is
/// not a route on it, in either the current or the pre-refactor layout, so a URL built that way
/// 404s. Retrieval goes through a public gateway instead.
///
/// Fetching through a public gateway is a metadata trade, not a confidentiality one: Taskify
/// encrypts attachments before upload, so the gateway only ever handles ciphertext, and AES-GCM
/// rejects anything altered. What it does learn is that some client asked for a particular CID.
public enum TaskifyIPFSGateway {
    /// In order of preference. A CID names the same bytes on every gateway, so an attachment whose
    /// gateway has gone away can still be fetched from another. Both were verified serving an
    /// Originless upload, with CORS open for the PWA, in November 2026.
    public static let bases = ["https://ipfs.filebase.io", "https://gateway.pinata.cloud"]
    public static let defaultBase = bases[0]

    /// Protocol Labs' gateways stopped serving content to apps on September 21, 2026: every request
    /// now gets a permanent 429 pointing at a browser-only service worker gateway. Messages already
    /// sent still carry these URLs, so they are redirected to `bases` rather than tried first.
    private static let retiredHosts = ["dweb.link", "ipfs.io", "w3s.link", "nftstorage.link"]

    public static func url(forCID cid: String, base: String = defaultBase) -> String? {
        let trimmedCID = cid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCID.isEmpty, isPlausibleCID(trimmedCID) else { return nil }

        let trimmedBase = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmedBase),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { return nil }

        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        components.path = "\(path)/ipfs/\(trimmedCID)"
        return components.url?.absoluteString
    }

    /// A file server behind a TLS-terminating proxy can describe its blobs as `http://` when the
    /// proxy doesn't forward the original scheme, as blossom-server does without
    /// `X-Forwarded-Proto`. App Transport Security refuses those URLs, yet the same blob is served
    /// over https. IP addresses, unqualified names and mDNS hosts have no public certificate to
    /// upgrade to, so they are left alone.
    public static func httpsUpgraded(_ url: URL) -> URL {
        guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased(),
              host.contains("."), !host.contains(":"), !host.hasSuffix(".local"), !host.hasSuffix(".localhost"),
              !host.allSatisfy({ $0.isNumber || $0 == "." }),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        components.scheme = "https"
        return components.url ?? url
    }

    /// The URL to publish for a finished upload: an https server's blobs are published as https.
    public static func secureUploadedURL(_ url: URL, serverURL: String) -> URL {
        serverURL.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("https:")
            ? httpsUpgraded(url) : url
    }

    /// Where to fetch `url` from, in order. Cleartext is upgraded first, since ATS would refuse it,
    /// and an IPFS gateway URL falls back to the live gateways. Anything else only has itself.
    public static func retrievalCandidates(for original: URL) -> [URL] {
        let url = httpsUpgraded(original)
        guard let cid = cid(in: url) else { return [url] }
        var candidates = isRetired(url) ? [] : [url]
        for base in bases {
            guard let raw = self.url(forCID: cid, base: base), let candidate = URL(string: raw),
                  !candidates.contains(candidate) else { continue }
            candidates.append(candidate)
        }
        return candidates
    }

    /// Runs `attempt` against each candidate until one succeeds, rethrowing the last failure. The
    /// flag tells the attempt it is the final candidate, with nothing left to fall back to.
    public static func withRetrievalCandidates<T>(
        for url: URL,
        isolation: isolated (any Actor)? = #isolation,
        _ attempt: (URL, Bool) async throws -> T
    ) async throws -> T {
        let candidates = retrievalCandidates(for: url)
        var lastError: Error = URLError(.badURL)
        for (index, candidate) in candidates.enumerated() {
            try Task.checkCancellation()
            do {
                return try await attempt(candidate, index == candidates.count - 1)
            } catch {
                if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
                lastError = error
            }
        }
        throw lastError
    }

    /// The CID of a path-style (`/ipfs/{cid}`) or subdomain-style (`{cid}.ipfs.host`) gateway URL.
    private static func cid(in url: URL) -> String? {
        let parts = url.path.split(separator: "/")
        if parts.count == 2, parts[0] == "ipfs", isPlausibleCID(String(parts[1])) {
            return String(parts[1])
        }
        let labels = url.host?.split(separator: ".") ?? []
        if labels.count > 2, labels[1] == "ipfs", isPlausibleCID(String(labels[0])) {
            return String(labels[0])
        }
        return nil
    }

    private static func isRetired(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        return retiredHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    /// Guards against pasting a path, URL or sentence where a CID belongs. Deliberately shallow --
    /// full multibase validation isn't worth carrying to decide whether to build a URL.
    static func isPlausibleCID(_ value: String) -> Bool {
        guard value.count >= 46 || value.hasPrefix("b") else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber }
    }
}

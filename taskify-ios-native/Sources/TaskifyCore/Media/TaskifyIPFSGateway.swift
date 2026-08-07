import Foundation

/// Builds retrieval URLs for content-addressed uploads.
///
/// Originless returns only a CID and does not serve blobs itself -- `GET {server}/ipfs/{cid}` is
/// not a route on it, in either the current or the pre-refactor layout, so a URL built that way
/// 404s. Its README points at a public gateway instead, which is what this produces.
///
/// Fetching through a public gateway is a metadata trade, not a confidentiality one: Taskify
/// encrypts attachments with the board key before upload, so the gateway only ever handles
/// ciphertext. What it does learn is that some client asked for a particular CID.
public enum TaskifyIPFSGateway {
    /// Recommended by the Originless README. `ipfs.io` resolves the same content if this ever
    /// needs changing -- both were verified serving an uploaded blob.
    public static let defaultBase = "https://dweb.link"

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

    /// Guards against pasting a path, URL or sentence where a CID belongs. Deliberately shallow --
    /// full multibase validation isn't worth carrying to decide whether to build a URL.
    static func isPlausibleCID(_ value: String) -> Bool {
        guard value.count >= 46 || value.hasPrefix("b") else { return false }
        return value.allSatisfy { $0.isLetter || $0.isNumber }
    }
}

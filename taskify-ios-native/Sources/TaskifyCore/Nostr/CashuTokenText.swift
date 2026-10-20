import Foundation

/// Recognizes Cashu ecash in message text without the wallet (C10-5). Chat and notifications only
/// need to know that a message carries a token, and to copy it out; redeeming is the wallet's job.
public enum CashuTokenText {
    private static let tokenTextExpression = try! NSRegularExpression(
        pattern: #"cashu[A-Za-z0-9_+/=-]{10,}"#,
        options: [.caseInsensitive]
    )

    /// Finds a Cashu token embedded in free text, matching the PWA's `extractFirstCashuTokenFromText`
    /// fallback for tokens sent as plain chat text rather than through the formal NUT-18
    /// payment-request/response flow.
    public static func firstTokenSubstring(in text: String) -> String? {
        guard text.range(of: "cashu", options: .caseInsensitive) != nil else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = tokenTextExpression.firstMatch(in: text, range: range),
              let matchRange = Range(match.range, in: text) else { return nil }
        var candidate = String(text[matchRange])
        while let last = candidate.last, ".,!?;:'\"”’)]}>".contains(last) {
            candidate.removeLast()
        }
        return candidate.isEmpty ? nil : candidate
    }

    /// The token carried by a structured `{mint, proofs}` payment payload (a NUT-18 payment or a
    /// Lightning-address forward), or nil for anything else.
    public static func structuredPaymentToken(from content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let mint = dictionary["mint"] as? String,
              !mint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let proofs = dictionary["proofs"] as? [[String: Any]],
              !proofs.isEmpty else {
            return nil
        }
        return tokenString(
            mint: mint,
            proofs: proofs,
            unit: dictionary["unit"] as? String,
            memo: dictionary["memo"] as? String
        )
    }

    /// A V3 `cashuA` token for one mint's proofs.
    public static func tokenString(
        mint: String,
        proofs: [[String: Any]],
        unit: String?,
        memo: String?
    ) -> String? {
        var token: [String: Any] = ["token": [["mint": mint, "proofs": proofs]]]
        if let unit { token["unit"] = unit }
        if let memo { token["memo"] = memo }
        guard JSONSerialization.isValidJSONObject(token),
              let tokenData = try? JSONSerialization.data(
                withJSONObject: token,
                options: [.sortedKeys]
              ) else {
            return nil
        }
        let encoded = tokenData.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "cashuA" + encoded
    }
}

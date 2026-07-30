import Foundation

/// Pay metadata for a Lightning Address, fetched from its `/.well-known/lnurlp/<name>` endpoint.
public struct LnurlPayInfo: Equatable, Sendable {
    public let callback: String
    public let minSendableMsat: UInt64
    public let maxSendableMsat: UInt64
}

/// The BOLT11 invoice an LNURL-pay callback issued, plus the amount it actually covers -- which
/// can differ from the amount requested when the address only supports a single fixed amount.
public struct LnurlPayResolution: Equatable, Sendable {
    public let invoice: String
    public let amountSats: UInt64
}

public enum LnurlPayError: LocalizedError, Equatable {
    case invalidAddress
    case invalidResponse
    case requestFailed(status: Int, message: String?)
    case amountOutOfRange(minSat: UInt64, maxSat: UInt64)
    case metadataIncomplete
    case invoiceMissing

    public var errorDescription: String? {
        switch self {
        case .invalidAddress:
            return "That doesn't look like a lightning address."
        case .invalidResponse:
            return "The lightning address returned an unexpected response."
        case .requestFailed(_, let message):
            return message ?? "The lightning address request failed."
        case .amountOutOfRange(let minSat, let maxSat):
            return "Amount must be between \(minSat) and \(maxSat) sats."
        case .metadataIncomplete:
            return "This lightning address didn't return usable payment metadata."
        case .invoiceMissing:
            return "This lightning address didn't return an invoice."
        }
    }
}

/// Resolves a `name@domain` Lightning Address to a payable BOLT11 invoice via LNURL-pay (LUD-16),
/// matching the PWA's inline resolver in `CashuWalletModal.tsx` (`handlePayInvoice`'s
/// `isLnAddress` branch): fetch pay metadata from `/.well-known/lnurlp/<name>`, then request an
/// invoice for a specific amount from the callback URL it returns. The resolved invoice is fed
/// into the same `prepareLightningPayment` flow used for pasted/scanned BOLT11 invoices, so this
/// client only needs to produce a valid invoice string -- payment itself is unchanged.
public enum LnurlPayClient {
    public static func isLightningAddress(_ raw: String) -> Bool {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.lowercased().hasPrefix("ln") else { return false }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty, parts[1].contains(".") else {
            return false
        }
        return true
    }

    public static func resolveInvoice(
        address: String,
        amountSats: UInt64,
        session: URLSession = .shared
    ) async throws -> LnurlPayResolution {
        guard let infoURL = payInfoURL(for: address) else { throw LnurlPayError.invalidAddress }

        let infoData = try await get(infoURL, session: session)
        let info = try parsePayInfo(from: infoData)
        let amountMsat = try resolvedAmountMsat(info: info, requestedSats: amountSats)

        let invoiceURL = try callbackURL(info: info, amountMsat: amountMsat)
        let invoiceData = try await get(invoiceURL, session: session)
        let invoice = try parseInvoiceResponse(from: invoiceData)

        return LnurlPayResolution(invoice: invoice, amountSats: amountMsat / 1000)
    }

    // MARK: - Pure helpers (unit-testable without network)

    static func payInfoURL(for address: String) -> URL? {
        let value = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = value.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        let name = parts[0].lowercased()
        let domain = parts[1].lowercased()
        guard let nameEncoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            return nil
        }
        let scheme = domain.hasSuffix(".onion") ? "http" : "https"
        return URL(string: "\(scheme)://\(domain)/.well-known/lnurlp/\(nameEncoded)")
    }

    static func parsePayInfo(from data: Data) throws -> LnurlPayInfo {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LnurlPayError.invalidResponse
        }
        guard let callback = json["callback"] as? String, !callback.isEmpty,
              let minSendable = numericValue(json["minSendable"]), minSendable > 0,
              let maxSendable = numericValue(json["maxSendable"]), maxSendable > 0
        else {
            throw LnurlPayError.metadataIncomplete
        }
        return LnurlPayInfo(callback: callback, minSendableMsat: minSendable, maxSendableMsat: maxSendable)
    }

    static func resolvedAmountMsat(info: LnurlPayInfo, requestedSats: UInt64) throws -> UInt64 {
        let amountMsat = info.minSendableMsat == info.maxSendableMsat
            ? info.minSendableMsat
            : requestedSats * 1000
        guard amountMsat >= info.minSendableMsat, amountMsat <= info.maxSendableMsat else {
            throw LnurlPayError.amountOutOfRange(
                minSat: max(info.minSendableMsat / 1000, 1),
                maxSat: info.maxSendableMsat / 1000
            )
        }
        return amountMsat
    }

    static func callbackURL(info: LnurlPayInfo, amountMsat: UInt64) throws -> URL {
        guard var components = URLComponents(string: info.callback) else {
            throw LnurlPayError.invalidResponse
        }
        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "amount", value: String(amountMsat)))
        components.queryItems = queryItems
        guard let url = components.url else { throw LnurlPayError.invalidResponse }
        return url
    }

    static func parseInvoiceResponse(from data: Data) throws -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LnurlPayError.invalidResponse
        }
        if let status = json["status"] as? String, status.caseInsensitiveCompare("ERROR") == .orderedSame {
            throw LnurlPayError.requestFailed(status: 0, message: json["reason"] as? String)
        }
        guard let invoice = json["pr"] as? String, !invoice.isEmpty else {
            throw LnurlPayError.invoiceMissing
        }
        return invoice
    }

    private static func numericValue(_ value: Any?) -> UInt64? {
        if let number = value as? NSNumber { return number.uint64Value }
        if let string = value as? String { return UInt64(string) }
        return nil
    }

    private static func get(_ url: URL, session: URLSession) async throws -> Data {
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw LnurlPayError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw LnurlPayError.requestFailed(status: http.statusCode, message: (message?.isEmpty == false) ? message : nil)
        }
        return data
    }
}

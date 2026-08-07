import Foundation

public enum CoinbasePriceError: LocalizedError, Equatable {
    case invalidResponse
    case requestFailed(status: Int)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "Coinbase returned an unexpected price response."
        case .requestFailed(let status): "Coinbase price request failed (\(status))."
        }
    }
}

/// Matches the PWA's spot-price source (`taskify-pwa/src/lib/pricing.ts` +
/// `taskify-pwa/src/hooks/wallet/useWalletPrice.ts`): a single unauthenticated GET, no API key.
public enum CoinbasePriceClient {
    public static let spotPriceURLString = "https://api.coinbase.com/v2/prices/BTC-USD/spot"

    public static func fetchSpotPriceUSD(session: URLSession = .shared) async throws -> Double {
        guard let url = URL(string: spotPriceURLString) else { throw CoinbasePriceError.invalidResponse }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CoinbasePriceError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoinbasePriceError.requestFailed(status: http.statusCode)
        }
        return try parseSpotPrice(data)
    }

    static func parseSpotPrice(_ data: Data) throws -> Double {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let priceData = json["data"] as? [String: Any],
              let amountString = priceData["amount"] as? String,
              let amount = Double(amountString),
              amount.isFinite, amount > 0 else {
            throw CoinbasePriceError.invalidResponse
        }
        return amount
    }
}

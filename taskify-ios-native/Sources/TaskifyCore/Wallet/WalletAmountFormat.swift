import Foundation

/// Matches the PWA's `walletPrimaryCurrency` setting (`taskify-pwa/src/domains/tasks/settingsTypes.ts`).
public enum WalletPrimaryCurrency: String, Codable, CaseIterable, Sendable {
    case sat
    case usd
}

/// Matches the PWA's `WalletDenominationDisplay` (`taskify-pwa/src/wallet/denomination.ts`).
public enum WalletDenominationDisplay: String, Codable, CaseIterable, Sendable {
    case bitcoinSymbol = "bitcoin-symbol"
    case sat
}

/// A ported subset of the PWA's `formatSatAmount`/`formatUsdAmount`
/// (`taskify-pwa/src/wallet/denomination.ts`, `taskify-pwa/src/hooks/wallet/useAmountFormatters.ts`).
/// Only the shapes the native wallet actually needs are ported: a non-negative sat amount and a
/// USD conversion, both as plain value types with no locale/currency-formatter dependency beyond
/// `Int.formatted()`'s default grouping, which already matches the PWA's `Intl.NumberFormat`
/// grouping behavior closely enough for this app's US-English-oriented copy.
public enum WalletAmountFormat {
    public static let bitcoinSymbol = "₿"
    public static let satsPerBTC: Double = 100_000_000

    /// `amount` is unsigned/assumed non-negative — callers that need a sign prefix (transaction
    /// history's +/-) already prepend it themselves outside this formatter, matching how the
    /// native wallet's existing ad hoc "\(amount.formatted()) sats" call sites are structured
    /// today. Generic over the integer type since sat amounts appear as both `Int` and `UInt64`
    /// (Cashu proof/quote amounts) across the wallet code.
    public static func formatSats<T: BinaryInteger>(_ amount: T, display: WalletDenominationDisplay) -> String {
        let formatted = amount.formatted(IntegerFormatStyle<T>().grouping(.automatic))
        switch display {
        case .bitcoinSymbol:
            return "\(bitcoinSymbol)\(formatted)"
        case .sat:
            // The PWA's helper supports an "auto" sat/sats pluralization mode, but no call site in
            // the shipped app actually opts into it -- the singular "sat" is always used regardless
            // of amount. Matched here for wire-identical copy.
            return "\(formatted) sat"
        }
    }

    public static func usdValue<T: BinaryInteger>(sats amount: T, btcUSDPrice: Double) -> Double {
        (Double(amount) / satsPerBTC) * btcUSDPrice
    }

    /// Mirrors the PWA's `satInputUnitLabel` -- a bare unit label (not tied to a specific amount)
    /// for use next to a live numeric-entry field, where showing the full formatted string isn't
    /// appropriate.
    public static func inputUnitLabel(display: WalletDenominationDisplay) -> String {
        display == .bitcoinSymbol ? bitcoinSymbol : "sats"
    }

    /// Mirrors `Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: N })`
    /// for N=2 (amounts >= $1) or N=6 (amounts < $1, e.g. a single sat's fractional-cent value),
    /// trimmed to the shortest representation with at least 2 decimal places.
    public static func formatUSD(_ amount: Double) -> String {
        guard amount.isFinite else { return "—" }
        guard amount > 0 else { return "$0.00" }
        guard amount < 1 else {
            return "$" + String(format: "%.2f", amount)
        }
        var text = String(format: "%.6f", amount)
        while text.hasSuffix("0") {
            let trimmed = String(text.dropLast())
            guard let decimalIndex = trimmed.firstIndex(of: "."),
                  trimmed.distance(from: trimmed.index(after: decimalIndex), to: trimmed.endIndex) >= 2 else {
                break
            }
            text = trimmed
        }
        return "$" + text
    }
}

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

    /// The inverse, for keypads denominated in dollars. Rounds to the nearest sat rather than
    /// truncating, so entering a round dollar figure doesn't quietly lose a sat to floating point.
    /// Returns nil for a price or amount that can't produce a sendable amount, so callers get one
    /// "no usable amount" answer instead of having to sanity-check the result themselves.
    public static func satsValue(usd amount: Double, btcUSDPrice: Double) -> UInt64? {
        guard amount > 0, btcUSDPrice > 0, amount.isFinite, btcUSDPrice.isFinite else { return nil }
        let sats = ((amount / btcUSDPrice) * satsPerBTC).rounded()
        guard sats >= 1, sats <= Double(UInt64.max) else { return nil }
        return UInt64(sats)
    }

    /// Mirrors the PWA's `satInputUnitLabel` -- a bare unit label (not tied to a specific amount)
    /// for use next to a live numeric-entry field, where showing the full formatted string isn't
    /// appropriate.
    public static func inputUnitLabel(display: WalletDenominationDisplay) -> String {
        display == .bitcoinSymbol ? bitcoinSymbol : "sats"
    }

    /// Rounded to the nearest penny regardless of magnitude -- unlike the PWA, which shows up to 6
    /// fraction digits for sub-$1 amounts (e.g. a single sat's fractional-cent value), this native
    /// build intentionally keeps every USD figure at 2 decimal places for a plainer, less noisy
    /// display.
    public static func formatUSD(_ amount: Double) -> String {
        guard amount.isFinite else { return "—" }
        guard amount > 0 else { return "$0.00" }
        return "$" + String(format: "%.2f", amount)
    }
}

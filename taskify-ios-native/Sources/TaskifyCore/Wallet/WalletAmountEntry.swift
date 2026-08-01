import Foundation

public enum WalletAmountKeypadKey: Equatable, Sendable {
    case digit(Character)
    case decimalPoint
    case backspace
    case clear
}

/// The text-editing rules behind the wallet's amount keypads.
///
/// Pulled out of the keypad view so the constraints on money entry are checkable in isolation: a
/// wrong answer here is a wrong amount on a send screen, and "looks right when I tried it" is a
/// weak guarantee for that.
public enum WalletAmountEntry {
    /// Dollars go to the penny and no further. Sub-penny entry would suggest a precision the
    /// wallet can't honour anyway -- amounts resolve to whole sats before anything is sent.
    public static let maximumFractionDigits = 2

    public static func apply(
        _ key: WalletAmountKeypadKey,
        to text: String,
        allowsDecimal: Bool,
        maxDigits: Int = 12
    ) -> String {
        switch key {
        case .clear:
            return ""

        case .backspace:
            return text.isEmpty ? text : String(text.dropLast())

        case .decimalPoint:
            // One point only, and never in a currency without fractions.
            guard allowsDecimal, !text.contains(".") else { return text }
            return text.isEmpty ? "0." : text + "."

        case .digit(let digit):
            guard digit.isNumber else { return text }
            // A leading zero is a placeholder, not a value: typing 5 into "0" means 5, not 05.
            // "0." is a real prefix though, so it's left alone.
            let base = text == "0" ? "" : text
            let candidate = base + String(digit)

            if allowsDecimal, let dot = candidate.firstIndex(of: ".") {
                let fraction = candidate.distance(from: candidate.index(after: dot), to: candidate.endIndex)
                guard fraction <= maximumFractionDigits else { return text }
            }

            // Count only digits against the length cap so the decimal point can't cost a digit.
            guard candidate.filter(\.isNumber).count <= maxDigits else { return text }
            return candidate
        }
    }
}

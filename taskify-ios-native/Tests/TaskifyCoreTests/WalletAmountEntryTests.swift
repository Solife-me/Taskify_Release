import Foundation
import XCTest
@testable import TaskifyCore

final class WalletAmountEntryTests: XCTestCase {
    private func type(_ keys: String, allowsDecimal: Bool, into start: String = "", maxDigits: Int = 12) -> String {
        keys.reduce(start) { text, character in
            let key: WalletAmountKeypadKey
            switch character {
            case ".": key = .decimalPoint
            case "<": key = .backspace
            case "C": key = .clear
            default: key = .digit(character)
            }
            return WalletAmountEntry.apply(key, to: text, allowsDecimal: allowsDecimal, maxDigits: maxDigits)
        }
    }

    // MARK: - Dollars stop at the penny

    func testDollarEntryAcceptsExactlyTwoDecimalPlaces() {
        XCTAssertEqual(type("12.34", allowsDecimal: true), "12.34")
    }

    func testDollarEntryIgnoresDigitsPastThePenny() {
        XCTAssertEqual(type("12.3456789", allowsDecimal: true), "12.34")
    }

    func testPennyLimitAppliesWhenEntryStartsWithAPoint() {
        XCTAssertEqual(type(".999", allowsDecimal: true), "0.99")
    }

    func testBackspacingPastThePennyLetsTheUserRetype() {
        var text = type("12.34", allowsDecimal: true)
        text = type("<", allowsDecimal: true, into: text)
        XCTAssertEqual(text, "12.3")
        text = type("9", allowsDecimal: true, into: text)
        XCTAssertEqual(text, "12.39")
        // ...and the limit still holds afterwards.
        XCTAssertEqual(type("9", allowsDecimal: true, into: text), "12.39")
    }

    // MARK: - The decimal point itself

    func testOnlyOneDecimalPointIsAccepted() {
        XCTAssertEqual(type("1.2.3", allowsDecimal: true), "1.23")
    }

    func testLeadingDecimalPointBecomesZeroPoint() {
        XCTAssertEqual(type(".5", allowsDecimal: true), "0.5")
    }

    func testSatEntryRefusesADecimalPointEntirely() {
        XCTAssertEqual(type("12.34", allowsDecimal: false), "1234")
    }

    // MARK: - Digits

    func testLeadingZeroIsReplacedRatherThanAppendedTo() {
        XCTAssertEqual(type("05", allowsDecimal: false), "5")
    }

    func testZeroPointIsAPrefixNotAPlaceholder() {
        XCTAssertEqual(type("0.5", allowsDecimal: true), "0.5")
    }

    func testDigitCapCountsDigitsNotCharacters() {
        // The decimal point must not cost the user a digit.
        XCTAssertEqual(type("1234.56", allowsDecimal: true, maxDigits: 6), "1234.56")
        XCTAssertEqual(type("12345.67", allowsDecimal: true, maxDigits: 6), "12345.6")
    }

    // MARK: - Clear and backspace

    func testClearEmptiesTheEntry() {
        XCTAssertEqual(type("123C", allowsDecimal: false), "")
    }

    func testBackspaceOnEmptyEntryIsHarmless() {
        XCTAssertEqual(type("<", allowsDecimal: false), "")
    }

    func testBackspaceRemovesTheDecimalPoint() {
        XCTAssertEqual(type("1.<", allowsDecimal: true), "1")
    }
}

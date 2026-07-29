import Foundation
import XCTest
@testable import TaskifyCore

final class WalletAmountFormatTests: XCTestCase {
    func testFormatSatsWithBitcoinSymbol() {
        XCTAssertEqual(WalletAmountFormat.formatSats(1, display: .bitcoinSymbol), "₿1")
        XCTAssertEqual(WalletAmountFormat.formatSats(21, display: .bitcoinSymbol), "₿21")
        XCTAssertEqual(WalletAmountFormat.formatSats(100_000, display: .bitcoinSymbol), "₿100,000")
    }

    func testFormatSatsWithSatLabelAlwaysUsesSingularUnit() {
        // Matches the PWA: no shipped call site opts into "auto" pluralization, so "sat" is used
        // regardless of amount, even for 21 or 100,000.
        XCTAssertEqual(WalletAmountFormat.formatSats(1, display: .sat), "1 sat")
        XCTAssertEqual(WalletAmountFormat.formatSats(21, display: .sat), "21 sat")
        XCTAssertEqual(WalletAmountFormat.formatSats(100_000, display: .sat), "100,000 sat")
    }

    func testFormatSatsAcceptsUInt64WalletAmounts() {
        let amount: UInt64 = 100_000
        XCTAssertEqual(WalletAmountFormat.formatSats(amount, display: .bitcoinSymbol), "₿100,000")
    }

    func testUsdValueConvertsSatsAtGivenSpotPrice() {
        XCTAssertEqual(WalletAmountFormat.usdValue(sats: 100_000, btcUSDPrice: 65_000), 65.0, accuracy: 0.0001)
        XCTAssertEqual(WalletAmountFormat.usdValue(sats: 1, btcUSDPrice: 65_000), 0.00065, accuracy: 0.0000001)
    }

    func testFormatUSDForAmountsOverOneDollarUsesTwoDecimals() {
        XCTAssertEqual(WalletAmountFormat.formatUSD(65.0), "$65.00")
        XCTAssertEqual(WalletAmountFormat.formatUSD(1.239), "$1.24")
    }

    func testFormatUSDForSubDollarAmountsRoundsToTheNearestPenny() {
        // Unlike the PWA, which shows up to 6 fraction digits for sub-$1 amounts, this native
        // build always rounds to 2 decimal places -- including down to $0.00 for a fraction of a
        // cent, since there's no coarser display to fall back to.
        XCTAssertEqual(WalletAmountFormat.formatUSD(0.00065), "$0.00")
        XCTAssertEqual(WalletAmountFormat.formatUSD(0.1), "$0.10")
        XCTAssertEqual(WalletAmountFormat.formatUSD(0.006), "$0.01")
        XCTAssertEqual(WalletAmountFormat.formatUSD(0.004), "$0.00")
    }

    func testFormatUSDHandlesZeroAndNonFinite() {
        XCTAssertEqual(WalletAmountFormat.formatUSD(0), "$0.00")
        XCTAssertEqual(WalletAmountFormat.formatUSD(-5), "$0.00")
        XCTAssertEqual(WalletAmountFormat.formatUSD(.nan), "—")
        XCTAssertEqual(WalletAmountFormat.formatUSD(.infinity), "—")
    }
}

final class CoinbasePriceClientTests: XCTestCase {
    func testParseSpotPriceReadsDataAmount() throws {
        let data = Data(#"{"data":{"base":"BTC","currency":"USD","amount":"65432.10"}}"#.utf8)
        XCTAssertEqual(try CoinbasePriceClient.parseSpotPrice(data), 65_432.10, accuracy: 0.001)
    }

    func testParseSpotPriceRejectsInvalidPayloads() {
        XCTAssertThrowsError(try CoinbasePriceClient.parseSpotPrice(Data("{}".utf8)))
        XCTAssertThrowsError(try CoinbasePriceClient.parseSpotPrice(Data(#"{"data":{"amount":"not-a-number"}}"#.utf8)))
        XCTAssertThrowsError(try CoinbasePriceClient.parseSpotPrice(Data(#"{"data":{"amount":"-5"}}"#.utf8)))
        XCTAssertThrowsError(try CoinbasePriceClient.parseSpotPrice(Data(#"{"data":{"amount":"0"}}"#.utf8)))
    }
}

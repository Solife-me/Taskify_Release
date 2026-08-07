import Foundation
import XCTest
@testable import TaskifyCore

final class LnurlPayClientTests: XCTestCase {
    func testIsLightningAddressAcceptsNameAtDomain() {
        XCTAssertTrue(LnurlPayClient.isLightningAddress("alice@getalby.com"))
        XCTAssertTrue(LnurlPayClient.isLightningAddress("  bob@solife.me  "))
    }

    func testIsLightningAddressRejectsInvoicesAndGarbage() {
        XCTAssertFalse(LnurlPayClient.isLightningAddress("lnbc1p0..."))
        XCTAssertFalse(LnurlPayClient.isLightningAddress(""))
        XCTAssertFalse(LnurlPayClient.isLightningAddress("noatsign"))
        XCTAssertFalse(LnurlPayClient.isLightningAddress("a@b"))
        XCTAssertFalse(LnurlPayClient.isLightningAddress("@domain.com"))
        XCTAssertFalse(LnurlPayClient.isLightningAddress("name@"))
    }

    func testPayInfoURLBuildsWellKnownLnurlpEndpoint() {
        let url = LnurlPayClient.payInfoURL(for: "Alice@GetAlby.com")
        XCTAssertEqual(url?.absoluteString, "https://getalby.com/.well-known/lnurlp/alice")
    }

    func testPayInfoURLUsesHttpForOnionDomains() {
        let url = LnurlPayClient.payInfoURL(for: "alice@example.onion")
        XCTAssertEqual(url?.absoluteString, "http://example.onion/.well-known/lnurlp/alice")
    }

    func testPayInfoURLRejectsMalformedAddress() {
        XCTAssertNil(LnurlPayClient.payInfoURL(for: "noatsign"))
        XCTAssertNil(LnurlPayClient.payInfoURL(for: "@domain.com"))
    }

    func testParsePayInfoExtractsCallbackAndBounds() throws {
        let data = Data(#"{"callback":"https://x.com/cb","minSendable":1000,"maxSendable":5000000}"#.utf8)
        let info = try LnurlPayClient.parsePayInfo(from: data)
        XCTAssertEqual(info.callback, "https://x.com/cb")
        XCTAssertEqual(info.minSendableMsat, 1000)
        XCTAssertEqual(info.maxSendableMsat, 5_000_000)
    }

    func testParsePayInfoThrowsOnIncompleteMetadata() {
        XCTAssertThrowsError(try LnurlPayClient.parsePayInfo(from: Data(#"{"callback":"https://x.com/cb"}"#.utf8)))
        XCTAssertThrowsError(try LnurlPayClient.parsePayInfo(from: Data("not json".utf8)))
    }

    func testResolvedAmountUsesFixedAmountWhenRangeIsSinglePoint() throws {
        let info = LnurlPayInfo(callback: "https://x.com/cb", minSendableMsat: 21_000, maxSendableMsat: 21_000)
        let amount = try LnurlPayClient.resolvedAmountMsat(info: info, requestedSats: 5)
        XCTAssertEqual(amount, 21_000)
    }

    func testResolvedAmountUsesRequestedSatsWithinRange() throws {
        let info = LnurlPayInfo(callback: "https://x.com/cb", minSendableMsat: 1000, maxSendableMsat: 1_000_000)
        let amount = try LnurlPayClient.resolvedAmountMsat(info: info, requestedSats: 100)
        XCTAssertEqual(amount, 100_000)
    }

    func testResolvedAmountThrowsWhenOutOfRange() {
        let info = LnurlPayInfo(callback: "https://x.com/cb", minSendableMsat: 100_000, maxSendableMsat: 200_000)
        XCTAssertThrowsError(try LnurlPayClient.resolvedAmountMsat(info: info, requestedSats: 1)) { error in
            guard case LnurlPayError.amountOutOfRange(let min, let max) = error else {
                return XCTFail("expected amountOutOfRange, got \(error)")
            }
            XCTAssertEqual(min, 100)
            XCTAssertEqual(max, 200)
        }
    }

    func testCallbackURLAppendsAmountQueryItem() throws {
        let info = LnurlPayInfo(callback: "https://x.com/cb?foo=bar", minSendableMsat: 1000, maxSendableMsat: 1000)
        let url = try LnurlPayClient.callbackURL(info: info, amountMsat: 1000)
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        XCTAssertEqual(components?.queryItems?.first { $0.name == "amount" }?.value, "1000")
        XCTAssertEqual(components?.queryItems?.first { $0.name == "foo" }?.value, "bar")
    }

    func testParseInvoiceResponseExtractsPr() throws {
        let data = Data(#"{"pr":"lnbc1..."}"#.utf8)
        XCTAssertEqual(try LnurlPayClient.parseInvoiceResponse(from: data), "lnbc1...")
    }

    func testParseInvoiceResponseThrowsOnErrorStatus() {
        let data = Data(#"{"status":"ERROR","reason":"nope"}"#.utf8)
        XCTAssertThrowsError(try LnurlPayClient.parseInvoiceResponse(from: data)) { error in
            guard case LnurlPayError.requestFailed(_, let message) = error else {
                return XCTFail("expected requestFailed, got \(error)")
            }
            XCTAssertEqual(message, "nope")
        }
    }

    func testParseInvoiceResponseThrowsWhenPrMissing() {
        XCTAssertThrowsError(try LnurlPayClient.parseInvoiceResponse(from: Data("{}".utf8)))
    }
}

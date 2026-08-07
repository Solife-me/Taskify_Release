import Foundation
import XCTest
@testable import TaskifyCore

final class WalletContactPaymentTests: XCTestCase {
    private let npub = "npub1exampleexampleexampleexampleexampleexampleexampleexam"

    // MARK: - Lightning address

    func testUsesTheContactsOwnLightningAddressWhenTheyHaveOne() {
        XCTAssertEqual(
            WalletContactPayment.lightningAddress(lud16: "alice@getalby.com", npub: npub),
            "alice@getalby.com"
        )
    }

    func testFallsBackToNpubAtSolifeWhenTheProfileHasNoAddress() {
        XCTAssertEqual(
            WalletContactPayment.lightningAddress(lud16: nil, npub: npub),
            "\(npub)@solife.me"
        )
    }

    /// A profile field can hold anything; anything unusable falls back rather than being sent to
    /// LNURL resolution to fail there.
    func testFallsBackWhenTheStoredAddressIsUnusable() {
        for junk in ["", "   ", "not-an-address", "@getalby.com", "alice@", "alice@localhost"] {
            XCTAssertEqual(
                WalletContactPayment.lightningAddress(lud16: junk, npub: npub),
                "\(npub)@solife.me",
                "expected fallback for \(junk.isEmpty ? "<empty>" : junk)"
            )
        }
    }

    /// A BOLT11 invoice pasted into the lud16 field isn't a reusable address.
    func testFallsBackWhenTheStoredAddressIsAnInvoice() {
        XCTAssertEqual(
            WalletContactPayment.lightningAddress(lud16: "lnbc1p0abc@x.com", npub: npub),
            "\(npub)@solife.me"
        )
    }

    func testTrimsSurroundingWhitespaceFromAStoredAddress() {
        XCTAssertEqual(
            WalletContactPayment.lightningAddress(lud16: "  bob@solife.me  ", npub: npub),
            "bob@solife.me"
        )
    }

    // MARK: - Ecash direct message

    /// Pinned to the PWA's exact wording: a token sent from either app must read the same in the
    /// recipient's client.
    func testEcashDirectMessageMatchesThePWAWording() {
        let body = WalletContactPayment.ecashDirectMessage(
            senderNpub: "npub1sender",
            formattedAmount: "₿1,234",
            token: "cashuAtoken"
        )
        XCTAssertEqual(body, "nostr:npub1sender sent you ₿1,234 from Taskify wallet!\ncashuAtoken")
    }

    /// The token has to survive on its own line so clients and humans can pick it out.
    func testTokenIsOnItsOwnFinalLine() {
        let body = WalletContactPayment.ecashDirectMessage(
            senderNpub: "npub1sender",
            formattedAmount: "21 sat",
            token: "cashuBtoken"
        )
        XCTAssertEqual(body.split(separator: "\n").count, 2)
        XCTAssertEqual(body.split(separator: "\n").last.map(String.init), "cashuBtoken")
    }
}

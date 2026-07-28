import Foundation
import XCTest
@testable import TaskifyCore

final class SolifeClientTests: XCTestCase {
    func testAddressIsDerivedFromNpubWithNoNetworkCall() {
        XCTAssertEqual(SolifeClient.address(npub: "npub1example"), "npub1example@solife.me")
    }

    func testParseConfigFallsBackToDefaultsForMissingFields() throws {
        let full = try SolifeClient.parseConfig(Data(#"""
        {"domain":"solife.me","mintUrl":"https://mint.solife.me","customAddressPriceSats":1000,"authKind":27235}
        """#.utf8))
        XCTAssertEqual(full.domain, "solife.me")
        XCTAssertEqual(full.mintUrl, "https://mint.solife.me")
        XCTAssertEqual(full.customAddressPriceSats, 1000)
        XCTAssertEqual(full.authKind, 27_235)

        let sparse = try SolifeClient.parseConfig(Data("{}".utf8))
        XCTAssertEqual(sparse.domain, "solife.me")
        XCTAssertEqual(sparse.mintUrl, "")
        XCTAssertEqual(sparse.customAddressPriceSats, 0)
        XCTAssertEqual(sparse.authKind, 27_235)
    }

    func testParseAvailability() throws {
        let available = try SolifeClient.parseAvailability(Data(#"""
        {"available":true,"handle":"nathan","address":"nathan@solife.me","priceSats":1000}
        """#.utf8))
        XCTAssertTrue(available.available)
        XCTAssertEqual(available.handle, "nathan")
        XCTAssertEqual(available.priceSats, 1000)
        XCTAssertNil(available.reason)

        let taken = try SolifeClient.parseAvailability(Data(#"""
        {"available":false,"handle":"nathan","address":"nathan@solife.me","priceSats":1000,"reason":"taken"}
        """#.utf8))
        XCTAssertFalse(taken.available)
        XCTAssertEqual(taken.reason, "taken")
    }

    func testParseAddressFallsBackToProvidedMintWhenOmitted() throws {
        let overridden = try SolifeClient.parseAddress(Data(#"""
        {"handle":"nathan","address":"nathan@solife.me","mintUrl":"https://mint.example","mintOverride":true}
        """#.utf8), fallbackMintURL: "https://mint.solife.me")
        XCTAssertEqual(overridden.mintUrl, "https://mint.example")
        XCTAssertTrue(overridden.mintOverride)

        let usingDefault = try SolifeClient.parseAddress(Data(#"""
        {"handle":"nathan","address":"nathan@solife.me"}
        """#.utf8), fallbackMintURL: "https://mint.solife.me")
        XCTAssertEqual(usingDefault.mintUrl, "https://mint.solife.me")
        XCTAssertFalse(usingDefault.mintOverride)
    }

    func testParsePurchaseNormalizesAddressCase() throws {
        let purchase = try SolifeClient.parsePurchase(Data(#"""
        {"purchaseId":"p1","address":"Nathan@Solife.me","priceSats":1000,"bolt11":"lnbc1...","status":"invoice_issued"}
        """#.utf8))
        XCTAssertEqual(purchase.purchaseID, "p1")
        XCTAssertEqual(purchase.address, "nathan@solife.me")
        XCTAssertFalse(purchase.isSettled)

        let settled = try SolifeClient.parsePurchase(Data(#"""
        {"purchaseId":"p1","address":"nathan@solife.me","priceSats":1000,"bolt11":"","status":"address_claimed"}
        """#.utf8))
        XCTAssertTrue(settled.isSettled)
    }

    func testParseClaimDistinguishesPurchaseFromDirectAddress() throws {
        let purchaseClaim = try SolifeClient.parseClaim(Data(#"""
        {"purchaseId":"p1","address":"nathan@solife.me","priceSats":1000,"bolt11":"lnbc1...","status":"invoice_issued"}
        """#.utf8))
        guard case .purchase(let purchase) = purchaseClaim else {
            return XCTFail("Expected a purchase claim")
        }
        XCTAssertEqual(purchase.purchaseID, "p1")

        let addressClaim = try SolifeClient.parseClaim(Data(#"""
        {"handle":"nathan","address":"nathan@solife.me","mintUrl":"https://mint.solife.me"}
        """#.utf8))
        guard case .address(let address) = addressClaim else {
            return XCTFail("Expected a direct address claim")
        }
        XCTAssertEqual(address.handle, "nathan")
    }

    func testParseAccountCollectsAddressesAndPurchasesWithMintFallback() throws {
        let account = try SolifeClient.parseAccount(Data(#"""
        {
          "npub": "npub1example",
          "lightningAddress": "npub1example@solife.me",
          "lightningAddressMintOverride": false,
          "addresses": [
            {"handle": "nathan", "address": "nathan@solife.me"}
          ],
          "addressPurchases": [
            {"purchaseId": "p1", "address": "nathan@solife.me", "priceSats": 1000, "bolt11": "lnbc1...", "status": "address_claimed"}
          ]
        }
        """#.utf8), fallbackMintURL: "https://mint.solife.me")

        XCTAssertEqual(account.npub, "npub1example")
        XCTAssertEqual(account.lightningAddressMintUrl, "https://mint.solife.me")
        XCTAssertEqual(account.addresses.first?.mintUrl, "https://mint.solife.me")
        XCTAssertEqual(account.addressPurchases.first?.purchaseID, "p1")
    }

    func testCreateSessionSignsAValidChallengeEventWhenAuthMocked() throws {
        // createSession itself requires live network access (challenge + verify round trip), so
        // this only exercises the parts that are pure: building the event the PWA's server
        // expects to verify. Full request/response wiring is covered by manual/integration testing.
        let identity = try NostrIdentity(privateKey: Data(hex: String(repeating: "0", count: 63) + "1"))
        let config = SolifeConfig(domain: "solife.me", mintUrl: "https://mint.solife.me", customAddressPriceSats: 1000, authKind: 27_235)
        let event = try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: config.authKind,
            tags: [["challenge", "abc123"], ["domain", config.domain]],
            content: "Sign in to solife.me: abc123"
        )
        XCTAssertEqual(event.kind, 27_235)
        XCTAssertTrue(event.tags.contains(["challenge", "abc123"]))
        XCTAssertTrue(event.tags.contains(["domain", "solife.me"]))
        XCTAssertTrue(event.verify())
    }
}

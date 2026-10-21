import XCTest
@testable import TaskifyWallet

final class WalletMoveOutContentTests: XCTestCase {
    func testMoveOutRoutesContainNoIncomingActions() {
        let routes = WalletMoveOutContent.routes(
            balanceSats: 0,
            hasNWCWallet: false,
            usesNpubCashProvider: false
        )

        XCTAssertFalse(routes.contains { $0.id == .receive })
        XCTAssertEqual(routes.map(\.id), [.payLightning, .makeEcashToken, .showRecoveryWords])
    }

    func testBalanceRoutesRequireFundsAndWordsRemainAvailable() {
        let empty = WalletMoveOutContent.routes(
            balanceSats: 0,
            hasNWCWallet: false,
            usesNpubCashProvider: false
        )
        let funded = WalletMoveOutContent.routes(
            balanceSats: 123,
            hasNWCWallet: false,
            usesNpubCashProvider: false
        )

        XCTAssertFalse(empty[0].isEnabled)
        XCTAssertFalse(empty[1].isEnabled)
        XCTAssertTrue(empty[2].isEnabled)
        XCTAssertTrue(funded[0].isEnabled)
        XCTAssertTrue(funded[1].isEnabled)
        XCTAssertTrue(funded[2].isEnabled)
    }

    func testConnectedNWCAndNpubCashAddTheirMoveOutRoutes() {
        let routes = WalletMoveOutContent.routes(
            balanceSats: 123,
            hasNWCWallet: true,
            usesNpubCashProvider: true,
            claimMessage: "Claimed 1 payment."
        )

        XCTAssertEqual(
            routes.map(\.id),
            [.payLightning, .makeEcashToken, .moveToNWC, .claimNpubCash, .showRecoveryWords]
        )
        XCTAssertEqual(routes[2].title, "Move to your NWC wallet")
        XCTAssertEqual(routes[3].detail, "Claimed 1 payment.")
        XCTAssertTrue(routes[3].isEnabled)
    }

    func testMoveOutCopyMatchesTheWithdrawOnlySurface() throws {
        XCTAssertEqual(
            WalletMoveOutContent.intro,
            "The wallet no longer takes in new funds, and it closes on \(TaskifyWalletPhaseOut.removalDateText). Move what is left to a wallet you keep."
        )
        XCTAssertEqual(WalletMoveOutContent.balanceText(formattedBalance: "123 sat", hasFunds: true), "123 sat to move")
        XCTAssertEqual(WalletMoveOutContent.balanceText(formattedBalance: "0 sat", hasFunds: false), "Nothing left to move.")

        let pay = try XCTUnwrap(WalletMoveOutContent.routes(balanceSats: 1, hasNWCWallet: false, usesNpubCashProvider: false).first)
        XCTAssertEqual(pay.title, "Pay an invoice or Lightning address")
        XCTAssertEqual(pay.detail, "From your own wallet's receive screen.")
        XCTAssertEqual(WalletMoveOutContent.sectionTitle(for: .lightning), "To a Lightning wallet")
    }
}

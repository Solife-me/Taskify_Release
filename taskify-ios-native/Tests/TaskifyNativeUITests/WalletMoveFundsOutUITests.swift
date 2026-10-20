import XCTest

/// C9-1: the Taskify wallet is withdraw-only. It offers ways out (Lightning, ecash, NWC, the 12
/// words) and the closing date, and nothing that takes funds in.
final class WalletMoveFundsOutUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testTheWalletOffersOnlyWaysOut() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_WALLET"] = "enabled"
        app.launch()

        let walletTab = app.buttons["Wallet"].firstMatch
        XCTAssertTrue(walletTab.waitForExistence(timeout: 10))
        walletTab.tap()

        let moveOut = app.buttons["Move funds out"]
        XCTAssertTrue(moveOut.waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["Receive"].exists, "no way in")
        XCTAssertFalse(app.buttons["Scan a Cashu token"].exists)
        attach(app, name: "wallet-01-home")

        moveOut.tap()
        let closing = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "closes on December 1, 2026")).firstMatch
        XCTAssertTrue(closing.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pay an invoice or Lightning address")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Make an ecash token")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Show the 12 words")).firstMatch.exists)
        attach(app, name: "wallet-02-move-funds-out")
        app.buttons["Done"].firstMatch.tap()

        // The wallet's own Settings button, not the tab bar's.
        let settingsButtons = app.buttons.matching(NSPredicate(format: "label == %@", "Settings")).allElementsBoundByIndex
        try XCTUnwrap(settingsButtons.first { $0.frame.minY < app.frame.height / 2 }).tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Move to NWC Wallet")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Lightning Address")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Recipient Keys")).firstMatch.exists)
        attach(app, name: "wallet-03-settings")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try? FileManager.default.createDirectory(atPath: "/tmp/taskify_screens", withIntermediateDirectories: true)
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/taskify_screens/\(name).png"))
    }
}

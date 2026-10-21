import XCTest

final class TaskifyMacUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testIsolatedHostOpensFixtureTaskFromInjectedDeepLink() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--taskify-ui-test-session", UUID().uuidString,
            "--taskify-ui-test-open-url",
            "taskify://task?id=ui-test-deep-link-task&board=ui-test-board",
        ]
        app.launch()

        XCTAssertTrue(app.staticTexts["UI Test Board"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Open this task from a deep link"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["TASK DETAILS"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Edit Task…"].exists)
        XCTAssertFalse(app.staticTexts["Welcome to Taskify"].exists)
    }

    func testWalletRemovalPreviewShowsRecoveryWithoutReceive() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--taskify-ui-test-session", UUID().uuidString,
            "--taskify-ui-test-wallet-recovery",
        ]
        app.launch()

        let wallet = app.staticTexts["Wallet"]
        XCTAssertTrue(wallet.waitForExistence(timeout: 10))
        wallet.click()

        XCTAssertTrue(app.staticTexts["Recover your wallet"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Receive"].exists)
    }
}

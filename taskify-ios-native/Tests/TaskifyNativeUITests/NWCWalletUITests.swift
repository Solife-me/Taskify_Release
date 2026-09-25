import XCTest

/// Drives NWC wallet mode against a local test harness: a Nostr relay with a fake NIP-47
/// wallet, backed by nutshell FakeWallet mints. Skipped unless the harness is described by
///   TEST_RUNNER_NWC_URI      nostr+walletconnect:// connection with pay + receive rights
///   TEST_RUNNER_NWC_MINT_URL mint used to create an invoice for the wallet to pay
final class NWCWalletUITests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipIf(env["NWC_URI"] == nil || env["NWC_MINT_URL"] == nil, "NWC test harness not configured")
    }

    func testConnectSwitchReceiveSendAndSwitchBack() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        let walletTab = app.buttons["Wallet"].firstMatch
        XCTAssertTrue(walletTab.waitForExistence(timeout: 10))
        walletTab.tap()

        // Connect the NWC wallet.
        let modeButton = app.buttons["wallet-mode-button"]
        XCTAssertTrue(modeButton.waitForExistence(timeout: 30))
        modeButton.tap()
        let field = app.descendants(matching: .any)["nwc-connection-field"]
        // Keychain items survive uninstalling the app, so a previous run's connection may remain.
        if !field.waitForExistence(timeout: 5) {
            let disconnect = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Disconnect'")).firstMatch
            XCTAssertTrue(disconnect.waitForExistence(timeout: 5))
            disconnect.tap()
            if !field.waitForExistence(timeout: 5) {
                app.buttons["Done"].firstMatch.tap()
                modeButton.tap()
            }
        }
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(env["NWC_URI"]!)
        app.buttons["Connect"].tap()

        // A fresh install has no ecash, so switching is a single step.
        let use = app.buttons["Use Fake NWC"]
        XCTAssertTrue(use.waitForExistence(timeout: 30), "wallet didn't connect")
        attach(app, "nwc-switch")
        use.tap()

        XCTAssertTrue(app.buttons["wallet-mode-button"].staticTexts["Fake NWC"].waitForExistence(timeout: 10)
            || app.buttons["Fake NWC"].waitForExistence(timeout: 10))
        // The balance card reports the NWC wallet's balance, not the (empty) ecash wallet's.
        let balance = app.descendants(matching: .any)["wallet-balance"]
        XCTAssertTrue(balance.waitForExistence(timeout: 10))
        let nonZero = NSPredicate(format: "label BEGINSWITH 'Fake NWC balance, ' AND NOT label ENDSWITH ', 0 sats'")
        expectation(for: nonZero, evaluatedWith: balance)
        waitForExpectations(timeout: 20)
        attach(app, "nwc-home")

        // Receive 21 sats: the fake wallet settles the invoice on its own.
        app.buttons["Receive"].tap()
        XCTAssertTrue(app.staticTexts["fakewallet@example.com"].waitForExistence(timeout: 10))
        app.buttons["Create invoice"].firstMatch.tap()
        for digit in ["2", "1"] { app.buttons[digit].tap() }
        app.buttons["Create invoice"].firstMatch.tap()
        let received = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Received' AND label CONTAINS '21'")).firstMatch
        XCTAssertTrue(received.waitForExistence(timeout: 45), "invoice never settled")
        attach(app, "nwc-received")
        app.buttons["Done"].firstMatch.tap()

        // Pay a real mint invoice through the NWC wallet.
        let invoice = try createInvoice(amount: 50)
        app.buttons["Send"].tap()
        let destination = app.descendants(matching: .any)["nwc-send-destination"]
        XCTAssertTrue(destination.waitForExistence(timeout: 10))
        destination.tap()
        destination.typeText(invoice)
        app.buttons["Review payment"].tap()
        let pay = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Pay ' AND label CONTAINS '50'")).firstMatch
        XCTAssertTrue(pay.waitForExistence(timeout: 10))
        attach(app, "nwc-confirm")
        pay.tap()
        XCTAssertTrue(app.staticTexts["Payment sent"].waitForExistence(timeout: 45))
        attach(app, "nwc-paid")
        app.buttons["Done"].firstMatch.tap()

        // History comes from the wallet; this fake doesn't implement list_transactions.
        app.buttons["Wallet history"].tap()
        XCTAssertTrue(app.navigationBars["Fake NWC history"].waitForExistence(timeout: 10))
        app.buttons["Done"].firstMatch.tap()

        // Switch back to the ecash wallet.
        app.buttons["wallet-mode-button"].tap()
        let back = app.buttons["Switch back to ecash wallet"]
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        back.tap()
        XCTAssertTrue(app.buttons["Mints"].waitForExistence(timeout: 10))
        attach(app, "ecash-again")
    }

    private func createInvoice(amount: Int) throws -> String {
        var request = URLRequest(url: URL(string: "\(env["NWC_MINT_URL"]!)/v1/mint/quote/bolt11")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["amount": amount, "unit": "sat"])
        var result: String?
        let done = expectation(description: "invoice")
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                result = body["request"] as? String
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try XCTUnwrap(result)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

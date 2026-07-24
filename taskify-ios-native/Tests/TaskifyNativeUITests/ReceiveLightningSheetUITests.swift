import XCTest

final class ReceiveLightningSheetUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testReceiveLightningKeypadSheet() throws {
        let app = XCUIApplication()
        app.launch()

        let walletTab = app.buttons["Wallet"]
        XCTAssertTrue(walletTab.waitForExistence(timeout: 10))
        walletTab.tap()

        let addMintButton = app.buttons["Add Taskify mint"]
        if addMintButton.waitForExistence(timeout: 5) {
            addMintButton.tap()
        }

        let receiveButton = app.buttons["Receive"]
        XCTAssertTrue(receiveButton.waitForExistence(timeout: 30))
        receiveButton.tap()

        let lightningInvoiceButton = app.buttons["Lightning invoice"].firstMatch
        XCTAssertTrue(lightningInvoiceButton.waitForExistence(timeout: 10))
        lightningInvoiceButton.tap()

        // Sheet should appear with the custom keypad.
        XCTAssertTrue(app.staticTexts["RECEIVE TO"].waitForExistence(timeout: 10))
        attach(app, name: "receive-lightning-amount-empty")

        for digit in ["1", "2", "3"] {
            let key = app.buttons[digit]
            if key.waitForExistence(timeout: 5) {
                key.tap()
            }
        }
        attach(app, name: "receive-lightning-amount-typed")
    }

    func testEcashPaymentRequestKeypadSheet() throws {
        let app = XCUIApplication()
        app.launch()

        let walletTab = app.buttons["Wallet"]
        XCTAssertTrue(walletTab.waitForExistence(timeout: 10))
        walletTab.tap()

        let addMintButton = app.buttons["Add Taskify mint"]
        if addMintButton.waitForExistence(timeout: 5) {
            addMintButton.tap()
        }

        let receiveButton = app.buttons["Receive"]
        XCTAssertTrue(receiveButton.waitForExistence(timeout: 30))
        receiveButton.tap()

        let requestButton = app.buttons["Cashu payment request"].firstMatch
        XCTAssertTrue(requestButton.waitForExistence(timeout: 10))
        requestButton.tap()

        XCTAssertTrue(app.staticTexts["RECEIVE TO"].waitForExistence(timeout: 10))
        attach(app, name: "ecash-request-amount")

        for digit in ["5", "0"] {
            let key = app.buttons[digit]
            if key.waitForExistence(timeout: 5) {
                key.tap()
            }
        }
        attach(app, name: "ecash-request-amount-typed")
    }

    func testEcashSendKeypadSheet() throws {
        let app = XCUIApplication()
        app.launch()

        let walletTab = app.buttons["Wallet"]
        XCTAssertTrue(walletTab.waitForExistence(timeout: 10))
        walletTab.tap()

        let addMintButton = app.buttons["Add Taskify mint"]
        if addMintButton.waitForExistence(timeout: 5) {
            addMintButton.tap()
        }

        let sendButton = app.buttons["Send"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 30))
        guard sendButton.isEnabled else {
            throw XCTSkip("Send requires a funded wallet balance; not fundable in this environment.")
        }
        sendButton.tap()

        let createTokenButton = app.buttons["Create Cashu token"].firstMatch
        XCTAssertTrue(createTokenButton.waitForExistence(timeout: 10))
        createTokenButton.tap()

        XCTAssertTrue(app.staticTexts["SEND FROM"].waitForExistence(timeout: 10))
        attach(app, name: "ecash-send-amount")

        for digit in ["4", "2"] {
            let key = app.buttons[digit]
            if key.waitForExistence(timeout: 5) {
                key.tap()
            }
        }
        attach(app, name: "ecash-send-amount-typed")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        let data = screenshot.pngRepresentation
        let path = "/tmp/\(name).png"
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

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

    func testLiveWalletShowsWithdrawOnlyRoutesWithoutReceive() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--taskify-ui-test-session", UUID().uuidString,
            "--taskify-ui-test-wallet-enabled",
        ]
        app.launch()

        let wallet = app.staticTexts["Wallet"]
        XCTAssertTrue(wallet.waitForExistence(timeout: 10))
        wallet.click()

        XCTAssertTrue(app.staticTexts["Move funds out"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Pay an invoice or Lightning address"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Make an ecash token"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Receive"].exists)
    }

    func testCreateEditCompleteAndReopenTaskThroughDeepLink() {
        let sessionID = UUID().uuidString
        let initialTitle = "Task \(UUID().uuidString.prefix(6))"
        let editedTitle = "Edited \(initialTitle)"
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", sessionID]
        app.launch()

        let board = app.staticTexts["UI Test Board"]
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        board.click()

        let newTask = app.buttons["new-task-button"]
        XCTAssertTrue(newTask.waitForExistence(timeout: 5))
        newTask.click()

        let titleField = app.textFields["task-title-field"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.click()
        titleField.typeText(initialTitle)
        app.buttons["save-task-button"].click()

        let createdTitle = app.staticTexts[initialTitle].firstMatch
        XCTAssertTrue(createdTitle.waitForExistence(timeout: 5))
        createdTitle.click()

        let editTask = app.buttons["edit-task-button"]
        XCTAssertTrue(editTask.waitForExistence(timeout: 5))
        editTask.click()

        let editField = app.textFields["task-title-field"]
        XCTAssertTrue(editField.waitForExistence(timeout: 5))
        editField.click()
        editField.typeKey("a", modifierFlags: .command)
        editField.typeText(editedTitle)
        app.buttons["save-task-button"].click()

        let editedTitleElement = app.staticTexts[editedTitle].firstMatch
        XCTAssertTrue(editedTitleElement.waitForExistence(timeout: 5))
        let taskID = editedTitleElement.identifier
        XCTAssertFalse(taskID.isEmpty)
        editedTitleElement.click()

        let complete = app.buttons["complete-task-button"]
        XCTAssertTrue(complete.waitForExistence(timeout: 5))
        complete.click()

        app.terminate()
        let relaunched = XCUIApplication()
        relaunched.launchArguments = [
            "--taskify-ui-test-session", sessionID,
            "--taskify-ui-test-preserve-store",
            "--taskify-ui-test-open-url",
            "taskify://task?id=\(taskID)&board=ui-test-board",
        ]
        relaunched.launch()

        XCTAssertTrue(relaunched.staticTexts[editedTitle].firstMatch.waitForExistence(timeout: 10))
        let reopenedComplete = relaunched.buttons["complete-task-button"]
        XCTAssertTrue(reopenedComplete.waitForExistence(timeout: 5))
        XCTAssertEqual(reopenedComplete.label, "Mark Incomplete")
    }
}

import XCTest

/// Hardware keyboard and split-view behaviour that only applies at iPad widths.
final class IPadKeyboardUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// The test runner may itself run as a phone app, so the app's window decides.
    private func launch(tab: String, chat: Bool = false) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = tab
        if chat {
            app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
            app.launchEnvironment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] = "1"
        }
        app.launch()
        try XCTSkipIf(app.windows.firstMatch.frame.width < 700, "Needs an iPad-width window")
        return app
    }

    func testCommandNumberSwitchesTabs() throws {
        let app = try launch(tab: "boards")

        app.typeKey("2", modifierFlags: .command)
        XCTAssertTrue(app.buttons["Sort and filter upcoming tasks"].waitForExistence(timeout: 5))

        app.typeKey("3", modifierFlags: .command)
        XCTAssertTrue(app.buttons["wallet-mode-button"].waitForExistence(timeout: 5))

        app.typeKey("5", modifierFlags: .command)
        XCTAssertTrue(app.buttons["Nostr & Sync"].firstMatch.waitForExistence(timeout: 5)
            || app.staticTexts["Nostr & Sync"].waitForExistence(timeout: 1))
    }

    func testCommandNOpensQuickAddOnBoards() throws {
        let app = try launch(tab: "settings")
        XCTAssertTrue(app.staticTexts["Nostr & Sync"].waitForExistence(timeout: 10))

        app.typeKey("n", modifierFlags: .command)

        // A week board shows several day columns at this width, each with its own field.
        let quickAddFields = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        )
        XCTAssertTrue(quickAddFields.firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        app.typeText("Typed after Command-N")
        let typed = quickAddFields.matching(NSPredicate(format: "value == %@", "Typed after Command-N")).firstMatch
        XCTAssertTrue(typed.waitForExistence(timeout: 5), "Command-N should focus a quick-add field")
    }

    func testExpandedThreadHasNoBackButtonAndCommandReturnSends() throws {
        let app = try launch(tab: "chat", chat: true)

        let contact = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "UI Test Contact")
        ).firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Back to chats"].exists,
            "The conversation list is beside the thread, so the thread has no back button")

        composer.tap()
        composer.typeText("Sent with Command-Return")
        // XCUIKeyboardKey.return is not delivered to a text view as a hardware key; "\n" is,
        // and arrives as Return.
        composer.typeKey("\n", modifierFlags: .command)

        let sent = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "Sent with Command-Return")
        ).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 5), "Command-Return sends the message")
        XCTAssertEqual(composer.value as? String ?? "", "", "Sending clears the draft")
    }

    func testHiddenConversationListCanBeShownFromTheThread() throws {
        let app = try launch(tab: "chat", chat: true)

        let contact = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "UI Test Contact")
        ).firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Show conversations"].exists, "The list is showing, so no toggle")

        let hideList = app.buttons["Hide Sidebar"].firstMatch
        hideList.tap()

        let showList = app.buttons["Show conversations"]
        XCTAssertTrue(showList.waitForExistence(timeout: 5), "A thread without its list offers it back")
        XCTAssertFalse(app.buttons["Back to chats"].exists)
        showList.tap()
        XCTAssertTrue(showList.waitForNonExistence(timeout: 5))
        XCTAssertTrue(contact.waitForExistence(timeout: 5))
    }
}

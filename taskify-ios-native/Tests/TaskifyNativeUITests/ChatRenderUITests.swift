import XCTest

/// An open conversation follows only chat state: task changes must not rebuild its timeline.
final class ChatRenderUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testTaskChangesDoNotRebuildAnOpenConversation() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_PERF_PROBE"] = "1"
        app.launch()
        app.buttons["Chat"].firstMatch.tap()
        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        let probe = app.staticTexts["perf-probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 30))
        print("[chat render] \(probe.label)")
        let rebuilds = probe.label.split(separator: " ").first
            .flatMap { Int($0.replacingOccurrences(of: "tasks=", with: "")) } ?? -1
        XCTAssertEqual(rebuilds, 0, "20 task writes rebuilt the open conversation \(rebuilds) times")
    }
}

extension ChatRenderUITests {
    func testHermesModelMenuUsesStockPreviewAndSwitchesModel() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_HERMES_MENU"] = "1"
        app.launch()

        app.buttons["Chat"].firstMatch.tap()
        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        XCTAssertTrue(app.staticTexts["Model configuration"].firstMatch.waitForExistence(timeout: 10))
        let nous = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Nous Portal")
        ).firstMatch
        XCTAssertTrue(nous.waitForExistence(timeout: 5))
        nous.tap()
        XCTAssertTrue(app.staticTexts["Hermes listed 5 of 69 models."].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Refresh"].exists)
        XCTAssertFalse(app.buttons["Switch to openai/gpt-6-astra"].exists)

        let model = app.buttons["Switch to anthropic/claude-opus-5.5"]
        XCTAssertTrue(model.waitForExistence(timeout: 10))
        model.tap()

        XCTAssertTrue(app.staticTexts["Current model"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["anthropic/claude-opus-5.5"].firstMatch.exists)
        XCTAssertFalse(
            app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS %@", "List only the models available")
            ).firstMatch.exists
        )
        XCTAssertFalse(
            app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS %@", #"{"provider":"nous""#)
            ).firstMatch.exists
        )
    }

    func testHermesModelSwitchCanBeRetriedWithoutConfirmation() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_HERMES_MENU"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_HERMES_NO_CONFIRMATION"] = "1"
        app.launch()
        app.buttons["Chat"].firstMatch.tap()
        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()
        let nous = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Nous Portal")).firstMatch
        XCTAssertTrue(nous.waitForExistence(timeout: 5))
        nous.tap()
        let model = app.buttons["Switch to anthropic/claude-opus-5.5"]
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        model.tap()
        XCTAssertFalse(model.isEnabled)
        let timeout = app.staticTexts["Hermes hasn’t confirmed the switch. Tap the model to retry."]
        XCTAssertTrue(timeout.waitForExistence(timeout: 19))
        XCTAssertTrue(model.isEnabled)
    }

    func testHermesSessionButtonSendsResumeCommand() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_HERMES_SESSIONS"] = "1"
        app.launch()

        app.buttons["Chat"].firstMatch.tap()
        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        let session = app.buttons["Resume session: Write comprehensive audit plan paper"]
        XCTAssertTrue(session.waitForExistence(timeout: 10))
        session.tap()

        XCTAssertTrue(
            app.staticTexts["/resume 20261109_013330_790ece03"].firstMatch.waitForExistence(timeout: 10)
        )
    }
}


extension ChatRenderUITests {
    func testCommandMenuSendsOnTapAndOpensRequiredArgumentsInComposer() {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_HERMES_MENU"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 15))
        contact.tap()
        let commands = app.buttons["Commands"]
        XCTAssertTrue(commands.waitForExistence(timeout: 5))
        commands.tap()
        let status = app.buttons["Send command status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        status.tap()
        XCTAssertTrue(app.staticTexts["/status"].firstMatch.waitForExistence(timeout: 5))

        let composer = app.textViews.firstMatch
        composer.tap()
        composer.typeText("/qu")
        let queue = app.buttons["Insert command queue"]
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        queue.tap()
        XCTAssertEqual(composer.value as? String, "/queue ")
        XCTAssertFalse(app.staticTexts["/queue"].exists)
    }

    func testBoundSessionButtonKeepsTheActionOutOfChat() {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_HERMES_SESSIONS"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_HERMES_BOUND_SESSIONS"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 15))
        contact.tap()
        let session = app.buttons["Resume session: Write comprehensive audit plan paper"]
        XCTAssertTrue(session.waitForExistence(timeout: 10))
        session.tap()
        let sent = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Sent"), object: session)
        XCTAssertEqual(XCTWaiter.wait(for: [sent], timeout: 5), .completed)
        XCTAssertFalse(app.staticTexts["/resume 20261109_013330_790ece03"].exists)
    }
}

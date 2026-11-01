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
    func testHermesModelMenuUsesButtonsWithoutRawCatalogTraffic() throws {
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
}

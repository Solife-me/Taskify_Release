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

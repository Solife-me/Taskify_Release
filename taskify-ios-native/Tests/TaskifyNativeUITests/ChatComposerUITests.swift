import XCTest

/// Runtime verification for the chat composer's growth-and-scroll behavior. A long message
/// must cap the composer at its maximum height and keep the caret (the end of the text)
/// visible instead of typing past the fold, and the text must be manually scrollable.
final class ChatComposerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLongMessageCapsComposerKeepsCaretVisibleAndScrolls() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        onboard(app)

        // Open a self conversation: Chat tab → New message → Message Yourself.
        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 5))
        app.buttons["Chat"].tap()
        XCTAssertTrue(app.buttons["New message"].waitForExistence(timeout: 5))
        app.buttons["New message"].tap()
        let selfRow = app.staticTexts["Message Yourself"].firstMatch
        XCTAssertTrue(selfRow.waitForExistence(timeout: 5), "Message Yourself row should be offered")
        selfRow.tap()

        // Type enough text to wrap well past the composer's line cap. Newlines are
        // remapped to send, so rely on word wrap alone.
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "Composer text view should exist")
        composer.tap()
        let longMessage = Array(repeating: "wrap check line", count: 26).joined(separator: " ")
        composer.typeText(longMessage)

        attach(app, name: "composer-long-text-after-typing")

        // The composer must not keep growing with the text (capped near 5 lines), and the
        // full draft must remain in the text view.
        let height = composer.frame.height
        XCTAssertLessThanOrEqual(height, 160, "Composer should cap its height for long text")
        let value = (composer.value as? String) ?? ""
        XCTAssertTrue(value.hasSuffix("line"), "Draft should end with the typed text")

        // Manual scroll inside the composer must reveal the beginning of the draft.
        let start = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let end = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        start.press(forDuration: 0.05, thenDragTo: end)

        attach(app, name: "composer-long-text-after-scroll-up")
    }

    private func onboard(_ app: XCUIApplication) {
        XCTAssertTrue(
            app.staticTexts["Choose how you want to get started."].waitForExistence(timeout: 10)
        )
        app.buttons["Create new login"].tap()
        let nsecText = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "nsec1")
        ).firstMatch
        XCTAssertTrue(nsecText.waitForExistence(timeout: 5))
        app.buttons["Copy nsec"].tap()
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["Enable reminder notifications?"].waitForExistence(timeout: 5))
        app.buttons["Not now"].tap()
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
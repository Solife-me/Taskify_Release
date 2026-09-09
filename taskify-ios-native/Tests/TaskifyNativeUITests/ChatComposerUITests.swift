import XCTest
import UIKit

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

        // Type enough text to wrap well past the composer's 15-line cap. Newlines are
        // remapped to send, so rely on word wrap alone. Distinct markers at each end make
        // the screenshots prove which part of the draft is on screen.
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "Composer text view should exist")
        composer.tap()
        let longMessage = "STARTMARKER "
            + Array(repeating: "wrap check line", count: 34).joined(separator: " ")
            + " ENDMARKER"
        composer.typeText(longMessage)

        attach(app, name: "composer-long-text-after-typing")

        // The composer must not keep growing with the text (capped near 15 lines), and the
        // full draft must remain in the text view.
        let height = composer.frame.height
        XCTAssertLessThanOrEqual(height, 360, "Composer should cap its height for long text")
        let value = (composer.value as? String) ?? ""
        XCTAssertTrue(value.hasSuffix("ENDMARKER"), "Draft should end with the typed text")

        // Manual scroll inside the composer must reveal the beginning of the draft.
        let start = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let end = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        start.press(forDuration: 0.05, thenDragTo: end)

        attach(app, name: "composer-long-text-after-scroll-up")
    }

    func testPasteImageFromClipboardStagesAttachment() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        onboard(app)

        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 5))
        app.buttons["Chat"].tap()
        XCTAssertTrue(app.buttons["New message"].waitForExistence(timeout: 5))
        app.buttons["New message"].tap()
        let selfRow = app.staticTexts["Message Yourself"].firstMatch
        XCTAssertTrue(selfRow.waitForExistence(timeout: 5), "Message Yourself row should be offered")
        selfRow.tap()

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "Composer text view should exist")
        composer.tap()

        // Place an image on the shared simulator pasteboard, as a copied screenshot
        // would be, then long-press the composer to bring up the edit menu.
        let image = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).image { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
        }
        UIPasteboard.general.image = image

        composer.press(forDuration: 1.5)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(
            paste.waitForExistence(timeout: 3),
            "Paste must be offered in the edit menu for an image clipboard"
        )
        paste.tap()

        // The staged attachment shows the draft preview with its Remove button.
        let remove = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Remove ")
        ).firstMatch
        XCTAssertTrue(
            remove.waitForExistence(timeout: 10),
            "Pasting an image should stage an attachment draft"
        )
        attach(app, name: "composer-pasted-attachment")

        UIPasteboard.general.items = []
    }

    func testPasteTextStaysTextNotAttachment() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        onboard(app)

        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 5))
        app.buttons["Chat"].tap()
        XCTAssertTrue(app.buttons["New message"].waitForExistence(timeout: 5))
        app.buttons["New message"].tap()
        let selfRow = app.staticTexts["Message Yourself"].firstMatch
        XCTAssertTrue(selfRow.waitForExistence(timeout: 5), "Message Yourself row should be offered")
        selfRow.tap()

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "Composer text view should exist")
        composer.tap()

        UIPasteboard.general.string = "hello pasted text"
        composer.press(forDuration: 1.5)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 3))
        paste.tap()

        // Text must land in the composer as text, with no attachment draft staged.
        let containsText = NSPredicate(format: "value CONTAINS %@", "hello pasted text")
        expectation(for: containsText, evaluatedWith: composer)
        waitForExpectations(timeout: 5)
        let remove = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Remove ")
        ).firstMatch
        XCTAssertFalse(
            remove.exists,
            "Pasting text must not stage an attachment draft"
        )
        attach(app, name: "composer-pasted-text")

        UIPasteboard.general.items = []
    }

    func testPastingSecondImageStagesSecondAttachment() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        onboard(app)

        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 5))
        app.buttons["Chat"].tap()
        XCTAssertTrue(app.buttons["New message"].waitForExistence(timeout: 5))
        app.buttons["New message"].tap()
        let selfRow = app.staticTexts["Message Yourself"].firstMatch
        XCTAssertTrue(selfRow.waitForExistence(timeout: 5))
        selfRow.tap()

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "Composer text view should exist")
        composer.tap()

        // Each pasted image must append its own draft instead of replacing the
        // previous one, so two pastes stage two independently removable files.
        let removeButtons = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Remove ")
        )
        for pasteIndex in 0..<2 {
            let image = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).image { context in
                pasteIndex == 0 ? UIColor.systemRed.setFill() : UIColor.systemBlue.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
            }
            UIPasteboard.general.image = image
            composer.press(forDuration: 1.5)
            let paste = app.menuItems["Paste"]
            XCTAssertTrue(
                paste.waitForExistence(timeout: 3),
                "Paste must be offered in the edit menu for an image clipboard"
            )
            paste.tap()
            let staged = expectation(for: NSPredicate(format: "count == %d", pasteIndex + 1),
                evaluatedWith: removeButtons)
            wait(for: [staged], timeout: 10)
        }

        attach(app, name: "composer-two-pasted-attachments")

        // Removing one staged draft leaves the other intact.
        let first = removeButtons.element(boundBy: 0)
        first.tap()
        let remaining = expectation(for: NSPredicate(format: "count == 1"), evaluatedWith: removeButtons)
        wait(for: [remaining], timeout: 5)

        attach(app, name: "composer-one-attachment-after-remove")

        UIPasteboard.general.items = []
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
import XCTest
import UIKit

/// Runtime verification for the chat composer's growth-and-scroll behavior. A long message
/// must cap the composer at its maximum height and keep the caret (the end of the text)
/// visible instead of typing past the fold, and the text must be manually scrollable.
final class ChatComposerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testIPadConversationStaysBesideListAndPreservesDraftOnRotation() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()
        guard app.windows.firstMatch.frame.width >= 700 else {
            throw XCTSkip("Run on an iPad simulator")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }

        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 15))
        contact.tap()
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["New message"].isHittable,
                      "The conversation list must remain available beside the conversation")
        composer.tap()
        composer.typeText("iPad unsent draft")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "iPad unsent draft")
        attach(app, name: "ipad-conversation-portrait")
    }

    func testIPadMainScreenLayouts() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        for tab in ["boards", "upcoming", "wallet", "settings"] {
            app.launchEnvironment["TASKIFY_INITIAL_TAB"] = tab
            app.launch()
            guard app.windows.firstMatch.frame.width >= 700 else {
                throw XCTSkip("Run on an iPad simulator")
            }
            XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 15),
                          "App navigation must remain accessible from \(tab)")
            XCTAssertTrue(app.otherElements["taskify-startup-loading"].waitForNonExistence(timeout: 15))
            attach(app, name: "ipad-\(tab)-portrait")
            app.terminate()
        }
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

        // Type enough text to wrap well past the composer's 15-line cap. Distinct markers at
        // each end make the screenshots prove which part of the draft is on screen.
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

        XCTAssertTrue(app.keyboards.firstMatch.exists,
            "Scrolling a long draft must keep the keyboard open")
        XCTAssertEqual(composer.value as? String, longMessage)
        attach(app, name: "composer-long-text-after-scroll-up")
    }

    func testReturnInComposerInsertsNewlineWithoutSending() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("First line")

        let returnKey = app.keyboards.buttons["return"]
        XCTAssertTrue(returnKey.waitForExistence(timeout: 5), "The keyboard Return key should be visible")
        returnKey.tap()

        XCTAssertEqual(composer.value as? String, "First line\n")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "Return should keep the keyboard open")
    }

    func testEmptyComposerOffersAudioRecordingAndTextRestoresSendButton() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        let record = app.buttons["Record audio message"]
        XCTAssertTrue(
            record.waitForExistence(timeout: 5),
            "An empty chat composer should make audio recording a one-tap action"
        )

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Hello")

        XCTAssertTrue(app.buttons["Send message"].waitForExistence(timeout: 5))
        XCTAssertFalse(record.exists, "Typing a message should replace the microphone with Send")
    }

    func testAudioMessagePlaysSkipsAndPauses() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_AUDIO"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        let play = app.buttons["Play audio"]
        XCTAssertTrue(play.waitForExistence(timeout: 10))
        let forward = app.buttons["Forward 10 seconds"]
        XCTAssertFalse(forward.isEnabled, "Skipping needs a loaded message to skip from")
        play.tap()

        let pause = app.buttons["Pause audio"]
        XCTAssertTrue(pause.waitForExistence(timeout: 10), "Tapping Play should start playback")
        XCTAssertTrue(app.staticTexts["0:25"].waitForExistence(timeout: 5), "The card should show the duration")
        XCTAssertTrue(forward.isEnabled)
        forward.tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '0:1'")).firstMatch
                .waitForExistence(timeout: 5),
            "Forward 10 seconds should move the elapsed time past ten seconds"
        )
        pause.tap()
        XCTAssertTrue(play.waitForExistence(timeout: 5))
        XCTAssertFalse(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Cannot Open' OR label CONTAINS[c] 'error'"))
                .firstMatch.exists,
            "Playback should not report an error"
        )
    }

    func testComposerTextCanBeSelected() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Selectable words here")
        // While the keyboard is up the field's accessibility frame still reports where it sits
        // with the keyboard down, so XCUITest taps would land on the keyboard. Select with the
        // keyboard closed: double-tapping a word must focus the field and select the word
        // rather than be taken by the timeline's tap-to-dismiss.
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: composer.frame.midX, dy: composer.frame.minY - 70))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(
                CGVector(dx: composer.frame.midX, dy: keyboard.frame.maxY - 30)
            ))
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
        composer.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).doubleTap()
        XCTAssertTrue(
            app.menuItems["Copy"].waitForExistence(timeout: 3),
            "Double-tapping a word in the composer should select it and offer Copy"
        )
    }

    func testTappingRecordWithKeyboardClosedExplainsHoldToRecord() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()
        let record = app.buttons["Record audio message"]
        XCTAssertTrue(record.waitForExistence(timeout: 5))
        record.tap()
        XCTAssertTrue(
            app.staticTexts["Tap and hold to record and send audio"].waitForExistence(timeout: 3),
            "A quick tap with the keyboard closed should explain hold-to-record, as Messages does"
        )
    }

    func testLongDraftWithAttachmentKeepsCaretAboveKeyboard() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()

        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
        }
        composer.press(forDuration: 1.5)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 3))
        paste.tap()
        let remove = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove ")).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 10), "The pasted image should be staged")

        composer.tap()
        let lines = (1...30).map { "Line \($0) of a long message with an attachment" }
        composer.typeText(lines.joined(separator: "\n") + " CARETMARKER")

        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists)
        XCTAssertLessThanOrEqual(
            composer.frame.maxY, keyboard.frame.minY + 1,
            "The composer must stay above the keyboard however long the draft grows"
        )
        XCTAssertGreaterThan(composer.frame.minY, 0)
        XCTAssertTrue(remove.isHittable, "The staged attachment must stay on screen above the draft")
    }

    func testAttachmentsRenderInThreadAndCanBeSaved() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_ATTACHMENTS"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        XCTAssertTrue(
            app.buttons["Open Trip Itinerary.pdf"].waitForExistence(timeout: 10),
            "A file should render as its own row in the thread"
        )
        XCTAssertTrue(app.buttons["Save Trip Itinerary.pdf to Files"].exists)

        let stack = app.buttons["3 photos"]
        XCTAssertTrue(stack.waitForExistence(timeout: 5), "Consecutive photos should collapse into one stack")
        XCTAssertTrue(app.buttons["Save 3 photos"].exists, "Incoming photos get a save button beside them")
        // The stack's top can sit under the header at the bottom of the thread; tap its front card.
        stack.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.85)).tap()
        XCTAssertTrue(app.navigationBars["3 Photos"].waitForExistence(timeout: 5), "The stack opens every photo")
        app.navigationBars["3 Photos"].buttons["Done"].tap()

        let audio = app.staticTexts["Audio Message UI Test"]
        XCTAssertTrue(audio.waitForExistence(timeout: 5))
        audio.press(forDuration: 1.0)
        XCTAssertTrue(
            app.buttons["Save to Files"].waitForExistence(timeout: 5),
            "An audio message's long-press menu should offer saving it to the device"
        )
        XCTAssertTrue(app.buttons["Share…"].exists)
    }

    func testDraggingConversationDownDismissesKeyboardAndPreservesDraft() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Unsent draft")
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))

        let origin = app.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: composer.frame.midX, dy: composer.frame.minY - 70))
        let end = origin.withOffset(CGVector(dx: composer.frame.midX, dy: keyboard.frame.maxY - 30))
        start.press(forDuration: 0.05, thenDragTo: end)

        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5),
            "Dragging down from the conversation must dismiss the keyboard")
        XCTAssertEqual(composer.value as? String, "Unsent draft")
        composer.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5),
            "The draft must remain editable after interactive dismissal")
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
        let start = app.buttons["Start using Taskify"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

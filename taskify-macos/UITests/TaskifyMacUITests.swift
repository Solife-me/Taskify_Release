import AppKit
import AppIntentsTesting
import CoreSpotlight
import XCTest

final class TaskifyMacUITests: XCTestCase {
    private static let fixtureTaskID = "ui-test-deep-link-task"
    private static let fixtureBoardID = "ui-test-board"
    private static let spotlightDomain = "solife.me.Taskify.Mac.UITests.tasks"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @available(macOS 27.0, *)
    func testIsolatedHostOpensFixtureTaskFromInjectedDeepLink() async throws {
        let taskTitle = "Shortcut task \(UUID().uuidString.prefix(6))"
        let app = XCUIApplication()
        app.launchArguments = [
            "--taskify-ui-test-session", "default",
            "--taskify-ui-test-open-url",
            "taskify://task?id=ui-test-deep-link-task&board=ui-test-board",
        ]
        app.launch()

        XCTAssertTrue(app.staticTexts["UI Test Board"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Open this task from a deep link"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["TASK DETAILS"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Edit Task…"].exists)
        XCTAssertFalse(app.staticTexts["Welcome to Taskify"].exists)

        app.terminate()
        XCTAssertEqual(app.state, .notRunning)
        let definitions = IntentDefinitions(bundleIdentifier: "solife.me.Taskify.Mac.UITests")
        try await definitions.intents["TaskifyAddTaskIntent"]
            .makeIntent(taskTitle: taskTitle)
            .run()

        let relaunched = XCUIApplication()
        relaunched.launchArguments = [
            "--taskify-ui-test-session", "default",
            "--taskify-ui-test-preserve-store",
        ]
        relaunched.launch()
        XCTAssertTrue(relaunched.staticTexts["UI Test Board"].waitForExistence(timeout: 10))
        relaunched.staticTexts["UI Test Board"].click()
        XCTAssertTrue(relaunched.staticTexts[taskTitle].waitForExistence(timeout: 10))
    }

    @MainActor
    func testSpotlightTaskOpensAndCompletionRemovesIt() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", UUID().uuidString]
        app.launch()

        XCTAssertTrue(app.staticTexts["UI Test Board"].waitForExistence(timeout: 10))
        let indexedItem = try await waitForSpotlightItem(present: true)
        XCTAssertEqual(
            indexedItem?.attributeSet.contentURL?.absoluteString,
            "taskify://task?id=\(Self.fixtureTaskID)&board=\(Self.fixtureBoardID)"
        )

        let contentURL = try XCTUnwrap(indexedItem?.attributeSet.contentURL)
        app.open(contentURL)
        XCTAssertTrue(app.staticTexts["TASK DETAILS"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Open this task from a deep link"].exists)

        let complete = app.buttons["complete-task-button"]
        XCTAssertTrue(complete.waitForExistence(timeout: 5))
        complete.click()
        let removedItem = try await waitForSpotlightItem(present: false)
        XCTAssertNil(removedItem)
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

    func testStaleEditorCannotOverwriteNewerWindowEdit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", UUID().uuidString]
        app.launch()

        let board = app.staticTexts["UI Test Board"].firstMatch
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        board.click()
        app.staticTexts["Open this task from a deep link"].firstMatch.click()
        XCTAssertTrue(app.buttons["edit-task-button"].waitForExistence(timeout: 5))
        app.buttons["edit-task-button"].click()

        let staleTitle = "Stale draft \(UUID().uuidString.prefix(6))"
        let staleField = app.textFields["task-title-field"]
        XCTAssertTrue(staleField.waitForExistence(timeout: 5))
        staleField.click()
        staleField.typeKey("a", modifierFlags: .command)
        staleField.typeText(staleTitle)

        let oldWindowCount = app.windows.count
        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(app.windows.element(boundBy: oldWindowCount).waitForExistence(timeout: 5))

        let freshWindow = try XCTUnwrap((0..<app.windows.count).lazy.compactMap { index in
            let window = app.windows.element(boundBy: index)
            return window.staticTexts["UI Test Board"].exists
                && !window.textFields["task-title-field"].exists ? window : nil
        }.first)
        freshWindow.click()
        freshWindow.staticTexts["UI Test Board"].firstMatch.click()
        let fixtureTask = freshWindow.staticTexts["Open this task from a deep link"].firstMatch
        XCTAssertTrue(fixtureTask.waitForExistence(timeout: 5))
        fixtureTask.click()
        XCTAssertTrue(freshWindow.buttons["edit-task-button"].waitForExistence(timeout: 5))
        freshWindow.buttons["edit-task-button"].click()

        let freshTitle = "Fresh edit \(UUID().uuidString.prefix(6))"
        let freshField = freshWindow.textFields["task-title-field"]
        XCTAssertTrue(freshField.waitForExistence(timeout: 5))
        freshField.click()
        freshField.typeKey("a", modifierFlags: .command)
        freshField.typeText(freshTitle)
        freshWindow.buttons["save-task-button"].click()
        XCTAssertTrue(freshWindow.staticTexts[freshTitle].firstMatch.waitForExistence(timeout: 5))

        freshWindow.typeKey("w", modifierFlags: .command)
        let staleSave = app.buttons["save-task-button"].firstMatch
        XCTAssertTrue(staleSave.waitForExistence(timeout: 5))
        staleSave.click()

        let conflict = app.staticTexts["task-editor-error"]
        XCTAssertTrue(conflict.waitForExistence(timeout: 5))
        XCTAssertTrue(conflict.label.contains("changed in another window"))
        app.buttons["Cancel"].firstMatch.click()
        XCTAssertTrue(app.staticTexts[freshTitle].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts[staleTitle].exists)
    }

    func testAccountSwitchClosesEditorsAndResetsEveryWindow() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", UUID().uuidString]
        app.launch()

        let board = app.staticTexts["UI Test Board"].firstMatch
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        board.click()
        app.staticTexts["Open this task from a deep link"].firstMatch.click()
        XCTAssertTrue(app.buttons["edit-task-button"].waitForExistence(timeout: 5))
        app.buttons["edit-task-button"].click()

        let firstDraft = app.textFields["task-title-field"]
        XCTAssertTrue(firstDraft.waitForExistence(timeout: 5))
        firstDraft.click()
        firstDraft.typeKey("a", modifierFlags: .command)
        firstDraft.typeText("First account draft")

        let oldWindowCount = app.windows.count
        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(app.windows.element(boundBy: oldWindowCount).waitForExistence(timeout: 5))

        let secondWindow = try XCTUnwrap((0..<app.windows.count).lazy.compactMap { index in
            let window = app.windows.element(boundBy: index)
            return window.staticTexts["UI Test Board"].exists
                && !window.textFields["task-title-field"].exists ? window : nil
        }.first)
        secondWindow.click()
        secondWindow.staticTexts["UI Test Board"].firstMatch.click()
        let fixtureTask = secondWindow.staticTexts["Open this task from a deep link"].firstMatch
        XCTAssertTrue(fixtureTask.waitForExistence(timeout: 5))
        fixtureTask.click()
        XCTAssertTrue(secondWindow.buttons["edit-task-button"].waitForExistence(timeout: 5))
        secondWindow.buttons["edit-task-button"].click()

        let secondDraft = secondWindow.textFields["task-title-field"]
        XCTAssertTrue(secondDraft.waitForExistence(timeout: 5))
        secondDraft.click()
        secondDraft.typeKey("a", modifierFlags: .command)
        secondDraft.typeText("Second account draft")
        XCTAssertEqual(app.textFields.matching(identifier: "task-title-field").count, 2)

        app.typeKey(",", modifierFlags: .command)
        let accountTab = app.buttons["account-settings-tab"]
        XCTAssertTrue(accountTab.waitForExistence(timeout: 5))
        accountTab.click()

        let keyField = app.secureTextFields["account-private-key-field"]
        XCTAssertTrue(keyField.waitForExistence(timeout: 5))
        keyField.click()
        keyField.typeText(String(repeating: "0", count: 63) + "2")
        app.buttons["switch-account-button"].click()

        let confirmSwitch = app.buttons["confirm-switch-account-button"]
        XCTAssertTrue(confirmSwitch.waitForExistence(timeout: 5))
        confirmSwitch.click()
        XCTAssertTrue(app.staticTexts["account-import-message"].waitForExistence(timeout: 5))

        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(app.descendants(matching: .any)["taskify-workspace-today"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "taskify-workspace-today").count, 2)
        XCTAssertEqual(app.textFields.matching(identifier: "task-title-field").count, 0)
        XCTAssertFalse(app.staticTexts["TASK DETAILS"].exists)
    }

    func testCommandQPersistsAnImmediateTaskEdit() {
        let sessionID = UUID().uuidString
        let editedTitle = "Quit-safe edit \(UUID().uuidString.prefix(6))"
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", sessionID]
        app.launch()

        let board = app.staticTexts["UI Test Board"].firstMatch
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        board.click()
        app.staticTexts["Open this task from a deep link"].firstMatch.click()
        XCTAssertTrue(app.buttons["edit-task-button"].waitForExistence(timeout: 5))
        app.buttons["edit-task-button"].click()

        let titleField = app.textFields["task-title-field"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.click()
        titleField.typeKey("a", modifierFlags: .command)
        titleField.typeText(editedTitle)
        app.buttons["save-task-button"].click()
        XCTAssertTrue(app.staticTexts[editedTitle].firstMatch.waitForExistence(timeout: 5))

        app.typeKey("q", modifierFlags: .command)
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 10))

        app.launchArguments = [
            "--taskify-ui-test-session", sessionID,
            "--taskify-ui-test-preserve-store",
            "--taskify-ui-test-open-url",
            "taskify://task?id=ui-test-deep-link-task&board=ui-test-board",
        ]
        app.launch()

        XCTAssertTrue(app.staticTexts[editedTitle].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["TASK DETAILS"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Open this task from a deep link"].exists)
    }

    func testPendingPublicationSurvivesOfflineRelaunch() {
        let sessionID = UUID().uuidString
        let editedTitle = "Offline edit \(UUID().uuidString.prefix(6))"
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", sessionID]
        app.launch()

        let board = app.staticTexts["UI Test Board"].firstMatch
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        board.click()
        app.staticTexts["Open this task from a deep link"].firstMatch.click()
        XCTAssertTrue(app.buttons["edit-task-button"].waitForExistence(timeout: 5))
        app.buttons["edit-task-button"].click()

        let titleField = app.textFields["task-title-field"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.click()
        titleField.typeKey("a", modifierFlags: .command)
        titleField.typeText(editedTitle)
        app.buttons["save-task-button"].click()

        XCTAssertTrue(app.staticTexts["2 changes waiting to sync"].waitForExistence(timeout: 10))
        app.typeKey("q", modifierFlags: .command)
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 10))

        app.launchArguments = [
            "--taskify-ui-test-session", sessionID,
            "--taskify-ui-test-preserve-store",
            "--taskify-ui-test-open-url",
            "taskify://task?id=ui-test-deep-link-task&board=ui-test-board",
        ]
        app.launch()

        XCTAssertTrue(app.staticTexts[editedTitle].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["2 changes waiting to sync"].waitForExistence(timeout: 5))
    }

    func testRawPNGCanBePastedIntoTaskAndChatComposers() {
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", UUID().uuidString]
        app.launch()

        let board = app.staticTexts["UI Test Board"].firstMatch
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        board.click()
        app.buttons["new-task-button"].click()
        XCTAssertTrue(app.textFields["task-title-field"].waitForExistence(timeout: 5))

        putRawPNGOnPasteboard()
        let taskPaste = app.buttons["task-attachment-paste-button"]
        XCTAssertTrue(taskPaste.waitForExistence(timeout: 5))
        taskPaste.click()
        XCTAssertTrue(app.staticTexts["Pasted Image.png"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].click()

        let chat = app.staticTexts["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 5))
        chat.click()
        let fixturePeer = app.staticTexts["Paste Test Contact"]
        XCTAssertTrue(fixturePeer.waitForExistence(timeout: 5))
        fixturePeer.click()

        putRawPNGOnPasteboard()
        let chatPaste = app.buttons["chat-attachment-paste-button"]
        XCTAssertTrue(chatPaste.waitForExistence(timeout: 5))
        chatPaste.click()
        XCTAssertTrue(app.staticTexts["Pasted Image.png"].waitForExistence(timeout: 5))
    }

    func testChatAttachmentsRenderInThreadWithRecordButton() {
        let app = XCUIApplication()
        app.launchArguments = ["--taskify-ui-test-session", UUID().uuidString]
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_ATTACHMENTS"] = "1"
        app.launch()

        let chat = app.staticTexts["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.click()
        let fixturePeer = app.staticTexts["Paste Test Contact"]
        XCTAssertTrue(fixturePeer.waitForExistence(timeout: 5))
        fixturePeer.click()

        XCTAssertTrue(
            app.descendants(matching: .any)["3 photos"].waitForExistence(timeout: 10),
            "Consecutive photos should collapse into one stack"
        )
        XCTAssertTrue(app.staticTexts["Trip Itinerary.pdf"].exists, "A file renders as its own row")
        XCTAssertTrue(app.buttons["Save Trip Itinerary.pdf"].exists)
        XCTAssertTrue(app.buttons["Save 3 photos"].exists, "Incoming photos get a save button beside them")
        XCTAssertTrue(app.staticTexts["Audio Message UI Test"].exists)
        XCTAssertTrue(
            app.buttons["chat-audio-record-button"].exists,
            "The empty message field offers the waveform record button"
        )
        let shot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        shot.name = "mac-chat-attachments"
        shot.lifetime = .keepAlways
        add(shot)

        app.descendants(matching: .any)["3 photos"].click()
        XCTAssertTrue(app.staticTexts["3 Photos"].waitForExistence(timeout: 5), "The stack opens every photo")
        let gallery = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        gallery.name = "mac-chat-photo-gallery"
        gallery.lifetime = .keepAlways
        add(gallery)
    }

    private func waitForSpotlightItem(
        present: Bool,
        timeout: TimeInterval = 15
    ) async throws -> CSSearchableItem? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let item = try await spotlightItem()
            if (item != nil) == present { return item }
            try await Task.sleep(for: .milliseconds(500))
        } while Date() < deadline
        return try await spotlightItem()
    }

    private func spotlightItem() async throws -> CSSearchableItem? {
        let query = CSSearchQuery(
            queryString: "uniqueIdentifier == '\(Self.fixtureTaskID)'",
            queryContext: nil
        )
        for try await result in query.results {
            if result.item.domainIdentifier == Self.spotlightDomain {
                return result.item
            }
        }
        return nil
    }

    private func putRawPNGOnPasteboard() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.setData(Self.onePixelPNG, forType: .png))
        XCTAssertNil(pasteboard.propertyList(forType: .fileURL))
    }

    private static let onePixelPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )!
}

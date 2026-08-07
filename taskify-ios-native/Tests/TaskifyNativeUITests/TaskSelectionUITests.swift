import XCTest

/// Runtime verification for Boards multi-select, ported from the PWA's selection bar
/// (`useSelectionMode` / `SelectionOverlays.tsx`): enter selection mode, select tasks, then bulk
/// Delete. "Move" and "Complete" reuse existing, already-tested single-task AppModel methods
/// (`moveTask`/`toggleCompletion`) looped over the selection, so this focuses on the part that's
/// actually new: the selection UI state machine and the bulk-delete wiring.
final class TaskSelectionUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSelectTasksThenBulkDelete() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText("Selection test task A")
        quickAddField.typeText("\n")
        quickAddField.typeText("Selection test task B")
        quickAddField.typeText("\n")

        let taskA = app.buttons["Edit Selection test task A"]
        let taskB = app.buttons["Edit Selection test task B"]
        XCTAssertTrue(taskA.waitForExistence(timeout: 5))
        XCTAssertTrue(taskB.waitForExistence(timeout: 5))

        app.buttons["Select tasks"].tap()
        attach(app, name: "selection-01-mode-entered")

        // In selection mode, the entire card becomes one selection target, including previews.
        app.buttons["Select Selection test task A"].tap()
        app.buttons["Select Selection test task B"].tap()

        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5))
        attach(app, name: "selection-02-two-selected")

        app.buttons["Delete"].tap()

        // Bulk delete exits selection mode and removes both tasks.
        XCTAssertTrue(app.buttons["Select tasks"].waitForExistence(timeout: 5), "Should exit selection mode after bulk delete")
        XCTAssertFalse(taskA.waitForExistence(timeout: 3), "Deleted task A should no longer exist")
        XCTAssertFalse(taskB.exists, "Deleted task B should no longer exist")
        attach(app, name: "selection-03-after-bulk-delete")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        let data = screenshot.pngRepresentation
        let path = "/tmp/taskify_screens/\(name).png"
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

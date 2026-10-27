import XCTest

/// C8-3: the app follows the iPhone's text size when the in-app size is "System", including the
/// accessibility sizes, and a card can be moved without dragging.
final class DynamicTypeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(contentSize: String?) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        if let contentSize {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", contentSize]
        }
        app.launch()
        app.buttons["Boards"].tap()
        return app
    }

    private func addTask(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText(title)
        quickAddField.typeText("\n")
        let card = app.buttons["Edit \(title)"]
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        app.swipeDown()
        return card
    }

    func testCardTitlesFollowTheSystemTextSize() throws {
        let standard = launch(contentSize: nil)
        let standardHeight = addTask("Size probe default", in: standard).frame.height
        standard.terminate()

        let large = launch(contentSize: "UICTContentSizeCategoryAccessibilityXL")
        let largeHeight = addTask("Size probe large", in: large).frame.height
        attach(large, name: "dynamic-type-01-board-ax3")
        XCTAssertGreaterThan(largeHeight, standardHeight * 1.5, "the title must grow with the system text size")
    }

    func testScreensAtAnAccessibilityTextSize() throws {
        let app = launch(contentSize: "UICTContentSizeCategoryAccessibilityXL")
        let card = addTask("Accessibility size check", in: app)
        card.tap()
        XCTAssertTrue(app.navigationBars["Edit Task"].waitForExistence(timeout: 5))
        attach(app, name: "dynamic-type-02-editor-ax3")
        app.buttons["Cancel"].tap()

        app.buttons["Upcoming"].tap()
        attach(app, name: "dynamic-type-03-upcoming-ax3")
    }

    func testACardMovesWithoutDragging() throws {
        let app = launch(contentSize: nil)
        let card = addTask("Move without dragging", in: app)
        card.press(forDuration: 1.0)
        let move = app.buttons["Move to…"]
        XCTAssertTrue(move.waitForExistence(timeout: 5))
        move.tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 5))
        attach(app, name: "dynamic-type-04-move-sheet")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try? FileManager.default.createDirectory(atPath: "/tmp/taskify_screens", withIntermediateDirectories: true)
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/taskify_screens/\(name).png"))
    }
}

import XCTest

/// C10-7: an open task can be found in Spotlight from the Home Screen, and the result opens it.
final class SpotlightUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAnOpenTaskIsFoundInSpotlightAndOpens() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_FRESH_STORE"] = "1"
        app.launch()

        let title = "Spotlight zebra \(Int.random(in: 1000...9999))"
        let field = app.textFields.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(title + "\n")
        XCTAssertTrue(app.buttons["Edit \(title)"].waitForExistence(timeout: 5))
        // The index follows saves after a short debounce.
        sleep(5)

        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 5))
        // The Home Screen's Search pill; older systems open search by pulling down.
        let pills = springboard.otherElements.matching(identifier: "spotlight-pill")
        if pills.firstMatch.waitForExistence(timeout: 3) {
            let pill = pills.allElementsBoundByIndex.first(where: \.isHittable) ?? pills.firstMatch
            pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        } else {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
                .press(forDuration: 0.05, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
        }
        // Search runs in its own process on current systems, in SpringBoard on older ones.
        let spotlight = XCUIApplication(bundleIdentifier: "com.apple.Spotlight")
        let fieldQuery = NSPredicate(format: "elementType == %d OR elementType == %d",
                                     XCUIElement.ElementType.searchField.rawValue, XCUIElement.ElementType.textField.rawValue)
        var search = spotlight.descendants(matching: .any).matching(fieldQuery).firstMatch
        if !search.waitForExistence(timeout: 5) {
            search = springboard.descendants(matching: .any).matching(fieldQuery).firstMatch
        }
        XCTAssertTrue(search.waitForExistence(timeout: 2))
        let searchApp = spotlight.state == .runningForeground ? spotlight : springboard
        search.typeText(title)

        let result = searchApp.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", title))
            .matching(NSCompoundPredicate(notPredicateWithSubpredicate: fieldQuery)).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15), "the task is in Spotlight")
        attach(searchApp, name: "spotlight-01-result")
        // The app's result, not the web suggestion that repeats the query.
        let row = searchApp.cells
            .matching(NSPredicate(format: "label CONTAINS %@ AND identifier CONTAINS %@", title, "ResultCell"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let editorTitle = app.textFields.matching(NSPredicate(format: "value == %@", title)).firstMatch
        XCTAssertTrue(editorTitle.waitForExistence(timeout: 10), "the result opens the task")
        attach(app, name: "spotlight-02-task-opened")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/taskify_screens/\(name).png"))
    }
}

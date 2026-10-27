import XCTest

/// C8-5: an event's documents show on its card and in its editor, where they can be removed.
final class EventAttachmentUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testEventAttachmentsShowOnTheCardAndInTheEditor() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_EVENT_ATTACHMENT"] = "1"
        app.launch()
        app.buttons["Upcoming"].tap()

        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Event with attachments")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        // The tile for an encrypted document (unreachable in the fixture, so no preview).
        let document = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "Encrypted attachment")).firstMatch
        XCTAssertTrue(document.waitForExistence(timeout: 5), "the card shows the event's document")
        attach(app, name: "event-attachments-01-card")

        card.tap()
        let remove = app.buttons["Remove Agenda.pdf"]
        var scrolls = 0
        while !remove.exists, scrolls < 8 {
            app.swipeUp()
            scrolls += 1
        }
        XCTAssertTrue(remove.waitForExistence(timeout: 5), "the editor lists the document")
        XCTAssertTrue(app.buttons["Add photos"].exists)
        attach(app, name: "event-attachments-02-editor")
        remove.tap()
        XCTAssertFalse(app.buttons["Remove Agenda.pdf"].waitForExistence(timeout: 2))
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

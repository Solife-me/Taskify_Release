import AppIntentsTesting
import XCTest

/// “Siri, in Taskify remind me to … in 30 minutes”: with Taskify not running, the Remind Me intent
/// runs out of process as Siri runs it, and the app then shows the task, due at that time, with a
/// reminder at it.
final class SiriReminderUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @available(iOS 27.0, *)
    func testRemindMeAddsATaskWithItsTimeAndAReminder() async throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_FRESH_STORE"] = "1"
        app.launch()
        let field = app.textFields.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "a fresh store has a board to add to")
        app.terminate()

        // Letters only, so nothing in the title reads as a date or time.
        let title = "Siri reminder \(UUID().uuidString.filter(\.isLetter).prefix(6).lowercased())"
        try await IntentDefinitions(bundleIdentifier: "solife.me.Taskify.Native")
            .intents["TaskifyRemindMeIntent"]
            .makeIntent(reminder: "remind me to \(title) in 30 minutes")
            .run()

        let relaunched = XCUIApplication()
        relaunched.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        relaunched.launch()
        let capitalized = title.prefix(1).uppercased() + title.dropFirst()
        let edit = relaunched.buttons["Edit \(capitalized)"]
        XCTAssertTrue(edit.waitForExistence(timeout: 10), "the task Siri added is on the board")
        attach(relaunched, name: "siri-reminder-01-board")
        edit.tap()
        XCTAssertTrue(
            relaunched.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", "At due time"))
                .firstMatch.waitForExistence(timeout: 5),
            "the task reminds at its due time"
        )
        attach(relaunched, name: "siri-reminder-02-editor")
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

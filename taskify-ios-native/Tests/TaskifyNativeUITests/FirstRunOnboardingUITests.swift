import XCTest
import UIKit

/// Runtime verification for first-run onboarding. A debug-only launch environment makes this
/// deterministic without deleting or depending on the simulator's Keychain.
final class FirstRunOnboardingUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testIPadOnboardingUsesCenteredPanelAndKeepsSignInReachable() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()
        guard app.windows.firstMatch.frame.width >= 700 else {
            throw XCTSkip("Run on an iPad simulator")
        }
        defer { XCUIDevice.shared.orientation = .portrait }

        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let start = app.buttons["Start using Taskify"]
            XCTAssertTrue(start.waitForExistence(timeout: 10))
            XCTAssertLessThanOrEqual(start.frame.width, 500,
                                     "Onboarding actions must not stretch across the iPad")
            XCTAssertEqual(start.frame.midX, app.windows.firstMatch.frame.midX, accuracy: 3)
            XCTAssertTrue(app.buttons["I already use Taskify"].isHittable)
            attach(app, name: orientation == .portrait ? "ipad-onboarding-portrait" : "ipad-onboarding-landscape")
        }

        app.buttons["I already use Taskify"].tap()
        let field = app.secureTextFields["nsec1... or 64-character key"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(field.frame.width, 500)
        field.tap()
        field.typeText("invalid-test-key")
        XCTAssertTrue(app.buttons["Sign in"].isHittable,
                      "The keyboard must not cover the sign-in actions")
        attach(app, name: "ipad-onboarding-signin-keyboard")
    }

    /// C9-5: first run starts with tasks. No key page and no permission prompt on the way in.
    func testStartUsingTaskifyOpensTheBoardsAndPersists() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        let start = app.buttons["Start using Taskify"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        attach(app, name: "onboarding-01-home")
        start.tap()

        XCTAssertTrue(app.buttons["Boards"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Start using Taskify"].exists)
        XCTAssertFalse(app.staticTexts["Enable reminder notifications?"].exists)
        attach(app, name: "onboarding-02-boards")

        app.terminate()
        app.launchEnvironment.removeValue(forKey: "TASKIFY_UI_TEST_ONBOARDING")
        app.launch()
        XCTAssertTrue(app.buttons["Boards"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(
            app.buttons["Start using Taskify"].waitForExistence(timeout: 3),
            "Onboarding must not reappear on a later launch once completed"
        )
    }

    /// C9-5: the key made on first run is offered for saving once there is something to lose.
    func testTheKeyIsOfferedForSavingAfterThreeTasks() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()
        XCTAssertTrue(app.buttons["Start using Taskify"].waitForExistence(timeout: 10))
        app.buttons["Start using Taskify"].tap()
        XCTAssertFalse(app.buttons["Not now"].waitForExistence(timeout: 2), "nothing to lose yet")

        let field = app.textFields.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        for index in 1...3 {
            field.typeText("Key backup task \(index)")
            field.typeText("\n")
        }
        XCTAssertTrue(app.buttons["Not now"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Copy nsec"].exists)
        attach(app, name: "onboarding-03-key-backup-banner")
        app.buttons["Not now"].tap()
        XCTAssertFalse(app.buttons["Not now"].waitForExistence(timeout: 2))
    }

    func testSignInWithInvalidKeyShowsError() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        XCTAssertTrue(app.buttons["I already use Taskify"].waitForExistence(timeout: 10))
        app.buttons["I already use Taskify"].tap()

        let field = app.secureTextFields["nsec1... or 64-character key"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        // Typing before the keyboard is up drops the text in a secure field.
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // Return signs in (the keyboard's Go key). A tap on Sign in while the keyboard animates
        // in can land where the button was before the layout moved.
        field.typeText("not-a-valid-key\n")

        let error = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "invalid")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 3))
        attach(app, name: "onboarding-04-signin-invalid-key-error")
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

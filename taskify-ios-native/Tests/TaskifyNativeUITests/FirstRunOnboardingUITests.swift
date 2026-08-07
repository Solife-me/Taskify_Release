import XCTest

/// Runtime verification for first-run onboarding. A debug-only launch environment makes this
/// deterministic without deleting or depending on the simulator's Keychain.
final class FirstRunOnboardingUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCreateNewLoginFlowCompletesOnboardingAndPersists() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        XCTAssertTrue(app.staticTexts["Choose how you want to get started."].waitForExistence(timeout: 10))
        attach(app, name: "onboarding-01-home")

        app.buttons["Create new login"].tap()

        let nsecText = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "nsec1")
        ).firstMatch
        XCTAssertTrue(nsecText.waitForExistence(timeout: 5), "A generated nsec should be shown for backup")
        attach(app, name: "onboarding-02-create-nsec-shown")

        app.buttons["Copy nsec"].tap()
        XCTAssertTrue(app.staticTexts["nsec copied"].waitForExistence(timeout: 3))

        app.buttons["Continue"].tap()

        XCTAssertTrue(app.staticTexts["Enable reminder notifications?"].waitForExistence(timeout: 5))
        attach(app, name: "onboarding-03-notifications")

        app.buttons["Not now"].tap()

        // Onboarding should dismiss back to the normal app; the Boards tab becomes reachable.
        XCTAssertTrue(app.buttons["Boards"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Choose how you want to get started."].exists)
        attach(app, name: "onboarding-04-dismissed-to-boards")

        // Relaunching must not show onboarding again now that it's been completed.
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "TASKIFY_UI_TEST_ONBOARDING")
        app.launch()
        XCTAssertTrue(app.buttons["Boards"].waitForExistence(timeout: 10))
        XCTAssertFalse(
            app.staticTexts["Choose how you want to get started."].waitForExistence(timeout: 3),
            "Onboarding must not reappear on a later launch once completed"
        )
        attach(app, name: "onboarding-05-relaunch-no-onboarding")
    }

    func testSignInWithInvalidKeyShowsError() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "force"
        app.launch()

        XCTAssertTrue(app.buttons["Sign in with nsec"].waitForExistence(timeout: 10))
        app.buttons["Sign in with nsec"].tap()

        let field = app.secureTextFields["nsec1... or 64-character key"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("not-a-valid-key")

        app.buttons["Continue"].tap()

        XCTAssertTrue(
            app.staticTexts["That nsec looks invalid. Paste a valid nsec or 64-character secret key."]
                .waitForExistence(timeout: 3)
        )
        attach(app, name: "onboarding-06-signin-invalid-key-error")
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

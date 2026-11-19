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

    func testDeletingLocalAccountStartsOverAfterRelaunch() throws {
        let app = XCUIApplication()
        app.launch()
        let start = app.buttons["Start using Taskify"]
        if start.waitForExistence(timeout: 3) { start.tap() }

        let title = "Reset test \(UUID().uuidString.prefix(6))"
        let field = app.textFields.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(title)
        let add = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "and close keyboard")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        let task = app.buttons["Edit \(title)"]
        XCTAssertTrue(task.waitForExistence(timeout: 5))

        let settings = app.buttons["Settings"].firstMatch
        XCTAssertTrue(settings.isHittable)
        settings.tap()
        let sync = app.buttons["Nostr & Sync"]
        XCTAssertTrue(sync.waitForExistence(timeout: 5))
        if !sync.isHittable { app.swipeUp() }
        sync.tap()
        let publicKey = app.staticTexts["taskify-current-npub"]
        XCTAssertTrue(publicKey.waitForExistence(timeout: 5))
        let oldKey = publicKey.label
        XCTAssertTrue(oldKey.hasPrefix("npub1"))
        sync.tap()

        let accountData = app.buttons["Account & Data"]
        if !accountData.isHittable { app.swipeUp() }
        XCTAssertTrue(accountData.isHittable)
        accountData.tap()
        let delete = app.buttons["Delete Local Account and Data"]
        if !delete.isHittable { app.swipeUp() }
        delete.tap()
        let confirmation = app.alerts["Delete local account and data?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.buttons["Cancel"].tap()
        XCTAssertTrue(delete.isHittable)

        delete.tap()
        confirmation.buttons["Delete local data"].tap()
        XCTAssertTrue(app.staticTexts["Close and reopen Taskify"].waitForExistence(timeout: 5))
        app.terminate()
        app.launch()

        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertFalse(task.exists)

        settings.tap()
        if !sync.isHittable { app.swipeUp() }
        sync.tap()
        XCTAssertTrue(publicKey.waitForExistence(timeout: 5))
        XCTAssertTrue(publicKey.label.hasPrefix("npub1"))
        XCTAssertNotEqual(publicKey.label, oldKey)
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

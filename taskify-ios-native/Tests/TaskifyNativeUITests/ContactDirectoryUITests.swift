import XCTest

/// Deleting a contact lives at the bottom of its edit page: contacts → contact → edit → delete.
final class ContactDirectoryUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testDeletingFixturedContactFromItsEditPage() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        app.launch()

        app.buttons["Chat"].firstMatch.tap()
        app.buttons["Open contacts and profile"].firstMatch.tap()

        let contact = app.staticTexts["UI Test Contact"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        let edit = app.buttons["Edit contact"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5), "Contact page has no edit button")
        edit.tap()

        let deleteButton = app.buttons["Delete Contact"].firstMatch
        if !deleteButton.waitForExistence(timeout: 5) {
            // The action sits at the bottom of the form, below the fields on a short screen.
            app.swipeUp()
        }
        XCTAssertTrue(deleteButton.waitForExistence(timeout: 5), "Edit page has no delete button")

        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "contact-edit-delete"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        deleteButton.tap()

        let confirm = app.buttons["Delete"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Delete confirmation did not appear")
        confirm.tap()

        // An unsigned simulator build cannot read the Keychain, so the app has no identity and
        // reports that instead of deleting; that environment cannot exercise this flow.
        let keychainFailure = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "could not be stored securely")
        ).firstMatch
        if keychainFailure.waitForExistence(timeout: 3) {
            throw XCTSkip("Unsigned build: the app has no Nostr identity to delete with.")
        }

        // The edit page and the contact page both close once the contact is gone locally.
        XCTAssertTrue(
            app.staticTexts["Contacts"].firstMatch.waitForExistence(timeout: 10),
            "Did not return to the contacts list after deleting"
        )

        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: contact)
        waitForExpectations(timeout: 8)
    }
}

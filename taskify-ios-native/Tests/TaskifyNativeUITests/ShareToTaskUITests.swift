import XCTest

/// C10-6: a page shared from Safari is saved as a task. The share extension leaves a draft in its
/// own App Group; the app adds the task when it next runs.
final class ShareToTaskUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAPageSharedFromSafariBecomesATask() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_FRESH_STORE"] = "1"
        app.launch()
        // The app tells the share sheet which boards it can save to.
        XCTAssertTrue(app.textFields.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "New task in"))
            .firstMatch.waitForExistence(timeout: 10))
        sleep(2)

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.launch()
        XCUIDevice.shared.system.open(URL(string: "https://example.com/")!)
        // The web view is labelled with the page's title.
        let page = safari.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Example Domain")).firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 20))

        // Share is in the page menu on current Safari, in the toolbar on older ones.
        let share = safari.buttons["Share"].firstMatch
        if !share.waitForExistence(timeout: 2) {
            safari.buttons["MoreMenuButton"].tap()
        }
        XCTAssertTrue(share.waitForExistence(timeout: 5))
        share.tap()
        let taskifyTarget = safari.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Taskify")).firstMatch
        XCTAssertTrue(taskifyTarget.waitForExistence(timeout: 10))
        attach(safari, name: "share-01-sheet")
        taskifyTarget.tap()

        let newTask = safari.buttons["New task"]
        XCTAssertTrue(newTask.waitForExistence(timeout: 10))
        let ready = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"),
            object: newTask
        )
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
        newTask.tap()
        attach(safari, name: "share-02-new-task")
        safari.buttons["Save"].tap()
        XCTAssertFalse(newTask.waitForExistence(timeout: 2) && newTask.isHittable, "the sheet closes")

        app.activate()
        let saved = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Edit Example Domain")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 15), "the app adds the shared page as a task")
        attach(app, name: "share-03-task-added")
    }

    func testASharedPhotoIsUploadedAndAttachedToTheTask() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_FRESH_STORE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_SHARE_PHOTO_DRAFT"] = "1"
        app.launch()

        let saved = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Edit Shared photo")
        ).firstMatch
        XCTAssertTrue(
            saved.waitForExistence(timeout: 60),
            "the app uploads the shared image and adds its task"
        )
        saved.tap()

        let removePhoto = app.buttons["Remove Shared photo.png"]
        var scrolls = 0
        while !removePhoto.exists, scrolls < 8 {
            app.swipeUp()
            scrolls += 1
        }
        XCTAssertTrue(
            removePhoto.waitForExistence(timeout: 10),
            "the imported task keeps the shared image as an attachment"
        )
        attach(app, name: "share-04-photo-attached")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/taskify_screens/\(name).png"))
    }
}

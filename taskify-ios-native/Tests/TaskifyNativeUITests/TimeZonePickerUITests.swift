import XCTest

/// Runtime verification for the per-task time zone picker. The backend (notification scheduling,
/// Nostr sync) already fully supported `dueTimeZone`; this only exercises the new UI path
/// (editor → time zone picker → save → reopen) to confirm the selection actually persists.
final class TimeZonePickerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSelectingTimeZonePersistsAcrossReopen() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText("Time zone test task")
        quickAddField.typeText("\n")

        // The simulator may retain a task from a previous interrupted test run.
        let taskTitle = app.buttons["Edit Time zone test task"].firstMatch
        XCTAssertTrue(taskTitle.waitForExistence(timeout: 5))
        taskTitle.tap()

        let dueDateToggle = app.switches["task-editor-date-toggle"]
        XCTAssertTrue(dueDateToggle.waitForExistence(timeout: 5))
        setSwitch(dueDateToggle, on: true)

        let includeTimeToggle = app.switches["task-editor-time-toggle"]
        XCTAssertTrue(includeTimeToggle.waitForExistence(timeout: 5))
        setSwitch(includeTimeToggle, on: true)

        let timeZoneRow = app.buttons["task-editor-time-zone-row"]
        XCTAssertTrue(timeZoneRow.waitForExistence(timeout: 5))
        timeZoneRow.tap()

        let searchField = app.searchFields["Search by city, abbreviation, or name"]
        XCTAssertTrue(searchField.waitForExistence(timeout: 5))
        searchField.tap()
        searchField.typeText("Tokyo")

        // Each row is a Button labeled "Japan Standard Time" with a caption reading
        // "Asia/Tokyo • GMT+9:00" underneath — not a standalone "Asia/Tokyo" text.
        let tokyoResult = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Asia/Tokyo")
        ).firstMatch
        XCTAssertTrue(tokyoResult.waitForExistence(timeout: 5))
        tokyoResult.tap()

        let updatedTimeZoneRow = app.buttons["task-editor-time-zone-row"]
        XCTAssertTrue(updatedTimeZoneRow.waitForExistence(timeout: 5))
        XCTAssertTrue(
            updatedTimeZoneRow.label.localizedCaseInsensitiveContains("Tokyo"),
            "Editor should reflect the newly selected time-zone city"
        )

        app.buttons["Save"].tap()

        // Reopen the task and confirm the selection survived the save/reload round trip.
        XCTAssertTrue(taskTitle.waitForExistence(timeout: 5))
        taskTitle.tap()
        let collapsedTimeRow = app.buttons["task-editor-time-row"]
        XCTAssertTrue(collapsedTimeRow.waitForExistence(timeout: 5))
        collapsedTimeRow.tap()
        let persistedTimeZoneRow = app.buttons["task-editor-time-zone-row"]
        XCTAssertTrue(persistedTimeZoneRow.waitForExistence(timeout: 5))
        XCTAssertTrue(
            persistedTimeZoneRow.label.localizedCaseInsensitiveContains("Tokyo"),
            "Tokyo time zone should persist after save + reopen"
        )
        attach(app, name: "timezone-01-persisted-after-reopen")
    }

    func testTaskifyEventExposesTimeZoneAndReminderControls() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Upcoming"].tap()
        let addButton = app.buttons["Add task"]
        XCTAssertTrue(addButton.waitForExistence(timeout: 10))
        addButton.tap()

        let eventSegment = app.segmentedControls.buttons["Event"]
        XCTAssertTrue(eventSegment.waitForExistence(timeout: 5))
        eventSegment.tap()

        let allDayToggle = app.switches["All-day"]
        XCTAssertTrue(allDayToggle.waitForExistence(timeout: 5))
        setSwitch(allDayToggle, on: false)

        let timeZoneRow = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "Time Zone,")
        ).firstMatch
        XCTAssertTrue(timeZoneRow.waitForExistence(timeout: 5))

        let reminderToggle = app.switches["15 minutes before"]
        XCTAssertTrue(reminderToggle.waitForExistence(timeout: 5))
        setSwitch(reminderToggle, on: true)
        XCTAssertEqual(reminderToggle.value as? String, "1")

        let repeatPicker = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "Repeat,")
        ).firstMatch
        if !repeatPicker.waitForExistence(timeout: 2) {
            app.swipeUp()
            app.swipeUp()
        }
        XCTAssertTrue(repeatPicker.waitForExistence(timeout: 5))
        repeatPicker.tap()
        let dailyOption = app.buttons["Daily"]
        XCTAssertTrue(dailyOption.waitForExistence(timeout: 5))
        dailyOption.tap()
        XCTAssertTrue(
            app.buttons.matching(
                NSPredicate(format: "label CONTAINS[c] %@", "Repeat, Daily")
            ).firstMatch.waitForExistence(timeout: 5)
        )
        attach(app, name: "timezone-02-taskify-event-scheduling")
    }

    /// Taps a Toggle until its value actually reflects the desired state. A dead-center `.tap()`
    /// on the accessibility element (which spans the whole Form row) is unreliable for these
    /// Form-row toggles — tap near the visible switch control on the row's trailing edge instead,
    /// and retry since a Form section's inline-picker animation can still cost the first attempt.
    private func setSwitch(_ element: XCUIElement, on: Bool) {
        let target = on ? "1" : "0"
        for _ in 0..<3 {
            if (element.value as? String) == target { return }
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTAssertEqual(element.value as? String, target, "Failed to set \(element) to \(target)")
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

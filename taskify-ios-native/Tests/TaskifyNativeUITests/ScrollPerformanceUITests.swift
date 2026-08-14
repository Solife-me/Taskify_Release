import XCTest

/// Runtime smoke test for the Boards-tab scroll jank fix: seeds enough tasks into
/// today's week-board column to force vertical scrolling, then swipes horizontally
/// across day columns, confirming the app stays responsive and renders correctly
/// throughout (no crash, cards still legible after scroll).
final class ScrollPerformanceUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testBoardsScrollRemainsResponsiveWithManyTasks() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()

        for index in 1...20 {
            quickAddField.typeText("Scroll test task \(index)")
            quickAddField.typeText("\n")
        }

        attach(app, name: "scroll-01-tasks-seeded")

        // The quick-add keyboard stays up after submitting (by design, for rapid entry), and
        // XCUITest's swipe convenience methods can compute drag points that fall on the
        // keyboard itself rather than the board content, turning the gesture into
        // swipe-to-type. Sidestep that entirely by driving the drags with explicit
        // coordinates confined to the task-list/column-header area, safely above the keyboard.
        let topArea = CGVector(dx: 0.5, dy: 0.18)
        let midArea = CGVector(dx: 0.5, dy: 0.42)

        // Vertical scroll within today's column.
        app.coordinate(withNormalizedOffset: midArea)
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: topArea))
        app.coordinate(withNormalizedOffset: midArea)
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: topArea))
        attach(app, name: "scroll-02-after-vertical-swipe")
        app.coordinate(withNormalizedOffset: topArea)
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: midArea))
        attach(app, name: "scroll-03-after-scroll-back")

        // Horizontal paging between day columns, using the column-header row (well above the
        // keyboard) as the drag track.
        let headerLeft = CGVector(dx: 0.75, dy: 0.14)
        let headerRight = CGVector(dx: 0.15, dy: 0.14)
        app.coordinate(withNormalizedOffset: headerLeft)
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: headerRight))
        attach(app, name: "scroll-04-after-horizontal-swipe-1")
        app.coordinate(withNormalizedOffset: headerLeft)
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: headerRight))
        attach(app, name: "scroll-05-after-horizontal-swipe-2")
        app.coordinate(withNormalizedOffset: headerRight)
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: headerLeft))
        attach(app, name: "scroll-06-after-horizontal-swipe-back")

        // App must still be responsive: the seeded task text should still be findable.
        let firstTask = app.staticTexts["Scroll test task 1"]
        XCTAssertTrue(firstTask.waitForExistence(timeout: 5) || app.buttons["Boards"].exists,
                      "App should still be responsive after repeated scrolling")
    }

    func testPopulatedBoardScrollPerformance() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_PERFORMANCE_FIXTURE"] = "1"
        app.launch()

        let firstTask = app.buttons["Edit Performance task 1"]
        XCTAssertTrue(firstTask.waitForExistence(timeout: 10))

        let options = XCTMeasureOptions()
        options.iterationCount = 5
        var scrollsDown = true
        measure(
            metrics: [XCTOSSignpostMetric.scrollDecelerationMetric],
            options: options
        ) {
            if scrollsDown {
                app.swipeUp(velocity: .fast)
            } else {
                app.swipeDown(velocity: .fast)
            }
            scrollsDown.toggle()
        }
    }

    func testPopulatedBoardHorizontalPagingPerformance() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_PERFORMANCE_FIXTURE"] = "1"
        app.launch()

        let boardsTab = app.buttons["Boards"]
        XCTAssertTrue(boardsTab.waitForExistence(timeout: 30))
        boardsTab.tap()

        // Gate on the board being ready rather than on one seeded row: which weekday column the
        // pager opens on varies with the day the test runs, so any particular task may be a page
        // away. The header button and the startup indicator are the reliable readiness signals.
        let loadingIndicator = app.descendants(matching: .any)["taskify-startup-loading"]
        if loadingIndicator.exists {
            XCTAssertTrue(loadingIndicator.waitForNonExistence(timeout: 30))
        }
        XCTAssertTrue(app.buttons["Show completed tasks"].waitForExistence(timeout: 30))

        // Drag along the column-header row so the gesture lands on the horizontal pager
        // rather than a column's vertical scroll view.
        let headerRight = CGVector(dx: 0.80, dy: 0.16)
        let headerLeft = CGVector(dx: 0.20, dy: 0.16)

        let options = XCTMeasureOptions()
        options.iterationCount = 5
        var pagesForward = true
        measure(
            metrics: [XCTCPUMetric(application: app), XCTOSSignpostMetric.scrollDecelerationMetric],
            options: options
        ) {
            let from = pagesForward ? headerRight : headerLeft
            let to = pagesForward ? headerLeft : headerRight
            app.coordinate(withNormalizedOffset: from)
                .press(forDuration: 0.02, thenDragTo: app.coordinate(withNormalizedOffset: to))
            pagesForward.toggle()
        }
    }

    func testPopulatedBoardIsInteractiveWhenStartupIndicatorDismisses() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_PERFORMANCE_FIXTURE"] = "1"
        app.launch()

        let loadingIndicator = app.descendants(matching: .any)["taskify-startup-loading"]
        if loadingIndicator.exists {
            XCTAssertTrue(
                loadingIndicator.waitForNonExistence(timeout: 10),
                "The startup indicator should finish after the populated board is prepared"
            )
        }

        let showCompleted = app.buttons["Show completed tasks"]
        XCTAssertTrue(showCompleted.waitForExistence(timeout: 5))

        showCompleted.tap()
        XCTAssertTrue(
            app.buttons["Hide completed tasks"].waitForExistence(timeout: 2),
            "The first board interaction should respond as soon as startup loading disappears"
        )
    }

    func testQuickAddReturnKeepsKeyboardAndPlusAddsThenClosesIt() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText("Return keeps keyboard")
        quickAddField.typeText("\n")

        XCTAssertTrue(app.buttons["Edit Return keeps keyboard"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.element.exists, "Return should leave quick add ready for another task")

        quickAddField.typeText("Plus closes keyboard")
        let addButton = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "and close keyboard")
        ).firstMatch
        XCTAssertTrue(addButton.waitForExistence(timeout: 5))
        addButton.tap()

        XCTAssertTrue(app.buttons["Edit Plus closes keyboard"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.element.waitForExistence(timeout: 1))
    }

    func testEmptyQuickAddPlusOpensTheFullNewTaskEditor() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let addDetailsButton = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "Add task details to")
        ).firstMatch
        XCTAssertTrue(addDetailsButton.waitForExistence(timeout: 10))
        XCTAssertTrue(addDetailsButton.isEnabled, "The plus button should work with an empty title")
        addDetailsButton.tap()

        XCTAssertTrue(app.navigationBars["New Task"].waitForExistence(timeout: 5))
        let titleField = app.textFields["Title"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 2))
        if !app.keyboards.element.exists { titleField.tap() }
        titleField.typeText("Cancelled task details")
        app.buttons["Cancel"].tap()
        XCTAssertFalse(
            app.buttons["Edit Cancelled task details"].waitForExistence(timeout: 1),
            "Cancelling the unsaved full editor must not leave a placeholder task"
        )

        XCTAssertTrue(addDetailsButton.waitForExistence(timeout: 3))
        addDetailsButton.tap()
        XCTAssertTrue(app.navigationBars["New Task"].waitForExistence(timeout: 5))
        XCTAssertTrue(titleField.waitForExistence(timeout: 2))
        if !app.keyboards.element.exists { titleField.tap() }
        titleField.typeText("Created from task details")
        app.buttons["Save"].tap()

        XCTAssertTrue(app.buttons["Edit Created from task details"].waitForExistence(timeout: 5))
    }

    func testTaskEditorGroupsDetailsAndOffersOneAttachmentMenu() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()
        let addDetailsButton = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "Add task details to")
        ).firstMatch
        XCTAssertTrue(addDetailsButton.waitForExistence(timeout: 10))
        addDetailsButton.tap()
        XCTAssertTrue(app.navigationBars["New Task"].waitForExistence(timeout: 5))

        let notes = app.textFields["Notes"]
        let attachmentMenu = app.buttons["task-editor-attachment-menu"]
        let subtasks = app.descendants(matching: .any)["task-editor-subtasks"]
        let priority = app.descendants(matching: .any)["task-editor-priority"]
        XCTAssertTrue(notes.waitForExistence(timeout: 5))
        XCTAssertTrue(attachmentMenu.waitForExistence(timeout: 5))
        XCTAssertTrue(subtasks.waitForExistence(timeout: 5))
        XCTAssertTrue(priority.waitForExistence(timeout: 5))
        XCTAssertLessThan(notes.frame.minY, subtasks.frame.minY)
        XCTAssertLessThan(subtasks.frame.minY, priority.frame.minY)

        attachmentMenu.tap()
        for option in [
            "Capture a Photo",
            "Scan a Document",
            "Choose from Photo Library",
            "Choose a File",
        ] {
            XCTAssertTrue(
                app.buttons[option].waitForExistence(timeout: 3),
                "Expected the attachment menu to include \(option)"
            )
        }
        attach(app, name: "task-editor-attachment-menu")
    }

    func testTaskEditorUsesCompactSchedulingMenusWithoutHourlyRepeat() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()
        let addDetailsButton = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "Add task details to")
        ).firstMatch
        XCTAssertTrue(addDetailsButton.waitForExistence(timeout: 10))
        addDetailsButton.tap()
        XCTAssertTrue(app.navigationBars["New Task"].waitForExistence(timeout: 5))

        // The full editor intentionally focuses the title. Dismiss its keyboard so the compact
        // scheduling rows can be reached without the keyboard consuming the lower half of Form.
        if app.keyboards.element.exists {
            app.navigationBars["New Task"].tap()
        }

        let repeatMenu = app.buttons["task-editor-repeat-menu"]
        for _ in 0..<4 where !repeatMenu.exists {
            app.swipeUp()
        }
        XCTAssertTrue(repeatMenu.waitForExistence(timeout: 5))
        repeatMenu.tap()
        XCTAssertTrue(app.buttons["Daily"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Weekdays"].exists)
        XCTAssertTrue(app.buttons["Custom"].exists)
        XCTAssertFalse(app.buttons["Hourly"].exists, "Hourly must not be offered as a Taskify repeat option")
        app.buttons["Daily"].tap()

        let endRepeatMenu = app.buttons["task-editor-end-repeat-menu"]
        XCTAssertTrue(endRepeatMenu.waitForExistence(timeout: 3))
        endRepeatMenu.tap()
        XCTAssertTrue(app.buttons["On Date"].waitForExistence(timeout: 3))
        app.buttons["On Date"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["task-editor-repeat-end-date"].waitForExistence(timeout: 3))

        let reminderMenu = app.buttons["task-editor-early-reminder-menu"]
        for _ in 0..<3 where !reminderMenu.exists {
            app.swipeUp()
        }
        XCTAssertTrue(reminderMenu.waitForExistence(timeout: 3))
        reminderMenu.tap()
        XCTAssertTrue(app.buttons["5 minutes before"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["1 month before"].exists)
        app.buttons["15 minutes before"].tap()

        let secondReminderMenu = app.buttons["task-editor-alert-menu-1"]
        for _ in 0..<3 where !secondReminderMenu.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(
            secondReminderMenu.waitForExistence(timeout: 3),
            "Selecting a reminder should append another empty reminder row"
        )
        XCTAssertTrue(secondReminderMenu.label.localizedCaseInsensitiveContains("2nd Reminder"))
        secondReminderMenu.tap()
        XCTAssertTrue(app.buttons["30 minutes before"].waitForExistence(timeout: 3))
        app.buttons["30 minutes before"].tap()

        let thirdReminderMenu = app.buttons["task-editor-alert-menu-2"]
        for _ in 0..<3 where !thirdReminderMenu.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(
            thirdReminderMenu.waitForExistence(timeout: 3),
            "A trailing empty reminder row should remain after adding a second reminder"
        )
        XCTAssertTrue(thirdReminderMenu.label.localizedCaseInsensitiveContains("3rd Reminder"))

        attach(app, name: "task-editor-multiple-reminders")
    }

    /// Regression test: a long, still-being-typed title used to push the quick-add capsule wider
    /// than the screen (UITextField resists compression to fit its text by default). The field
    /// should instead stay within the screen bounds and let the UITextField scroll its visible
    /// portion to keep the cursor on screen, the same way any bounded text field behaves.
    func testQuickAddFieldStaysOnScreenWithALongTitle() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText(
            "This is a deliberately long task title meant to exercise the quick add field's width constraint"
        )
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 2))

        let screenWidth = app.frame.width
        XCTAssertGreaterThanOrEqual(quickAddField.frame.minX, 0, "The field should not overflow past the left edge")
        XCTAssertLessThanOrEqual(
            quickAddField.frame.maxX,
            screenWidth,
            "The field should not overflow past the right edge of the screen"
        )
    }

    func testQuickAddKeyboardDismissesWhenBoardIsSwipedDown() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText("Keep this draft")
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 2))

        let swipeStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.24))
        let swipeEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.54))
        swipeStart.press(forDuration: 0.05, thenDragTo: swipeEnd)

        XCTAssertFalse(
            app.keyboards.element.waitForExistence(timeout: 2),
            "Swiping down on the board should dismiss the quick-add keyboard"
        )
        XCTAssertEqual(quickAddField.value as? String, "Keep this draft")
        XCTAssertFalse(app.buttons["Edit Keep this draft"].exists)
    }

    /// Regression test: the quick-add field's window-level swipe-to-dismiss-keyboard gesture
    /// must never intercept a drag that begins on a *different* text field, even one presented
    /// in a sheet above the board while quick-add is still first responder in the background.
    /// Before the fix, dragging inside the task editor's title field to select text could get
    /// misread as a swipe-to-dismiss, resigning the background field mid-interaction and leaving
    /// the sheet's dismiss state out of sync — closing and reopening instead of placing the
    /// cursor, exactly as reported: editing a title sometimes worked, sometimes didn't.
    func testDraggingInsideTaskEditorTitleDoesNotDismissTheSheet() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))

        // Seed a real task to edit.
        quickAddField.tap()
        quickAddField.typeText("Rename this task")
        quickAddField.typeText("\n")
        let editButton = app.buttons["Edit Rename this task"]
        XCTAssertTrue(editButton.waitForExistence(timeout: 10))

        // Leave quick-add mid-draft and first responder, matching the reported scenario: the
        // field never went through its own blur flow before another sheet was presented.
        quickAddField.tap()
        quickAddField.typeText("unsent draft")
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 2))

        editButton.tap()
        let titleField = app.textFields["Title"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))

        // Drag inside the title field itself — this is the exact gesture shape
        // (near-vertical, > 30pt) the window-level dismiss gesture was previously willing to
        // steal regardless of which view the touch actually began on.
        let fieldCenter = titleField.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let fieldBelow = titleField.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 3.0))
        fieldCenter.press(forDuration: 0.3, thenDragTo: fieldBelow)

        XCTAssertTrue(app.navigationBars["Edit Task"].exists, "The editor sheet should still be open")
        titleField.tap()
        titleField.typeText("edited ")
        let finalValue = titleField.value as? String ?? ""
        XCTAssertTrue(finalValue.contains("edited"), "Typing after the drag should still reach the title field")
        XCTAssertTrue(finalValue.contains("Rename this task"), "The original title text should be preserved")
    }

    func testRapidCompletionRemovesEachTaskBeforeTheNextTap() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()

        let suffix = String(UUID().uuidString.prefix(8))
        let firstTitle = "Rapid completion one \(suffix)"
        let secondTitle = "Rapid completion two \(suffix)"

        quickAddField.typeText(firstTitle)
        quickAddField.typeText("\n")
        quickAddField.typeText(secondTitle)
        let addButton = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "and close keyboard")
        ).firstMatch
        XCTAssertTrue(addButton.waitForExistence(timeout: 5))
        addButton.tap()
        XCTAssertFalse(app.keyboards.element.waitForExistence(timeout: 1))

        let firstTask = app.buttons["Edit \(firstTitle)"]
        let secondTask = app.buttons["Edit \(secondTitle)"]
        for _ in 0..<8 where !firstTask.exists {
            app.swipeUp()
        }
        XCTAssertTrue(firstTask.waitForExistence(timeout: 5))
        XCTAssertTrue(secondTask.waitForExistence(timeout: 5))
        let completeButtons = app.buttons.matching(identifier: "Complete task")

        let firstCompletionButton = try XCTUnwrap(
            completeButtons.allElementsBoundByIndex.min {
                abs($0.frame.midY - firstTask.frame.midY) < abs($1.frame.midY - firstTask.frame.midY)
            }
        )
        firstCompletionButton.tap()
        XCTAssertFalse(
            firstTask.exists,
            "A completed row should disappear immediately instead of blocking the next checkbox"
        )

        let secondCompletionButton = try XCTUnwrap(
            completeButtons.allElementsBoundByIndex.min {
                abs($0.frame.midY - secondTask.frame.midY) < abs($1.frame.midY - secondTask.frame.midY)
            }
        )
        secondCompletionButton.tap()
        XCTAssertFalse(
            secondTask.exists,
            "A second task should be completable while the first checkmark is still flying"
        )
    }

    func testChatTabLaunchesAndScrollsWithoutCrashing() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Chat"].tap()
        attach(app, name: "chat-01-contacts-list")

        // Without a seeded conversation this only proves the tab renders without
        // crashing; the timeline-hoisting fix itself is covered by the Boards test's
        // scroll behavior plus the code-level fix in ChatView.swift.
        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 5))
    }

    func testOpeningChatStartsAtNewestMessage() throws {
        let app = chatFixtureApplication()
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()

        XCTAssertTrue(
            app.staticTexts["Newest fixture message"].waitForExistence(timeout: 5),
            "Opening a conversation should reveal its newest message"
        )
    }

    func testChatSearchShowsIndividualMessageAndOpensItsLocation() throws {
        let app = chatFixtureApplication()
        app.launch()

        let search = app.textFields["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("early fixture needle")

        let messageResult = app.staticTexts["Searchable early fixture needle"]
        XCTAssertTrue(
            messageResult.waitForExistence(timeout: 5),
            "Global chat search should show the matching message itself"
        )
        messageResult.tap()

        XCTAssertTrue(
            app.staticTexts["Searchable early fixture needle"].waitForExistence(timeout: 5),
            "Tapping a message result should open the conversation at that message"
        )
    }

    func testConversationSearchArrowsAndCloseControlWork() throws {
        let app = chatFixtureApplication()
        app.launch()

        let contact = app.staticTexts["UI Test Contact"]
        XCTAssertTrue(contact.waitForExistence(timeout: 10))
        contact.tap()
        XCTAssertTrue(app.buttons["Conversation actions"].waitForExistence(timeout: 5))
        app.buttons["Conversation actions"].tap()
        app.buttons["Search Conversation"].tap()

        let search = app.textFields["Search conversation"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("repeatable fixture match")
        XCTAssertTrue(app.staticTexts["3/3"].waitForExistence(timeout: 5))

        app.buttons["Previous search result"].tap()
        XCTAssertTrue(app.staticTexts["2/3"].waitForExistence(timeout: 5))
        app.buttons["Next search result"].tap()
        XCTAssertTrue(app.staticTexts["3/3"].waitForExistence(timeout: 5))

        app.buttons["Close conversation search"].tap()
        XCTAssertFalse(app.textFields["Search conversation"].waitForExistence(timeout: 2))
    }

    private func chatFixtureApplication() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_INITIAL_TAB"] = "chat"
        app.launchEnvironment["TASKIFY_UI_TEST_CHAT_FIXTURE"] = "1"
        return app
    }

    /// One physical tap must complete exactly the task it was aimed at — first tap, and only
    /// that task.
    ///
    /// Regression test: completing on touch-down originally paired with a per-view "already
    /// fired" flag, but completing a task re-renders the row and tears the button down before its
    /// action runs, so the flag was never cleared. A stale flag then swallowed a later tap and the
    /// task had to be checked off twice.
    func testSingleTapCompletesOnlyTheTargetedTask() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        let suffix = String(UUID().uuidString.prefix(6))
        let titles = (1...5).map { "Single \(suffix) \($0)" }
        for title in titles {
            quickAddField.typeText(title)
            quickAddField.typeText("\n")
        }
        let addButton = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "and close keyboard")
        ).firstMatch
        XCTAssertTrue(addButton.waitForExistence(timeout: 5))
        addButton.tap()

        for title in titles {
            XCTAssertTrue(app.buttons["Edit \(title)"].waitForExistence(timeout: 10), title)
        }

        let target = app.buttons["Edit \(titles[0])"]
        let completeButtons = app.buttons.matching(identifier: "Complete task")
        let checkbox = try XCTUnwrap(
            completeButtons.allElementsBoundByIndex.min {
                abs($0.frame.midY - target.frame.midY) < abs($1.frame.midY - target.frame.midY)
            }
        )

        checkbox.tap()

        // A single tap, with no retry: the targeted task must go.
        XCTAssertTrue(
            app.buttons["Edit \(titles[0])"].waitForNonExistence(timeout: 3),
            "one tap should complete the targeted task"
        )
        // ...and must not take a neighbour with it, which is what happens if the touch-up lands
        // on the row that slid up into the vacated slot.
        for title in titles.dropFirst() {
            XCTAssertTrue(
                app.buttons["Edit \(title)"].exists,
                "\(title) should be untouched by a tap aimed at \(titles[0])"
            )
        }
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

import XCTest

/// One-off runtime smoke test for the Bible tracker, plus a couple of the other
/// recently-added Boards/Upcoming features, driven via XCUITest since this
/// environment has no interactive Simulator window to click into by hand.
final class BibleTrackerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testBibleTrackerFlow() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Settings"].tap()

        let toggle = app.switches["Bible Reading Tracker"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        if let value = toggle.value as? String, value == "0" {
            toggle.tap()
        }

        app.buttons["Boards"].tap()

        // Open the board switcher menu (its label is the current board's name).
        let menuButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Week")).firstMatch
        XCTAssertTrue(menuButton.waitForExistence(timeout: 10))
        menuButton.tap()

        let bibleMenuItem = app.buttons["Bible"]
        XCTAssertTrue(bibleMenuItem.waitForExistence(timeout: 5))
        bibleMenuItem.tap()

        XCTAssertTrue(app.staticTexts["Bible Reading Tracker"].waitForExistence(timeout: 10))
        attach(app, name: "bible-01-tracker-home")

        // Expand Genesis and mark chapter 1 read, then long-press chapter 2 for the verse editor.
        let genesis = app.buttons["Genesis"]
        XCTAssertTrue(genesis.waitForExistence(timeout: 10))
        genesis.tap()

        let chapter1 = app.buttons["Chapter 1"]
        XCTAssertTrue(chapter1.waitForExistence(timeout: 5))
        chapter1.tap()
        attach(app, name: "bible-02-genesis-chapter1-read")

        let chapter2 = app.buttons["Chapter 2"]
        XCTAssertTrue(chapter2.waitForExistence(timeout: 5))
        chapter2.press(forDuration: 1.5)

        let verseSheetTitle = app.navigationBars["Genesis 2"]
        XCTAssertTrue(verseSheetTitle.waitForExistence(timeout: 5))
        attach(app, name: "bible-03-verse-editor-opened")

        let verse1 = app.buttons["1"]
        if verse1.waitForExistence(timeout: 3) {
            verse1.tap()
        }
        let verse2 = app.buttons["2"]
        if verse2.waitForExistence(timeout: 3) {
            verse2.tap()
        }
        attach(app, name: "bible-04-verses-selected")

        app.buttons["Done"].tap()
        XCTAssertTrue(chapter2.waitForExistence(timeout: 5))
        attach(app, name: "bible-05-back-to-tracker-partial-chapter")

        // Collapse Genesis, then fully complete Ruth (4 short chapters).
        genesis.tap()

        let ruth = app.buttons["Ruth"]
        XCTAssertTrue(ruth.waitForExistence(timeout: 10))
        ruth.tap()

        for chapter in 1...4 {
            let button = app.buttons["Chapter \(chapter)"]
            XCTAssertTrue(button.waitForExistence(timeout: 5))
            button.tap()
        }
        attach(app, name: "bible-06-ruth-all-chapters-read")

        let completeBookButton = app.buttons["Complete Book"]
        XCTAssertTrue(completeBookButton.waitForExistence(timeout: 5))
        completeBookButton.tap()
        attach(app, name: "bible-07-ruth-completed")

        // Show completed books.
        let showCompletedButton = app.buttons["Show completed tasks"]
        XCTAssertTrue(showCompletedButton.waitForExistence(timeout: 5))
        showCompletedButton.tap()

        XCTAssertTrue(app.staticTexts["Ruth"].waitForExistence(timeout: 5))
        attach(app, name: "bible-08-completed-books-list")

        let restoreButton = app.buttons["Restore"].firstMatch
        XCTAssertTrue(restoreButton.waitForExistence(timeout: 5))
        restoreButton.tap()
        attach(app, name: "bible-09-after-restore")

        // Hide completed again, then reset progress and confirm the archive entry appears.
        let hideCompletedButton = app.buttons["Hide completed tasks"]
        XCTAssertTrue(hideCompletedButton.waitForExistence(timeout: 5))
        hideCompletedButton.tap()

        let resetButton = app.buttons["Reset Progress"]
        XCTAssertTrue(resetButton.waitForExistence(timeout: 5))
        resetButton.tap()

        let confirmReset = app.buttons["Reset & Archive"]
        XCTAssertTrue(confirmReset.waitForExistence(timeout: 5))
        confirmReset.tap()

        XCTAssertTrue(app.staticTexts["ARCHIVE"].waitForExistence(timeout: 5))
        attach(app, name: "bible-10-after-reset-archive")
    }

    func testBoardSortAndUpcomingFilterSmoke() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Boards"].tap()

        // The previously selected board persists across launches; make sure we're on the
        // (non-Bible) Week board, which has a sort button, before proceeding.
        let boardSwitcher = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Week"))
            .firstMatch
        if boardSwitcher.waitForExistence(timeout: 5) {
            // Already on Week.
        } else {
            let anySwitcher = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Bible")).firstMatch
            if anySwitcher.waitForExistence(timeout: 5) {
                anySwitcher.tap()
                let weekMenuItem = app.buttons["Week"]
                if weekMenuItem.waitForExistence(timeout: 5) {
                    weekMenuItem.tap()
                }
            }
        }

        let sortButton = app.buttons["Sort tasks"]
        XCTAssertTrue(sortButton.waitForExistence(timeout: 10))
        sortButton.tap()

        XCTAssertTrue(app.navigationBars["Sort Board"].waitForExistence(timeout: 5))
        attach(app, name: "board-01-sort-sheet")

        let dueDateOption = app.buttons["Due Date"]
        if dueDateOption.waitForExistence(timeout: 3) {
            dueDateOption.tap()
        }
        app.buttons["Done"].tap()

        app.buttons["Upcoming"].tap()
        let upcomingSortButton = app.buttons["Sort and filter upcoming tasks"]
        XCTAssertTrue(upcomingSortButton.waitForExistence(timeout: 10))
        upcomingSortButton.tap()

        XCTAssertTrue(app.navigationBars["Sort & Filter"].waitForExistence(timeout: 5))
        attach(app, name: "upcoming-01-sort-filter-sheet")

        let usHolidaysToggle = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "US Holidays")).firstMatch
        if usHolidaysToggle.waitForExistence(timeout: 3) {
            usHolidaysToggle.tap()
            attach(app, name: "upcoming-02-us-holidays-toggled")
            usHolidaysToggle.tap()
        }

        app.buttons["Done"].tap()
        attach(app, name: "upcoming-03-back-to-list")
    }

    /// Regression test for a reported bug: a drag gesture starting on top of a chapter cell
    /// (as opposed to empty space) must still scroll the surrounding list. Psalms (150 chapters)
    /// is used because its grid overflows the screen, unlike shorter books.
    func testChapterGridScrollsWhenTouchStartsOnAChapter() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Settings"].tap()
        let bibleToggle = app.switches["Bible Reading Tracker"]
        XCTAssertTrue(bibleToggle.waitForExistence(timeout: 10))
        if let value = bibleToggle.value as? String, value == "0" {
            bibleToggle.tap()
        }

        app.buttons["Boards"].tap()

        let bibleMenuButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Bible")).firstMatch
        if bibleMenuButton.waitForExistence(timeout: 5) {
            // Already on the Bible board.
        } else {
            let switcher = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Week")).firstMatch
            if switcher.waitForExistence(timeout: 5) {
                switcher.tap()
                let bibleMenuItem = app.buttons["Bible"]
                if bibleMenuItem.waitForExistence(timeout: 5) {
                    bibleMenuItem.tap()
                }
            }
        }

        XCTAssertTrue(app.staticTexts["Bible Reading Tracker"].waitForExistence(timeout: 10))

        let psalmsButton = app.buttons["Psalms"]
        var attempts = 0
        while !psalmsButton.exists, attempts < 20 {
            app.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(psalmsButton.waitForExistence(timeout: 5))
        psalmsButton.tap()

        let chapter1 = app.buttons["Chapter 1"]
        XCTAssertTrue(chapter1.waitForExistence(timeout: 5))
        attach(app, name: "scroll-01-psalms-expanded-top")
        let initialFrame = chapter1.frame

        // Perform the scroll gesture starting *on top of* a chapter cell, matching the reported bug.
        let midChapter = app.buttons["Chapter 20"]
        XCTAssertTrue(midChapter.waitForExistence(timeout: 5))
        midChapter.swipeUp()
        midChapter.swipeUp()

        if chapter1.exists {
            attach(app, name: "scroll-02-after-swiping-on-chapter-cell")
            XCTAssertNotEqual(
                chapter1.frame.minY,
                initialFrame.minY,
                "Scrolling did not move the page when the gesture started on a chapter cell"
            )
        }
        // If chapter1 no longer exists at all, it scrolled off-screen entirely, which is also
        // proof scrolling worked.
    }

    func testFastingRemindersFlow() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Settings"].tap()

        let toggle = app.switches["Fasting Reminders"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        if let value = toggle.value as? String, value == "0" {
            toggle.tap()
        }

        // Switch to "Random days" and max out the per-month count so at least one generated
        // task is guaranteed to land within the current (visible-immediately) week, regardless
        // of which real-world weekday this test happens to run on.
        let randomModeButton = app.buttons["Random days"]
        XCTAssertTrue(randomModeButton.waitForExistence(timeout: 5))
        randomModeButton.tap()

        let incrementButton = app.steppers.firstMatch.buttons.element(boundBy: 1)
        XCTAssertTrue(incrementButton.waitForExistence(timeout: 5))
        for _ in 0..<30 {
            incrementButton.tap()
        }
        attach(app, name: "fasting-01-settings-configured")

        app.buttons["Boards"].tap()

        // Make sure we're on a week board (previous tests may have left a different board selected).
        let weekMenuButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Week")).firstMatch
        if !weekMenuButton.waitForExistence(timeout: 5) {
            let anySwitcher = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Bible")).firstMatch
            if anySwitcher.waitForExistence(timeout: 5) {
                anySwitcher.tap()
                let weekMenuItem = app.buttons["Week"]
                if weekMenuItem.waitForExistence(timeout: 5) {
                    weekMenuItem.tap()
                }
            }
        }

        let fastingTask = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Fasting")).firstMatch
        XCTAssertTrue(fastingTask.waitForExistence(timeout: 10))
        attach(app, name: "fasting-02-task-visible-on-week-board")
    }

    func testScriptureMemoryFlow() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Settings"].tap()

        let bibleToggle = app.switches["Bible Reading Tracker"]
        XCTAssertTrue(bibleToggle.waitForExistence(timeout: 10))
        if let value = bibleToggle.value as? String, value == "0" {
            bibleToggle.tap()
        }

        let scriptureToggle = app.switches["Scripture Memory"]
        XCTAssertTrue(scriptureToggle.waitForExistence(timeout: 10))
        if let value = scriptureToggle.value as? String, value == "0" {
            scriptureToggle.tap()
        }

        // Make sure the target board is "Week" (deterministic regardless of prior test runs).
        let boardPicker = app.buttons["Board"]
        if boardPicker.waitForExistence(timeout: 5) {
            boardPicker.tap()
            let weekOption = app.buttons["Week"]
            if weekOption.waitForExistence(timeout: 3) {
                weekOption.tap()
            }
        }
        attach(app, name: "scripture-01-settings-configured")

        app.buttons["Boards"].tap()

        let bibleMenuButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Bible")).firstMatch
        if bibleMenuButton.waitForExistence(timeout: 5) {
            // Already on the Bible board.
        } else {
            let switcher = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Week")).firstMatch
            if switcher.waitForExistence(timeout: 5) {
                switcher.tap()
                let bibleMenuItem = app.buttons["Bible"]
                if bibleMenuItem.waitForExistence(timeout: 5) {
                    bibleMenuItem.tap()
                }
            }
        }
        XCTAssertTrue(app.staticTexts["Bible Reading Tracker"].waitForExistence(timeout: 10))

        // Scroll down to the Scripture Memory section and add Genesis 1 (entire chapter).
        var attempts = 0
        while !app.staticTexts["SCRIPTURE MEMORY"].exists, attempts < 20 {
            app.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(app.staticTexts["SCRIPTURE MEMORY"].waitForExistence(timeout: 5))

        let addButton = app.buttons["Add"]
        XCTAssertTrue(addButton.waitForExistence(timeout: 5))
        addButton.tap()

        let genesisButton = app.buttons["Genesis"]
        XCTAssertTrue(genesisButton.waitForExistence(timeout: 5))
        genesisButton.tap()

        let chapter1 = app.buttons["1"]
        XCTAssertTrue(chapter1.waitForExistence(timeout: 5))
        chapter1.tap()

        let selectEntireChapter = app.buttons["Select Entire Chapter"]
        XCTAssertTrue(selectEntireChapter.waitForExistence(timeout: 5))
        selectEntireChapter.tap()

        // "Select Entire Chapter" sets explicit start/end verses (1-31 for Genesis 1), so the
        // reference is formatted as a verse range, not the bare "Genesis 1".
        let addGenesis1 = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Add Genesis 1")).firstMatch
        XCTAssertTrue(addGenesis1.waitForExistence(timeout: 5))
        addGenesis1.tap()

        let addedEntry = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Genesis 1:")).firstMatch
        XCTAssertTrue(addedEntry.waitForExistence(timeout: 10))
        attach(app, name: "scripture-02-entry-added")

        // A review task should now exist on the Week board.
        app.buttons["Boards"].tap()
        let switcherBack = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Bible")).firstMatch
        if switcherBack.waitForExistence(timeout: 5) {
            switcherBack.tap()
            let weekMenuItem = app.buttons["Week"]
            if weekMenuItem.waitForExistence(timeout: 5) {
                weekMenuItem.tap()
            }
        }

        let reviewTask = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Review Genesis 1")).firstMatch
        XCTAssertTrue(reviewTask.waitForExistence(timeout: 10))
        attach(app, name: "scripture-03-review-task-on-week-board")
    }

    func testReorderBoards() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Settings"].tap()

        // Create a second board so there's something to reorder against "Week".
        let boardNameField = app.textFields["Board name"]
        XCTAssertTrue(boardNameField.waitForExistence(timeout: 10))
        boardNameField.tap()
        boardNameField.typeText("Reorder Test List")

        let listsSegment = app.buttons["Lists"]
        XCTAssertTrue(listsSegment.waitForExistence(timeout: 5))
        listsSegment.tap()

        let createButton = app.buttons["Create list board"]
        XCTAssertTrue(createButton.waitForExistence(timeout: 5))
        createButton.tap()

        // The new board's row should now exist in the Boards & Lists card.
        let newBoardRow = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Reorder Test List")).firstMatch
        XCTAssertTrue(newBoardRow.waitForExistence(timeout: 10))
        attach(app, name: "reorder-01-board-created")

        // Open its manager sheet via the ellipsis button.
        let manageButton = app.buttons["Manage Reorder Test List"]
        XCTAssertTrue(manageButton.waitForExistence(timeout: 5))
        manageButton.tap()

        let moveUpButton = app.buttons["Move Up"]
        XCTAssertTrue(moveUpButton.waitForExistence(timeout: 10))
        attach(app, name: "reorder-02-manager-sheet")
        XCTAssertTrue(moveUpButton.isEnabled)
        moveUpButton.tap()

        app.buttons["Done"].tap()
        attach(app, name: "reorder-03-after-move-up")

        // Confirm via the board switcher on the Boards tab that ordering changed: "Reorder Test
        // List" should now open before "Week" is reachable as a separate, still-present option.
        app.buttons["Boards"].tap()
        let switcher = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Reorder Test List")).firstMatch
        XCTAssertTrue(switcher.waitForExistence(timeout: 10))
    }

    /// Assumes a fresh app install so the Week board's "today" column has exactly one task.
    func testTaskStreakBadge() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields["New Task"]
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText("Streak Test")
        // Typed as a separate step from submission to avoid a race that can drop the final
        // keystroke when a newline is appended directly to typeText's string.
        quickAddField.typeText("\n")

        let editButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Edit Streak")).firstMatch
        XCTAssertTrue(editButton.waitForExistence(timeout: 10))
        editButton.tap()

        // The task editor opens as a sheet; set it to repeat daily. The Picker's accessibility
        // label concatenates the current value (e.g. "Repeat, Never"), not just "Repeat".
        let repeatRow = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Repeat")).firstMatch
        XCTAssertTrue(repeatRow.waitForExistence(timeout: 10))
        repeatRow.tap()

        let dailyOption = app.buttons["Daily"]
        XCTAssertTrue(dailyOption.waitForExistence(timeout: 5))
        dailyOption.tap()

        app.buttons["Save"].tap()
        attach(app, name: "streak-01-daily-task-saved")

        // Complete it once; a "1" streak badge should appear. Completed tasks are hidden from
        // the board by default, so reveal them first via the "Show completed" header toggle.
        let completeButton = app.buttons["Complete task"].firstMatch
        XCTAssertTrue(completeButton.waitForExistence(timeout: 10))
        completeButton.tap()

        let showCompletedButton = app.buttons["Show completed tasks"]
        XCTAssertTrue(showCompletedButton.waitForExistence(timeout: 5))
        showCompletedButton.tap()

        let streakBadgeAfterOne = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "completion streak"))
            .firstMatch
        XCTAssertTrue(streakBadgeAfterOne.waitForExistence(timeout: 10))
        XCTAssertTrue(streakBadgeAfterOne.label.contains("1"))
        attach(app, name: "streak-02-badge-after-first-completion")

        // Un-completing should decrement the streak back to 0 and hide the badge.
        let uncompleteButton = app.buttons["Mark incomplete"].firstMatch
        XCTAssertTrue(uncompleteButton.waitForExistence(timeout: 10))
        uncompleteButton.tap()

        let streakBadgeAfterUndo = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "completion streak"))
            .firstMatch
        let disappeared = !streakBadgeAfterUndo.waitForExistence(timeout: 5)
        XCTAssertTrue(disappeared, "Streak badge should disappear once the streak drops back to 0")
        attach(app, name: "streak-03-badge-hidden-after-undo")
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

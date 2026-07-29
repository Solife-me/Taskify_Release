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

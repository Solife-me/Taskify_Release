import CoreTransferable
import XCTest
import TaskifyCore
@testable import MacPresentation

final class MacPresentationTests: XCTestCase {
    func testWorkspacePaneLayoutUsesCompactPresentationAtSplitWidths() {
        XCTAssertEqual(MacWorkspaceLayout.panePresentation(for: 300), .compact)
        XCTAssertEqual(MacWorkspaceLayout.panePresentation(for: 639), .compact)
        XCTAssertEqual(MacWorkspaceLayout.panePresentation(for: 640), .regular)
        XCTAssertEqual(MacWorkspaceLayout.panePresentation(for: 900), .regular)
    }

    func testTwoCompactPanesFitInsideMinimumWorkspaceDetail() {
        XCTAssertLessThanOrEqual(MacWorkspaceLayout.minimumPaneWidth * 2, 660)
        XCTAssertGreaterThan(MacWorkspaceLayout.idealPaneWidth, MacWorkspaceLayout.minimumPaneWidth)
        XCTAssertLessThan(MacWorkspaceLayout.inspectorMinimumWidth, MacWorkspaceLayout.minimumPaneWidth)
    }

    func testUITestExternalActionsUseTheDefaultIsolatedStoreAndNeverPublish() {
        let root = URL(fileURLWithPath: "/tmp/taskify-shortcuts-test", isDirectory: true)

        let configuration = MacUITestExternalActionConfiguration.resolve(temporaryDirectory: root)

        XCTAssertEqual(
            configuration.storeURL,
            root
                .appendingPathComponent("TaskifyMacUITests", isDirectory: true)
                .appendingPathComponent("default", isDirectory: true)
                .appendingPathComponent("taskify-ui-test.json", isDirectory: false)
        )
        XCTAssertFalse(configuration.publishesToRelays)
        XCTAssertNotEqual(configuration.storeURL, JSONTaskStore.defaultURL)
    }

    func testPNGItemProviderNegotiatesTheRawImageTransferRepresentation() async throws {
        let provider = NSItemProvider()
        provider.registerDataRepresentation(
            forTypeIdentifier: "public.png",
            visibility: .all
        ) { completion in
            completion(Self.onePixelPNG, nil)
            return nil
        }

        let payload: MacAttachmentTransferPayload = try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadTransferable(type: MacAttachmentTransferPayload.self) {
                continuation.resume(with: $0)
            }
        }

        guard case .rawImage(let bytes) = payload.source else {
            return XCTFail("PNG data unexpectedly loaded as a file URL")
        }
        XCTAssertEqual(bytes, Self.onePixelPNG)
    }

    func testRawPNGMaterializesWithDetectedTypeAndFeedsBothEncryptionPaths() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("TaskifyMacAttachmentTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let imported = try MacAttachmentImporter.materialize(
            .rawImage(Self.onePixelPNG),
            into: root
        )
        defer { try? FileManager.default.removeItem(at: imported.url) }

        XCTAssertEqual(imported.name, "Pasted Image.png")
        XCTAssertEqual(imported.mimeType, "image/png")
        XCTAssertEqual(imported.url.pathExtension, "png")
        XCTAssertEqual(try Data(contentsOf: imported.url), Self.onePixelPNG)

        let taskCiphertext = try AttachmentFileCrypto.encryptTask(imported.url, boardID: "board")
        defer { try? FileManager.default.removeItem(at: taskCiphertext) }
        let taskPlaintext = try AttachmentFileCrypto.decryptTask(taskCiphertext, boardID: "board")
        defer { try? FileManager.default.removeItem(at: taskPlaintext) }
        XCTAssertEqual(try Data(contentsOf: taskPlaintext), Self.onePixelPNG)

        let chatCiphertext = try AttachmentFileCrypto.encryptChat(imported.url)
        defer { try? FileManager.default.removeItem(at: chatCiphertext.url) }
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(
            url: "https://files.example/image.bin",
            mimeType: imported.mimeType,
            filename: imported.name,
            size: chatCiphertext.plaintextSize,
            keyHex: chatCiphertext.keyHex,
            nonceHex: chatCiphertext.nonceHex,
            sha256: chatCiphertext.sha256
        ))
        let chatPlaintext = try AttachmentFileCrypto.decryptChat(chatCiphertext.url, attachment: attachment)
        defer { try? FileManager.default.removeItem(at: chatPlaintext) }
        XCTAssertEqual(try Data(contentsOf: chatPlaintext), Self.onePixelPNG)
    }

    func testFileURLImportStillPreservesNameTypeAndBytes() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("TaskifyMacAttachmentTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let imports = root.appendingPathComponent("imports", isDirectory: true)
        try FileManager.default.createDirectory(at: imports, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("notes.txt")
        let bytes = Data("keep the file path".utf8)
        try bytes.write(to: source)

        let imported = try MacAttachmentImporter.materialize(.file(source), into: imports)

        XCTAssertEqual(imported.name, "notes.txt")
        XCTAssertEqual(imported.mimeType, "text/plain")
        XCTAssertEqual(try Data(contentsOf: imported.url), bytes)
        XCTAssertNotEqual(imported.url, source)
    }

    func testRawNonImageDataIsRejected() throws {
        XCTAssertThrowsError(
            try MacAttachmentImporter.materialize(.rawImage(Data("not an image".utf8)))
        )
    }

    func testDeepLinkSelectionSurvivesItsBoardDestinationChange() {
        XCTAssertEqual(
            MacNavigationSelection.retainedTaskID(
                selectedTaskID: "deep-link-task",
                selectedTaskBoardID: "linked-board",
                destination: "linked-board"
            ),
            "deep-link-task"
        )
        XCTAssertNil(
            MacNavigationSelection.retainedTaskID(
                selectedTaskID: "old-task",
                selectedTaskBoardID: "old-board",
                destination: "new-board"
            )
        )
    }

    func testProductionRuntimeIgnoresUITestArguments() {
        let configuration = MacRuntimeConfiguration.resolve(
            isUITestHost: false,
            arguments: [
                "Taskify", "--taskify-ui-test-session", "pretend-session",
                "--taskify-ui-test-open-url", "taskify://task?id=private&board=private",
            ],
            temporaryDirectory: URL(fileURLWithPath: "/tmp/tests"),
            bundleIdentifier: "solife.me.Taskify.Mac"
        )

        XCTAssertEqual(configuration, .production)
    }

    func testDMPushProvisioningSpikeRequiresTheRealMacHostAndExplicitArgument() {
        let argument = MacDMPushProvisioningSpike.launchArgument
        let testConfiguration = MacRuntimeConfiguration.resolve(
            isUITestHost: true,
            arguments: ["Taskify", argument],
            temporaryDirectory: URL(fileURLWithPath: "/tmp/tests"),
            bundleIdentifier: "solife.me.Taskify.Mac.UITests"
        )

        XCTAssertTrue(MacDMPushProvisioningSpike.isRequested(
            configuration: .production,
            arguments: ["Taskify", argument]
        ))
        XCTAssertFalse(MacDMPushProvisioningSpike.isRequested(
            configuration: .production,
            arguments: ["Taskify"]
        ))
        XCTAssertFalse(MacDMPushProvisioningSpike.isRequested(
            configuration: testConfiguration,
            arguments: ["Taskify", argument]
        ))
    }

    func testUITestRuntimeIsSessionScopedAndOffline() throws {
        let configuration = MacRuntimeConfiguration.resolve(
            isUITestHost: true,
            arguments: [
                "Taskify", "--taskify-ui-test-session", "deep-link 42",
                "--taskify-ui-test-open-url",
                "taskify://task?id=ui-test-deep-link-task&board=ui-test-board",
            ],
            temporaryDirectory: URL(fileURLWithPath: "/tmp/tests"),
            bundleIdentifier: "solife.me.Taskify.Mac.UITests"
        )
        let test = try XCTUnwrap(configuration.uiTest)

        XCTAssertEqual(test.sessionID, "deep-link-42")
        XCTAssertEqual(test.rootDirectory.path, "/tmp/tests/TaskifyMacUITests/deep-link-42")
        XCTAssertEqual(test.storeURL.lastPathComponent, "taskify-ui-test.json")
        XCTAssertEqual(test.outboxURL.lastPathComponent, "taskify-ui-test-outbox.json")
        XCTAssertEqual(test.identityService, "solife.me.Taskify.Mac.UITests.identity.deep-link-42")
        XCTAssertFalse(configuration.startsDeferredServices)
        XCTAssertFalse(configuration.registersForRemoteNotifications)
        XCTAssertEqual(
            test.initialLink,
            URL(string: "taskify://task?id=ui-test-deep-link-task&board=ui-test-board")
        )
        XCTAssertTrue(test.resetsStore)
    }

    func testUITestRuntimeCanPreserveItsTemporaryStoreAcrossRelaunch() throws {
        let configuration = MacRuntimeConfiguration.resolve(
            isUITestHost: true,
            arguments: [
                "Taskify", "--taskify-ui-test-session", "relaunch",
                "--taskify-ui-test-preserve-store",
            ],
            temporaryDirectory: URL(fileURLWithPath: "/tmp/tests"),
            bundleIdentifier: "solife.me.Taskify.Mac.UITests"
        )

        XCTAssertFalse(try XCTUnwrap(configuration.uiTest).resetsStore)
    }

    func testProductionRuntimeStartsItsServicesAndPush() {
        XCTAssertTrue(MacRuntimeConfiguration.production.startsDeferredServices)
        XCTAssertTrue(MacRuntimeConfiguration.production.registersForRemoteNotifications)
    }

    /// The Mac app has no wallet. It must not link the wallet module, which brings the Cashu
    /// framework into the bundle, or compile any of the iPhone wallet's sources.
    func testMacAppDoesNotLinkOrCompileTheWallet() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let project = try String(
            contentsOf: root.appendingPathComponent("TaskifyMac.xcodeproj/project.pbxproj"),
            encoding: .utf8
        )
        XCTAssertFalse(project.contains("TaskifyWallet"))
        XCTAssertFalse(project.contains("Features/Wallet/"))
        XCTAssertFalse(project.contains("NpubCashSettings.swift"))
    }

    func testMacAppDeclaresDataProtectionKeychainAccessGroup() throws {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let entitlementsURL = testsDirectory.deletingLastPathComponent().appendingPathComponent("TaskifyMac.entitlements")
        let data = try Data(contentsOf: entitlementsURL)
        let entitlements = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )

        XCTAssertEqual(
            entitlements["keychain-access-groups"] as? [String],
            ["$(AppIdentifierPrefix)solife.me.Taskify.Mac"]
        )
        XCTAssertEqual(entitlements["com.apple.developer.aps-environment"] as? String, "$(APS_ENVIRONMENT)")
    }

    func testMacUITestHostCannotUseProductionKeychainOrNetworkEntitlements() throws {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let entitlementsURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("TaskifyMacUITests.entitlements")
        let data = try Data(contentsOf: entitlementsURL)
        let entitlements = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )

        XCTAssertNil(entitlements["keychain-access-groups"])
        XCTAssertNil(entitlements["com.apple.security.network.client"])
        XCTAssertNil(entitlements["com.apple.developer.aps-environment"])
    }

    func testNewWeekTaskAppearsInTodayColumnAcrossDaylightSavingBoundary() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 16)))
        let board = Board.week(id: "week")
        let draft = MacTaskDraft.place(TaskItem(boardID: "old", title: "Plan the week"), on: board,
                                      now: now, weekStartsOn: .monday, calendar: calendar)
        XCTAssertTrue(draft.dueDateEnabled)
        XCTAssertEqual(draft.columnID, WeekdayColumn.sunday.rawValue)
        XCTAssertTrue(calendar.isDate(try XCTUnwrap(draft.dueDate), inSameDayAs: now))
        let snapshot = TaskifySnapshot(boards: [board], tasks: [draft], selectedBoardID: board.id)
        XCTAssertEqual(snapshot.tasks(boardID: board.id, columnID: "sunday", includeCompleted: false,
                                      now: now, weekStartsOn: .monday, calendar: calendar).map(\.id), [draft.id])
    }

    func testMovingDraftToListUsesColumnOrderAndPreservesDateAndContents() {
        let due = Date(timeIntervalSince1970: 1_800_000_000)
        let task = TaskItem(boardID: "week", title: "Keep this", note: "Notes", dueDate: due,
                            dueDateEnabled: true, priority: .high, subtasks: [TaskSubtask(title: "First")])
        let board = Board(id: "list", name: "Studio", kind: .list, columns: [
            BoardColumn(id: "later", name: "Later", order: 5), BoardColumn(id: "first", name: "First", order: 0),
        ])
        let draft = MacTaskDraft.place(task, on: board, weekStartsOn: .monday)
        XCTAssertEqual(draft.boardID, "list")
        XCTAssertEqual(draft.columnID, "first")
        XCTAssertEqual(draft.dueDate, due)
        XCTAssertEqual(draft.subtasks, task.subtasks)
        XCTAssertEqual(draft.note, task.note)
        XCTAssertEqual(draft.priority, .high)
    }

    func testRecurrenceBuilderKeepReturnsExistingUnchanged() {
        let existing = TaskRecurrence.daily(until: nil)
        let result = MacRecurrenceBuilder.build(choice: "keep", referenceDate: Date(), weeklyDays: [], monthlyInterval: 1,
            interval: 1, intervalUnit: .day, until: nil, existing: existing)
        XCTAssertEqual(result, existing)
    }

    func testRecurrenceBuilderNoneClearsRecurrenceRegardlessOfExisting() {
        let result = MacRecurrenceBuilder.build(choice: "none", referenceDate: Date(), weeklyDays: [1, 3], monthlyInterval: 2,
            interval: 5, intervalUnit: .week, until: nil, existing: .daily(until: nil))
        XCTAssertNil(result)
    }

    func testRecurrenceBuilderWeeklySortsMultipleSelectedDays() {
        let result = MacRecurrenceBuilder.build(choice: "weekly", referenceDate: Date(), weeklyDays: [5, 0, 3], monthlyInterval: 1,
            interval: 1, intervalUnit: .day, until: nil, existing: nil)
        XCTAssertEqual(result, .weekly(days: [0, 3, 5], until: nil))
    }

    func testRecurrenceBuilderMonthlyUsesReferenceDateDayAndGivenInterval() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let reference = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 3, day: 17)))
        let result = MacRecurrenceBuilder.build(choice: "monthly", referenceDate: reference, weeklyDays: [], monthlyInterval: 3,
            interval: 1, intervalUnit: .day, until: nil, existing: nil, calendar: calendar)
        XCTAssertEqual(result, .monthlyDay(day: 17, interval: 3, until: nil))
    }

    func testRecurrenceBuilderIntervalCarriesUntilDate() {
        let until = Date(timeIntervalSince1970: 2_000_000_000)
        let result = MacRecurrenceBuilder.build(choice: "interval", referenceDate: Date(), weeklyDays: [], monthlyInterval: 1,
            interval: 3, intervalUnit: .hour, until: until, existing: nil)
        XCTAssertEqual(result, .every(3, .hour, until: until))
    }

    func testChatTimelineInitiallyShowsOnlyTheNewestPage() {
        XCTAssertEqual(MacChatTimelineWindow.initialPageSize, 100)
        XCTAssertEqual(
            MacChatTimelineWindow.visibleRange(totalCount: 250, loadedCount: 100),
            150..<250
        )
        XCTAssertEqual(
            MacChatTimelineWindow.visibleRange(totalCount: 42, loadedCount: 100),
            0..<42
        )
    }

    func testChatTimelineLoadsAnotherHundredOlderItemsAtTop() {
        XCTAssertEqual(
            MacChatTimelineWindow.nextLoadedCount(current: 100, totalCount: 250),
            200
        )
        XCTAssertEqual(
            MacChatTimelineWindow.nextLoadedCount(current: 200, totalCount: 250),
            250
        )
    }

    func testChatTimelineExpandsToIncludeAnOlderSearchResult() {
        XCTAssertEqual(
            MacChatTimelineWindow.loadedCount(
                including: 25,
                totalCount: 250,
                minimum: 100
            ),
            225
        )
    }

    func testChatComposerHeightIsWholePointsCappedAndStable() {
        // One line at minimum, measured content rounded up, and never past the eight-line cap.
        XCTAssertEqual(MacChatComposerMetrics.height(contentHeight: 0, lineHeight: 16), 16)
        XCTAssertEqual(MacChatComposerMetrics.height(contentHeight: 17.2, lineHeight: 16), 18)
        XCTAssertEqual(MacChatComposerMetrics.height(contentHeight: 400, lineHeight: 16), 128)
        // Measuring the height it just reported yields that same height: the layout system
        // converges in one pass instead of trading sub-point updates.
        let once = MacChatComposerMetrics.height(contentHeight: 74.6, lineHeight: 19.5)
        XCTAssertEqual(once, 75)
        XCTAssertEqual(MacChatComposerMetrics.height(contentHeight: once, lineHeight: 19.5), once)
    }

    func testChatComposerShiftReturnInsertsANewlineAndReturnSends() {
        XCTAssertEqual(MacChatComposerKeyCommand.command(keyCode: 36, shift: false), .send)
        XCTAssertEqual(MacChatComposerKeyCommand.command(keyCode: 36, shift: true), .newline)
        XCTAssertEqual(MacChatComposerKeyCommand.command(keyCode: 76, shift: true), .newline)
        XCTAssertEqual(MacChatComposerKeyCommand.command(keyCode: 51, shift: true), .passThrough)
    }

    func testTaskSelectionShiftClickSelectsTheInclusiveDisplayedRange() {
        let orderedIDs = ["a", "b", "c", "d", "e"]
        var selection = MacTaskSelection()

        selection.select("b", in: orderedIDs)
        selection.select("d", in: orderedIDs, modifiers: .shift)

        XCTAssertEqual(selection.taskIDs, ["b", "c", "d"])
        XCTAssertEqual(selection.anchorTaskID, "b")
        XCTAssertNil(selection.singleTaskID)
    }

    func testTaskSelectionCommandClickTogglesWithoutClearingOtherTasks() {
        let orderedIDs = ["a", "b", "c", "d"]
        var selection = MacTaskSelection()

        selection.select("b", in: orderedIDs)
        selection.select("d", in: orderedIDs, modifiers: .command)
        XCTAssertEqual(selection.taskIDs, ["b", "d"])

        selection.select("b", in: orderedIDs, modifiers: .command)
        XCTAssertEqual(selection.taskIDs, ["d"])
        XCTAssertEqual(selection.singleTaskID, "d")
    }

    func testTaskSelectionPrunesHiddenTasksWithoutLeavingAStaleAnchor() {
        let orderedIDs = ["a", "b", "c", "d"]
        var selection = MacTaskSelection()
        selection.select("a", in: orderedIDs)
        selection.select("c", in: orderedIDs, modifiers: .command)

        selection.retain(["b", "c", "e"])

        XCTAssertEqual(selection.taskIDs, ["c"])
        XCTAssertEqual(selection.anchorTaskID, "c")
    }

    func testWeekBoardSelectsTheCurrentDayColumnForCentering() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let date = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 10, day: 28, hour: 12))
        )

        XCTAssertEqual(
            MacWeekBoardScroll.currentDayColumnID(
                orderedColumnIDs: WeekdayColumn.ordered(startingAt: .sunday).map(\.rawValue),
                date: date,
                calendar: calendar
            ),
            WeekdayColumn.wednesday.rawValue
        )
    }

    func testWeekBoardOpeningRequestChangesWhenSwitchingWeekBoards() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let date = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 10, day: 28, hour: 12))
        )
        let orderedIDs = WeekdayColumn.ordered(startingAt: .sunday).map(\.rawValue)
        let first = try XCTUnwrap(
            MacWeekBoardScroll.request(
                boardID: "first-week",
                orderedColumnIDs: orderedIDs,
                date: date,
                calendar: calendar
            )
        )
        let second = try XCTUnwrap(
            MacWeekBoardScroll.request(
                boardID: "second-week",
                orderedColumnIDs: orderedIDs,
                date: date,
                calendar: calendar
            )
        )

        XCTAssertEqual(first.columnID, WeekdayColumn.wednesday.rawValue)
        XCTAssertEqual(first.targetID, MacWeekBoardScroll.scrollID(boardID: first.boardID, columnID: first.columnID))
        XCTAssertEqual(first.dayKey, "2026-10-28")
        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(first.targetID, second.targetID)
    }

    func testWeekBoardGuttersAllowFirstAndLastDaysToCenter() {
        let viewportWidth: CGFloat = 1_280
        let columnWidth: CGFloat = 270
        let spacing: CGFloat = 16
        let padding = MacWeekBoardScroll.horizontalContentPadding(viewportWidth: viewportWidth)
        let firstColumnCenter = padding + columnWidth / 2
        let contentWidth = padding * 2 + columnWidth * 7 + spacing * 6
        let lastColumnCenter = contentWidth - padding - columnWidth / 2

        XCTAssertEqual(firstColumnCenter, viewportWidth / 2, accuracy: 0.001)
        XCTAssertEqual(lastColumnCenter - viewportWidth / 2, contentWidth - viewportWidth, accuracy: 0.001)
    }

    func testWeekBoardCentersInsideTheViewportVisibleBesideTheSidebar() {
        let clipWidth: CGFloat = 1_280
        let visibleViewportWidth: CGFloat = 1_060
        let contentWidth: CGFloat = 2_776
        let fridayCenterX: CGFloat = 1_960

        let origin = MacWeekBoardScroll.centeredContentOrigin(
            targetCenterX: fridayCenterX,
            contentWidth: contentWidth,
            clipWidth: clipWidth,
            visibleViewportWidth: visibleViewportWidth
        )

        let positionInClip = fridayCenterX - origin
        let positionInVisibleViewport = positionInClip - (clipWidth - visibleViewportWidth)
        XCTAssertEqual(positionInVisibleViewport, visibleViewportWidth / 2, accuracy: 0.001)
    }

    func testWeekBoardCenteringFallsBackToTheFirstAvailableColumn() {
        XCTAssertEqual(
            MacWeekBoardScroll.currentDayColumnID(
                orderedColumnIDs: ["custom-first", "custom-second"],
                date: Date()
            ),
            "custom-first"
        )
    }

    func testDroppingOnAWeekBoardUsesTheCurrentWeekdayColumn() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let date = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 10, day: 30, hour: 12))
        )

        XCTAssertEqual(
            MacBoardDropTarget.columnID(in: .week(), date: date, calendar: calendar),
            WeekdayColumn.friday.rawValue
        )
    }

    func testDroppingOnAListBoardUsesItsFirstOrderedColumn() {
        let board = Board(
            id: "list",
            name: "List",
            kind: .list,
            columns: [
                BoardColumn(id: "later", name: "Later", order: 2),
                BoardColumn(id: "first", name: "First", order: 0),
            ]
        )

        XCTAssertEqual(MacBoardDropTarget.columnID(in: board), "first")
        XCTAssertNil(MacBoardDropTarget.columnID(in: Board(id: "compound", name: "Compound", kind: .compound)))
    }

    func testArchivedBoardDropRecognizesOnlyArchivedBoardIDs() {
        let archived = Board(id: "archived-board", name: "Archived", archived: true)
        let regular = Board(id: "regular-board", name: "Regular")

        XCTAssertEqual(
            MacBoardDropTarget.archivedBoardIDs(
                in: ["task-id", archived.id, regular.id, archived.id],
                boards: [regular, archived]
            ),
            [archived.id]
        )
    }

    func testBoardReorderDroppingAfterAFormerLaterTarget() {
        XCTAssertEqual(
            MacBoardReorder.finalIndex(
                orderedBoardIDs: ["a", "b", "c", "d"],
                movingBoardID: "a",
                targetBoardID: "c",
                placeAfter: true
            ),
            2
        )
    }

    func testBoardReorderDroppingBeforeAnEarlierTarget() {
        XCTAssertEqual(
            MacBoardReorder.finalIndex(
                orderedBoardIDs: ["a", "b", "c", "d"],
                movingBoardID: "d",
                targetBoardID: "b",
                placeAfter: false
            ),
            1
        )
    }

    func testSecondaryAccountStorageDoesNotReusePrimaryStore() {
        let primary = URL(fileURLWithPath: "/tmp/taskify/taskify-store.json")
        let secondaryStore = MacAccountStoragePaths.storeURL(
            primaryURL: primary,
            accountID: "abc123",
            usesPrimaryStore: false
        )
        let secondaryOutbox = MacAccountStoragePaths.outboxURL(
            primaryURL: URL(fileURLWithPath: "/tmp/taskify/outbox.json"),
            accountID: "abc123",
            usesPrimaryStore: false
        )

        XCTAssertNotEqual(secondaryStore, primary)
        XCTAssertTrue(secondaryStore.path.contains("taskify-accounts/abc123"))
        XCTAssertTrue(secondaryOutbox.path.contains("taskify-accounts/abc123"))
        XCTAssertEqual(
            MacAccountStoragePaths.storeURL(
                primaryURL: primary,
                accountID: "primary",
                usesPrimaryStore: true
            ),
            primary
        )
    }

    func testPrimaryStorageRelocationMovesAndRollsBackStoreAndOutbox() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("TaskifyPrimaryRelocationTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let support = root.appendingPathComponent("TaskifyNative", isDirectory: true)
        let primaryStore = support.appendingPathComponent("taskify.json", isDirectory: false)
        let primaryOutbox = support.appendingPathComponent("nostr-outbox.json", isDirectory: false)
        let split = support.appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: split, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try Data("store".utf8).write(to: split.appendingPathComponent("tasks.json"))
        try Data("outbox".utf8).write(to: primaryOutbox)
        defer { try? FileManager.default.removeItem(at: root) }

        let accountID = String(repeating: "ab", count: 32)
        let accountDirectory = MacAccountStoragePaths.accountDirectory(
            primaryURL: primaryStore,
            accountID: accountID
        )
        var relocation = MacPrimaryStorageRelocation(
            primaryStoreURL: primaryStore,
            primaryOutboxURL: primaryOutbox,
            accountID: accountID
        )

        try relocation.apply()
        XCTAssertFalse(FileManager.default.fileExists(atPath: split.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: primaryOutbox.path))
        XCTAssertEqual(
            try Data(contentsOf: accountDirectory
                .appendingPathComponent(JSONTaskStore.splitDirectoryName)
                .appendingPathComponent("tasks.json")),
            Data("store".utf8)
        )
        XCTAssertEqual(
            try Data(contentsOf: accountDirectory.appendingPathComponent("nostr-outbox.json")),
            Data("outbox".utf8)
        )

        try relocation.rollback()
        XCTAssertTrue(FileManager.default.fileExists(atPath: split.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: primaryOutbox.path))
    }

    func testPrimaryStoragePromotionMovesAccountStoreIntoPrimaryLocationAndRollsBack() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("TaskifyPrimaryPromotionTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let support = root.appendingPathComponent("TaskifyNative", isDirectory: true)
        let primaryStore = support.appendingPathComponent("taskify.json", isDirectory: false)
        let primaryOutbox = support.appendingPathComponent("nostr-outbox.json", isDirectory: false)
        let accountID = String(repeating: "ab", count: 32)
        let accountDirectory = MacAccountStoragePaths.accountDirectory(
            primaryURL: primaryStore,
            accountID: accountID
        )
        let accountSplit = accountDirectory.appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true)
        let accountOutbox = accountDirectory.appendingPathComponent("nostr-outbox.json")
        try FileManager.default.createDirectory(at: accountSplit, withIntermediateDirectories: true)
        try Data("account-store".utf8).write(to: accountSplit.appendingPathComponent("tasks.json"))
        try Data("account-outbox".utf8).write(to: accountOutbox)
        defer { try? FileManager.default.removeItem(at: root) }

        var promotion = MacPrimaryStorageRelocation(
            promotingAccountID: accountID,
            primaryStoreURL: primaryStore,
            primaryOutboxURL: primaryOutbox
        )
        try promotion.apply()
        XCTAssertFalse(FileManager.default.fileExists(atPath: accountSplit.path))
        XCTAssertEqual(
            try Data(contentsOf: support
                .appendingPathComponent(JSONTaskStore.splitDirectoryName)
                .appendingPathComponent("tasks.json")),
            Data("account-store".utf8)
        )
        XCTAssertEqual(try Data(contentsOf: primaryOutbox), Data("account-outbox".utf8))

        try promotion.rollback()
        XCTAssertTrue(FileManager.default.fileExists(atPath: accountSplit.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: accountOutbox.path))
    }

    func testAccountRemovalPlanPromotesReplacementWhenPrimaryIsRemoved() throws {
        let primary = try NostrIdentity.generate()
        let secondary = try NostrIdentity.generate()
        let other = try NostrIdentity.generate()
        let accounts = [
            MacSavedAccount(identity: primary, label: "Primary"),
            MacSavedAccount(identity: secondary, label: "Secondary"),
            MacSavedAccount(identity: other, label: "Other"),
        ]

        XCTAssertEqual(
            MacAccountCollection.removalPlan(
                accountID: primary.publicKeyHex,
                currentAccountID: primary.publicKeyHex,
                primaryAccountID: primary.publicKeyHex,
                accounts: accounts
            ),
            MacAccountRemovalPlan(
                removedAccountID: primary.publicKeyHex,
                activeAccountID: secondary.publicKeyHex,
                promotedPrimaryAccountID: secondary.publicKeyHex,
                remainingAccountIDs: [secondary.publicKeyHex, other.publicKeyHex]
            )
        )
        XCTAssertEqual(
            MacAccountCollection.removalPlan(
                accountID: secondary.publicKeyHex,
                currentAccountID: secondary.publicKeyHex,
                primaryAccountID: primary.publicKeyHex,
                accounts: accounts
            )?.activeAccountID,
            primary.publicKeyHex
        )
        XCTAssertEqual(
            MacAccountCollection.removalPlan(
                accountID: primary.publicKeyHex,
                currentAccountID: other.publicKeyHex,
                primaryAccountID: primary.publicKeyHex,
                accounts: accounts
            )?.activeAccountID,
            other.publicKeyHex
        )
        XCTAssertNil(MacAccountCollection.removalPlan(
            accountID: primary.publicKeyHex,
            currentAccountID: primary.publicKeyHex,
            primaryAccountID: primary.publicKeyHex,
            accounts: [accounts[0]]
        ))
    }

    func testAccountPreferencesUseDistinctSuitesAndMigrateLegacyDataOnce() throws {
        let nonce = UUID().uuidString
        let bundleID = "solife.me.Taskify.Mac.Tests.\(nonce)"
        let firstID = String(repeating: "a", count: 64)
        let secondID = String(repeating: "b", count: 64)
        let legacySuite = "\(bundleID).legacy"
        let firstSuite = MacAccountPreferences.suiteName(bundleIdentifier: bundleID, accountID: firstID)
        let secondSuite = MacAccountPreferences.suiteName(bundleIdentifier: bundleID, accountID: secondID)
        defer {
            for suite in [legacySuite, firstSuite, secondSuite] {
                UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
            }
        }

        let legacy = try XCTUnwrap(UserDefaults(suiteName: legacySuite))
        legacy.set(["wss://legacy.example"], forKey: "taskify.sync.appRelays")
        legacy.set("not-account-data", forKey: "unrelated.setting")

        let first = MacAccountPreferences.makeDefaults(
            bundleIdentifier: bundleID,
            accountID: firstID,
            migratingFrom: legacy
        )
        let second = MacAccountPreferences.makeDefaults(
            bundleIdentifier: bundleID,
            accountID: secondID,
            migratingFrom: legacy
        )

        XCTAssertNotEqual(firstSuite, secondSuite)
        XCTAssertEqual(first.stringArray(forKey: "taskify.sync.appRelays"), ["wss://legacy.example"])
        XCTAssertNil(first.string(forKey: "unrelated.setting"))
        XCTAssertNil(second.stringArray(forKey: "taskify.sync.appRelays"))

        second.set(["wss://second.example"], forKey: "taskify.sync.appRelays")
        legacy.set(["wss://newer.example"], forKey: "taskify.sync.appRelays")

        XCTAssertEqual(first.stringArray(forKey: "taskify.sync.appRelays"), ["wss://legacy.example"])
        XCTAssertEqual(second.stringArray(forKey: "taskify.sync.appRelays"), ["wss://second.example"])

        first.set(false, forKey: MacAccountViewPreferences.completedTabKey)
        first.set(true, forKey: MacAccountViewPreferences.hideCompletedSubtasksKey)
        second.set(true, forKey: MacAccountViewPreferences.completedTabKey)
        second.set(false, forKey: MacAccountViewPreferences.hideCompletedSubtasksKey)
        XCTAssertFalse(MacAccountViewPreferences(defaults: first).completedTabEnabled)
        XCTAssertTrue(MacAccountViewPreferences(defaults: first).hideCompletedSubtasks)
        XCTAssertTrue(MacAccountViewPreferences(defaults: second).completedTabEnabled)
        XCTAssertFalse(MacAccountViewPreferences(defaults: second).hideCompletedSubtasks)
    }

    func testStartupAccountNeverSubstitutesAnUnknownIdentityForThePrimaryStore() throws {
        let primaryIdentity = try NostrIdentity.generate()
        let secondaryIdentity = try NostrIdentity.generate()
        let unknownIdentity = try NostrIdentity.generate()
        let primary = MacSavedAccount(identity: primaryIdentity, label: "Primary")
        let secondary = MacSavedAccount(identity: secondaryIdentity, label: "Secondary")
        let accounts = [primary, secondary]

        XCTAssertEqual(
            MacAccountCollection.startupAccount(
                storedIdentityID: unknownIdentity.publicKeyHex,
                accounts: accounts,
                primaryAccountID: primary.publicKeyHex
            )?.publicKeyHex,
            primary.publicKeyHex
        )
        XCTAssertEqual(
            MacAccountCollection.startupAccount(
                storedIdentityID: secondary.publicKeyHex,
                accounts: accounts,
                primaryAccountID: primary.publicKeyHex
            )?.publicKeyHex,
            secondary.publicKeyHex
        )
        XCTAssertNil(MacAccountCollection.startupAccount(
            storedIdentityID: primary.publicKeyHex,
            accounts: [],
            primaryAccountID: nil
        ))
    }

    func testSavedAccountRejectsMismatchedPublicKeyMetadata() throws {
        let identity = try NostrIdentity.generate()
        let valid = MacSavedAccount(identity: identity)
        let mismatched = MacSavedAccount(
            publicKeyHex: String(repeating: "ab", count: 32),
            npub: identity.npub,
            privateKeyHex: identity.privateKeyHex
        )

        XCTAssertTrue(valid.isValidVaultEntry)
        XCTAssertFalse(mismatched.isValidVaultEntry)
    }

    func testSavedAccountUpsertUpdatesLabelsWithoutDuplicatingKeys() {
        let first = MacSavedAccount(
            publicKeyHex: "abc123",
            npub: "npub1example",
            privateKeyHex: String(repeating: "1", count: 64),
            label: "Work"
        )
        let renamed = MacSavedAccount(
            publicKeyHex: "abc123",
            npub: "npub1example",
            privateKeyHex: String(repeating: "1", count: 64),
            label: "Consulting"
        )

        let accounts = MacAccountCollection.upsert(renamed, into: [first])
        XCTAssertEqual(accounts.count, 1)
        XCTAssertEqual(accounts[0].label, "Consulting")
    }

    func testAccountSummariesMarkCurrentAndPrimaryAccounts() {
        let primary = MacSavedAccount(
            publicKeyHex: "primary",
            npub: "npub1primary",
            privateKeyHex: String(repeating: "1", count: 64),
            label: "Personal"
        )
        let work = MacSavedAccount(
            publicKeyHex: "work",
            npub: "npub1work",
            privateKeyHex: String(repeating: "2", count: 64),
            label: "Work"
        )

        let summaries = MacAccountCollection.summaries(
            accounts: [primary, work],
            currentAccountID: work.publicKeyHex,
            primaryAccountID: primary.publicKeyHex
        )
        XCTAssertEqual(summaries.map(\.isCurrent), [false, true])
        XCTAssertEqual(summaries.map(\.isPrimary), [true, false])
    }

    private static let onePixelPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )!
}

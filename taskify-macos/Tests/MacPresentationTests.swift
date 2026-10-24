import CoreTransferable
import XCTest
import TaskifyCore
import TaskifyWallet
@testable import MacPresentation

final class MacPresentationTests: XCTestCase {
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
        XCTAssertFalse(configuration.startPlan(isWalletRecoveryMode: false).startsWallet)
        XCTAssertEqual(
            test.initialLink,
            URL(string: "taskify://task?id=ui-test-deep-link-task&board=ui-test-board")
        )
        XCTAssertTrue(test.resetsStore)
        XCTAssertFalse(test.walletRecoveryPreview)
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

    @MainActor
    func testRecoveryModeProductionRuntimeNeverCallsWalletStart() async {
        let plan = MacRuntimeConfiguration.production.startPlan(isWalletRecoveryMode: true)
        var deferredServiceStarts = 0
        var walletStarts = 0

        await MacRuntimeStartExecutor.run(
            plan: plan,
            startDeferredServices: { deferredServiceStarts += 1 },
            startWallet: { walletStarts += 1 }
        )

        XCTAssertTrue(plan.startsDeferredServices)
        XCTAssertFalse(plan.startsWallet)
        XCTAssertEqual(deferredServiceStarts, 1)
        XCTAssertEqual(walletStarts, 0)
    }

    func testWalletRemovalPreviewIsExplicitlyPassedToTheIsolatedHost() throws {
        let configuration = MacRuntimeConfiguration.resolve(
            isUITestHost: true,
            arguments: [
                "Taskify", "--taskify-ui-test-session", "wallet-recovery",
                "--taskify-ui-test-wallet-recovery",
            ],
            temporaryDirectory: URL(fileURLWithPath: "/tmp/tests"),
            bundleIdentifier: "solife.me.Taskify.Mac.UITests"
        )

        XCTAssertTrue(try XCTUnwrap(configuration.uiTest).walletRecoveryPreview)
    }

    func testUITestRuntimeCanShowTheLiveWalletWithoutRecoveryPreview() throws {
        let configuration = MacRuntimeConfiguration.resolve(
            isUITestHost: true,
            arguments: [
                "Taskify", "--taskify-ui-test-session", "live-wallet",
                "--taskify-ui-test-wallet-enabled",
            ],
            temporaryDirectory: URL(fileURLWithPath: "/tmp/tests"),
            bundleIdentifier: "solife.me.Taskify.Mac.UITests"
        )
        let test = try XCTUnwrap(configuration.uiTest)

        XCTAssertTrue(test.walletEnabled)
        XCTAssertFalse(test.walletRecoveryPreview)
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

    func testPendingLightningIsNotPresentedAsPaid() {
        let payment = CashuLightningPaymentResult(quoteID: "quote", mintURL: "https://mint.example", amount: 100,
                                                  feePaid: nil, preimage: nil, state: .pending)
        let outcome = MacWalletOutcome(payment: payment)
        XCTAssertEqual(outcome, .paymentPending)
        XCTAssertTrue(outcome.isPending)
        XCTAssertNotEqual(outcome, .paid)
    }

    func testQueuedAndPreviouslyReceivedTokensAreNotPresentedAsNewReceipts() {
        let queued = CashuPendingReceive(id: "receive", token: "fixture", mintURL: "https://mint.example",
                                         amount: 100, memo: nil, createdAt: Date())
        XCTAssertEqual(MacWalletOutcome(receive: .queued(queued)), .receiveQueued)
        XCTAssertTrue(MacWalletOutcome(receive: .queued(queued)).isPending)
        XCTAssertEqual(MacWalletOutcome(receive: .alreadyReceived(100)), .alreadyReceived)
        XCTAssertNotEqual(MacWalletOutcome(receive: .alreadyReceived(100)), .received(100))
        XCTAssertEqual(MacWalletOutcome(receive: .received(100)), .received(100))
    }
    @MainActor
    func testRecoveryUsesModeConfirmedBeforeAuthentication() async throws {
        var replace = false
        var executedReplacement: Bool?
        try await macAuthenticatedRecovery(replace: replace, authenticate: {
            replace = true
        }, recover: { executedReplacement = $0 })
        XCTAssertEqual(executedReplacement, false)
    }

    func testPaymentRequestMintSelectionPrefersOverlapWithWallet() {
        let result = MacPaymentRequestMintSelection.candidates(requestedMintURLs: ["a", "b"], walletMintURLs: ["b", "c"])
        XCTAssertEqual(result, ["b"])
    }

    func testPaymentRequestMintSelectionFallsBackToWalletMintsWhenNoOverlap() {
        let result = MacPaymentRequestMintSelection.candidates(requestedMintURLs: ["a"], walletMintURLs: ["b", "c"])
        XCTAssertEqual(result, ["b", "c"])
    }

    func testPaymentRequestMintSelectionFallsBackToWalletMintsWhenRequestNamesNone() {
        let result = MacPaymentRequestMintSelection.candidates(requestedMintURLs: [], walletMintURLs: ["b", "c"])
        XCTAssertEqual(result, ["b", "c"])
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

    private static let onePixelPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )!
}

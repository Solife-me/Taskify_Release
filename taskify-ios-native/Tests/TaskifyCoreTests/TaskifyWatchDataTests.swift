import Foundation
import XCTest
@testable import TaskifyCore
import TaskifyWatchShared

final class TaskifyWatchDataTests: XCTestCase {
    func testSetupNavigationRequestHasAnExplicitTypedMarker() {
        XCTAssertTrue(
            TaskifyWatchTransfer.isSetupNavigationRequest(
                TaskifyWatchTransfer.setupNavigationRequest
            )
        )
        XCTAssertFalse(
            TaskifyWatchTransfer.isSetupNavigationRequest([
                TaskifyWatchTransfer.setupNavigationRequestKey: false,
            ])
        )
        XCTAssertFalse(TaskifyWatchTransfer.isSetupNavigationRequest([:]))
    }

    func testSnapshotRequestHasAnExplicitTypedMarker() {
        XCTAssertTrue(
            TaskifyWatchTransfer.isSnapshotRequest(TaskifyWatchTransfer.snapshotRequest)
        )
        XCTAssertFalse(TaskifyWatchTransfer.isSnapshotRequest([
            TaskifyWatchTransfer.requestSnapshotKey: false,
        ]))
        XCTAssertFalse(TaskifyWatchTransfer.isSnapshotRequest([:]))
    }

    func testProvisioningStatusRoundTripsOnlyAValidPublicKey() {
        let publicKey = String(repeating: "a", count: 64)
        XCTAssertTrue(
            TaskifyWatchTransfer.isProvisioningStatusRequest(
                TaskifyWatchTransfer.provisioningStatusRequest
            )
        )
        XCTAssertEqual(
            TaskifyWatchTransfer.provisioningStatusPublicKey(
                TaskifyWatchTransfer.provisioningStatusResponse(publicKeyHex: publicKey.uppercased())
            ),
            publicKey
        )
        XCTAssertNil(
            TaskifyWatchTransfer.provisioningStatusPublicKey([
                TaskifyWatchTransfer.provisioningStatusPublicKeyKey: "not-a-key",
            ])
        )
    }

    func testChatReadUpdateValidatesAndNormalizesItsConversation() throws {
        let conversationID = String(repeating: "A", count: 64)
        let update = try XCTUnwrap(TaskifyWatchTransfer.chatReadUpdate(
            conversationID: conversationID,
            through: 1_786_000_000
        ))
        let decoded = try XCTUnwrap(TaskifyWatchTransfer.chatReadUpdate(from: update))

        XCTAssertEqual(decoded.conversationID, conversationID.lowercased())
        XCTAssertEqual(decoded.timestamp, 1_786_000_000)
        XCTAssertNil(TaskifyWatchTransfer.chatReadUpdate(
            conversationID: "not-a-conversation",
            through: 1_786_000_000
        ))
        XCTAssertNil(TaskifyWatchTransfer.chatReadUpdate(from: [
            TaskifyWatchTransfer.chatReadConversationIDKey: conversationID,
            TaskifyWatchTransfer.chatReadThroughKey: 0,
        ]))
    }

    func testChatDirectoryRequestHasAnExplicitTypedMarker() {
        XCTAssertTrue(
            TaskifyWatchTransfer.isChatDirectoryRequest(TaskifyWatchTransfer.chatDirectoryRequest)
        )
        XCTAssertFalse(TaskifyWatchTransfer.isChatDirectoryRequest([
            TaskifyWatchTransfer.chatDirectoryRequestKey: false,
        ]))
        XCTAssertFalse(TaskifyWatchTransfer.isChatDirectoryRequest([:]))
    }

    func testConnectivitySnapshotCarriesADirectoryProjectionWithTombstones() throws {
        let account = String(repeating: "a", count: 64)
        let summaries = (0..<TaskifyWatchChatProjection.maximumThreadCount).map { index in
            TaskifyWatchChatThreadSummary(
                conversationID: String(format: "%064x", 10_000 + index),
                memberPublicKeys: [account, String(format: "%064x", index + 1)],
                displayName: "Conversation \(index)",
                latestPreview: "Preview \(index)",
                latestActivityAt: 2_000 + index,
                readThrough: 1_900 + index,
                unreadCount: index % 4,
                isRequest: false
            )!
        }
        let contacts = (0..<TaskifyWatchChatProjection.maximumContactCount).map { index in
            TaskifyWatchContact(
                publicKey: String(format: "%064x", 20_000 + index),
                npub: "",
                displayName: "Contact \(index)"
            )
        }
        let deleted = (0..<200).map { String(format: "%064x", 30_000 + $0) }
        let blocked = (0..<50).map { String(format: "%064x", 40_000 + $0) }
        let projection = TaskifyWatchChatProjection(
            threads: summaries,
            accountPublicKey: account,
            contacts: contacts,
            deletedConversationIDs: deleted,
            blockedPublicKeys: blocked,
            generatedAt: now
        )
        // A directory reply carries no task payload, so the whole transport budget is chat.
        let snapshot = TaskifyWatchSnapshot(
            boards: [TaskifyWatchBoard(id: "work", name: "Work", openTaskCount: 0)],
            selectedBoardID: "work",
            generatedAt: now,
            chatProjection: projection
        )

        let data = try TaskifyWatchTransfer.encodeConnectivitySnapshot(snapshot)
        let decoded = try TaskifyWatchTransfer.decodeConnectivitySnapshot(data)

        XCTAssertLessThanOrEqual(data.count, 48 * 1_024)
        XCTAssertTrue(decoded.tasks.isEmpty)
        XCTAssertEqual(decoded.chatProjection?.threads, projection.threads)
        XCTAssertEqual(decoded.chatProjection?.contacts, projection.contacts)
        XCTAssertEqual(decoded.chatProjection?.deletedConversationIDs, deleted)
        XCTAssertEqual(decoded.chatProjection?.blockedPublicKeys, blocked)

        // Even when a tight budget forces thread trimming, tombstones survive: they are the
        // only path phone-side deletions and blocks have to the Watch cache.
        let trimmedData = try TaskifyWatchTransfer.encodeConnectivitySnapshot(
            snapshot, maximumBytes: 6_000
        )
        let trimmed = try TaskifyWatchTransfer.decodeConnectivitySnapshot(trimmedData)
        XCTAssertLessThanOrEqual(trimmedData.count, 6_000)
        XCTAssertEqual(trimmed.chatProjection?.deletedConversationIDs, deleted)
        XCTAssertEqual(trimmed.chatProjection?.blockedPublicKeys, blocked)
    }

    func testChatProjectionDecodesPayloadsWrittenBeforeTombstoneFields() throws {
        let account = String(repeating: "a", count: 64)
        let peer = String(repeating: "c", count: 64)
        let summary = TaskifyWatchChatThreadSummary(
            conversationID: peer,
            memberPublicKeys: [account, peer],
            displayName: "Peer",
            latestPreview: "From phone",
            latestActivityAt: 2_000,
            unreadCount: 1,
            isRequest: false
        )!
        let projection = TaskifyWatchChatProjection(
            threads: [summary],
            accountPublicKey: account,
            deletedConversationIDs: [peer],
            blockedPublicKeys: [peer],
            generatedAt: now
        )
        var payload = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(projection))
                as? [String: Any]
        )
        payload.removeValue(forKey: "deletedConversationIDs")
        payload.removeValue(forKey: "blockedPublicKeys")
        let legacy = try JSONSerialization.data(withJSONObject: payload)

        let decoded = try JSONDecoder().decode(TaskifyWatchChatProjection.self, from: legacy)

        XCTAssertNil(decoded.deletedConversationIDs)
        XCTAssertNil(decoded.blockedPublicKeys)
        XCTAssertEqual(decoded.threads.first?.conversationID, peer)
        XCTAssertEqual(decoded.accountPublicKey, account)
    }

    private let now = Date(timeIntervalSince1970: 1_785_945_600) // 2026-08-06 12:00 UTC

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    func testWatchSnapshotContainsCurrentOpenTasksAndBoardContext() {
        let work = Board(
            id: "work",
            name: "Work",
            kind: .list,
            columns: [BoardColumn(id: "inbox", name: "Inbox", order: 0)]
        )
        let personal = Board.week(id: "personal", name: "Personal")
        let snapshot = TaskifySnapshot(
            boards: [work, personal],
            tasks: [
                TaskItem(
                    id: "today",
                    boardID: work.id,
                    title: "Daily standup",
                    dueDate: now.addingTimeInterval(3600),
                    dueDateEnabled: true,
                    dueTimeEnabled: true,
                    priority: .high,
                    order: 1,
                    columnID: "inbox"
                ),
                TaskItem(
                    id: "undated",
                    boardID: work.id,
                    title: "Write proposal",
                    order: 2,
                    columnID: "inbox"
                ),
                TaskItem(
                    id: "done",
                    boardID: personal.id,
                    title: "Already done",
                    completed: true
                ),
                TaskItem(
                    id: "hidden",
                    boardID: personal.id,
                    title: "Not revealed",
                    hiddenUntilDate: now.addingTimeInterval(86_400)
                ),
            ],
            selectedBoardID: work.id
        )

        let watch = snapshot.watchData(now: now, calendar: calendar)

        XCTAssertEqual(watch.tasks.map(\.id), ["today", "undated"])
        XCTAssertEqual(watch.tasks.first?.boardName, "Work")
        XCTAssertEqual(watch.tasks.first?.columnName, "Inbox")
        XCTAssertEqual(watch.tasks.first?.priority, TaskPriority.high.rawValue)
        XCTAssertEqual(watch.tasks.first?.columnID, "inbox")
        XCTAssertEqual(watch.tasks.first?.nostrBoardID, work.effectiveNostrBoardID)
        XCTAssertFalse(watch.tasks.first?.syncPayload?.isEmpty ?? true)
        XCTAssertEqual(watch.todayTasks(now: now, calendar: calendar).map(\.id), ["today"])
        XCTAssertEqual(watch.boards.map(\.name), ["Work", "Personal"])
        XCTAssertEqual(watch.boards.map(\.openTaskCount), [2, 0])
        XCTAssertEqual(watch.boards.first?.kind, BoardKind.list.rawValue)
        XCTAssertEqual(watch.boards.first?.defaultColumnID, "inbox")
        XCTAssertEqual(watch.selectedBoardID, work.id)
    }

    func testWatchSnapshotUsesAStableBoundedTaskOrder() {
        let board = Board(
            id: "board",
            name: "Work",
            kind: .list,
            columns: [BoardColumn(id: "inbox", name: "Inbox", order: 0)]
        )
        let tasks = [
            TaskItem(
                id: "undated",
                boardID: board.id,
                title: "Undated",
                createdAt: now.addingTimeInterval(-100),
                order: 0,
                columnID: "inbox"
            ),
            TaskItem(
                id: "later",
                boardID: board.id,
                title: "Later",
                dueDate: now.addingTimeInterval(7200),
                dueDateEnabled: true,
                createdAt: now.addingTimeInterval(-200),
                order: 2,
                columnID: "inbox"
            ),
            TaskItem(
                id: "sooner",
                boardID: board.id,
                title: "Sooner",
                dueDate: now.addingTimeInterval(3600),
                dueDateEnabled: true,
                createdAt: now.addingTimeInterval(-300),
                order: 1,
                columnID: "inbox"
            ),
        ]
        let snapshot = TaskifySnapshot(boards: [board], tasks: tasks, selectedBoardID: board.id)

        XCTAssertEqual(
            snapshot.watchData(now: now, calendar: calendar, taskLimit: 2).tasks.map(\.id),
            ["sooner", "later"]
        )
    }

    func testWatchBoardCountsIncludeEligibleTasksBeyondTheTransferLimit() {
        let first = Board(
            id: "first",
            name: "First",
            kind: .list,
            columns: [BoardColumn(id: "inbox", name: "Inbox", order: 0)]
        )
        let second = Board(
            id: "second",
            name: "Second",
            kind: .list,
            columns: [BoardColumn(id: "inbox", name: "Inbox", order: 0)]
        )
        let tasks = (0..<30).map { index in
            TaskItem(
                id: "task-\(index)",
                boardID: index < 20 ? first.id : second.id,
                title: "Task \(index)",
                order: index,
                columnID: "inbox"
            )
        }
        let snapshot = TaskifySnapshot(
            boards: [first, second],
            tasks: tasks,
            selectedBoardID: first.id
        )

        let watch = snapshot.watchData(now: now, calendar: calendar, taskLimit: 5)

        XCTAssertEqual(watch.tasks.count, 5)
        XCTAssertEqual(watch.boards.map(\.openTaskCount), [20, 10])
    }

    func testWatchSnapshotPreservesTheIPhoneBoardOrder() {
        var first = Board.week(id: "first", name: "First on iPhone")
        first.createdAt = now
        var second = Board.week(id: "second", name: "Second on iPhone")
        second.createdAt = now.addingTimeInterval(-86_400)
        let snapshot = TaskifySnapshot(
            boards: [first, second],
            tasks: [],
            selectedBoardID: first.id
        )

        XCTAssertEqual(snapshot.watchData(now: now).boards.map(\.id), ["first", "second"])
    }

    func testConnectivitySnapshotCompressionRoundTripsAndReadsLegacyPayloads() throws {
        let accent = TaskifyWatchAccent(
            red: 201,
            green: 111,
            blue: 92,
            foregroundRed: 6,
            foregroundGreen: 20,
            foregroundBlue: 40
        )
        let snapshot = TaskifyWatchSnapshot(
            tasks: [
                TaskifyWatchTask(
                    id: "task",
                    title: "Review the proposal",
                    boardID: "work",
                    boardName: "Work",
                    columnName: "Inbox",
                    dueDate: now,
                    dueTimeEnabled: true,
                    priority: 2,
                    order: 1,
                    syncPayload: Data(repeating: 0x41, count: 2_048)
                ),
            ],
            boards: [TaskifyWatchBoard(id: "work", name: "Work", openTaskCount: 1)],
            selectedBoardID: "work",
            generatedAt: now,
            acknowledgedCommandIDs: ["command"],
            accent: accent
        )

        let connectivityData = try TaskifyWatchTransfer.encodeConnectivitySnapshot(snapshot)
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeConnectivitySnapshot(connectivityData),
            snapshot
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeConnectivitySnapshot(connectivityData).accent,
            accent
        )

        let legacyData = try TaskifyWatchTransfer.encode(snapshot)
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeConnectivitySnapshot(legacyData),
            snapshot
        )
    }

    func testConnectivitySnapshotTrimsTrailingTasksToStayInsideTransportBudget() throws {
        let board = TaskifyWatchBoard(id: "work", name: "Work", openTaskCount: 80)
        let tasks = (0..<80).map { index in
            TaskifyWatchTask(
                id: "task-\(index)",
                title: "Task \(index)",
                boardID: board.id,
                boardName: board.name,
                columnName: "Inbox",
                dueDate: now.addingTimeInterval(TimeInterval(index * 60)),
                dueTimeEnabled: true,
                priority: nil,
                order: index,
                syncPayload: deterministicPayload(seed: UInt64(index + 1), count: 1_024)
            )
        }
        let snapshot = TaskifyWatchSnapshot(
            tasks: tasks,
            boards: [board],
            selectedBoardID: board.id,
            generatedAt: now
        )

        let data = try TaskifyWatchTransfer.encodeConnectivitySnapshot(snapshot, maximumBytes: 8_000)
        let decoded = try TaskifyWatchTransfer.decodeConnectivitySnapshot(data)

        XCTAssertLessThanOrEqual(data.count, 8_000)
        XCTAssertFalse(decoded.tasks.isEmpty)
        XCTAssertLessThan(decoded.tasks.count, tasks.count)
        XCTAssertEqual(decoded.tasks, Array(tasks.prefix(decoded.tasks.count)))
        XCTAssertEqual(decoded.boards, [board])
    }

    func testConnectivitySnapshotRetainsNewestChatThreadsWithinTransportBudget() throws {
        let account = String(repeating: "a", count: 64)
        let summaries = (0..<100).map { index in
            TaskifyWatchChatThreadSummary(
                conversationID: String(format: "%064x", 10_000 + index),
                memberPublicKeys: [account, String(format: "%064x", index + 1)],
                displayName: "Conversation \(index)",
                latestPreview: deterministicPayload(
                    seed: UInt64(index + 100),
                    count: 180
                ).base64EncodedString(),
                latestActivityAt: 2_000 + index,
                readThrough: 1_900 + index,
                unreadCount: index % 4,
                isRequest: false
            )!
        }
        let contacts = (0..<TaskifyWatchChatProjection.maximumContactCount).map { index in
            TaskifyWatchContact(
                publicKey: String(format: "%064x", 20_000 + index),
                npub: deterministicPayload(
                    seed: UInt64(index + 500),
                    count: 48
                ).base64EncodedString(),
                displayName: "Contact \(index)",
                discoveryRelayURLs: ["wss://relay\(index).example.com"]
            )
        }
        let projection = TaskifyWatchChatProjection(
            threads: summaries,
            accountPublicKey: account,
            contacts: contacts,
            discoveryRelayURLs: ["wss://relay.example.com"],
            pushRelayHTTPSURL: URL(string: "https://push.example.com"),
            pushRelayWSSURL: "wss://push.example.com",
            generatedAt: now
        )
        let snapshot = TaskifyWatchSnapshot(
            boards: [TaskifyWatchBoard(id: "work", name: "Work", openTaskCount: 0)],
            selectedBoardID: "work",
            generatedAt: now,
            chatProjection: projection
        )

        let data = try TaskifyWatchTransfer.encodeConnectivitySnapshot(
            snapshot,
            maximumBytes: 4_000
        )
        let decoded = try TaskifyWatchTransfer.decodeConnectivitySnapshot(data)
        let retained = try XCTUnwrap(decoded.chatProjection?.threads)

        XCTAssertLessThanOrEqual(data.count, 4_000)
        XCTAssertFalse(retained.isEmpty)
        XCTAssertLessThan(retained.count, projection.threads.count)
        XCTAssertEqual(retained, Array(projection.threads.prefix(retained.count)))
        XCTAssertNil(decoded.chatProjection?.contacts)
        XCTAssertEqual(decoded.chatProjection?.accountPublicKey, account)
        XCTAssertEqual(
            decoded.chatProjection?.discoveryRelayURLs,
            ["wss://relay.example.com"]
        )
        XCTAssertEqual(
            decoded.chatProjection?.pushRelayHTTPSURL,
            URL(string: "https://push.example.com")
        )
        XCTAssertEqual(decoded.chatProjection?.pushRelayWSSURL, "wss://push.example.com")
    }

    func testWatchWidgetSnapshotContainsOnlyGlanceableComplicationData() {
        let widgetSource = TaskifyWatchSnapshot(
            tasks: [
                TaskifyWatchTask(
                    id: "earlier",
                    title: "Morning task",
                    boardID: "board",
                    boardName: "Work",
                    columnName: "Inbox",
                    dueDate: now.addingTimeInterval(-3_600),
                    dueTimeEnabled: true,
                    priority: 2,
                    order: 1,
                    syncPayload: Data("private board payload".utf8)
                ),
                TaskifyWatchTask(
                    id: "later",
                    title: "Afternoon task",
                    boardID: "board",
                    boardName: "Work",
                    columnName: "Inbox",
                    dueDate: now.addingTimeInterval(3_600),
                    dueTimeEnabled: true,
                    priority: nil,
                    order: 2
                ),
                TaskifyWatchTask(
                    id: "tomorrow",
                    title: "Tomorrow task",
                    boardID: "board",
                    boardName: "Work",
                    columnName: "Inbox",
                    dueDate: now.addingTimeInterval(86_400),
                    dueTimeEnabled: false,
                    priority: nil,
                    order: 3
                ),
            ],
            generatedAt: now
        )

        let widget = TaskifyWatchWidgetSnapshot(
            snapshot: widgetSource,
            excludingTaskIDs: ["earlier"]
        )

        XCTAssertEqual(widget.tasks.map(\.id), ["later", "tomorrow"])
        XCTAssertEqual(widget.tasks.first?.boardName, "Work")
        XCTAssertEqual(widget.todayTasks(now: now, calendar: calendar).map(\.id), ["later"])
        XCTAssertEqual(
            widget.upcomingTasks(now: now, calendar: calendar).map(\.id),
            ["later", "tomorrow"]
        )
        XCTAssertEqual(
            TaskifyWatchWidgetCache.widgetKinds,
            [
                TaskifyWatchWidgetCache.todayWidgetKind,
                TaskifyWatchWidgetCache.upcomingWidgetKind,
            ]
        )
    }

    func testWatchWidgetUpcomingExcludesPriorDaysAndSortsByDateThenTitle() {
        let startOfToday = calendar.startOfDay(for: now)
        let sameFutureDate = now.addingTimeInterval(2 * 86_400)
        let widget = TaskifyWatchWidgetSnapshot(tasks: [
            TaskifyWatchWidgetTask(
                id: "past",
                title: "Past task",
                boardName: "Work",
                dueDate: startOfToday.addingTimeInterval(-1)
            ),
            TaskifyWatchWidgetTask(
                id: "beta",
                title: "Beta",
                boardName: "Work",
                dueDate: sameFutureDate
            ),
            TaskifyWatchWidgetTask(
                id: "today",
                title: "Today",
                boardName: "Personal",
                dueDate: now
            ),
            TaskifyWatchWidgetTask(
                id: "alpha",
                title: "Alpha",
                boardName: "Work",
                dueDate: sameFutureDate
            ),
            TaskifyWatchWidgetTask(
                id: "undated",
                title: "Undated",
                boardName: "Personal",
                dueDate: nil
            ),
        ])

        XCTAssertEqual(
            widget.upcomingTasks(now: now, calendar: calendar).map(\.id),
            ["today", "alpha", "beta"]
        )
    }

    private func deterministicPayload(seed: UInt64, count: Int) -> Data {
        var state = seed
        var bytes = [UInt8]()
        bytes.reserveCapacity(count)
        for _ in 0..<count {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            bytes.append(UInt8(truncatingIfNeeded: state >> 24))
        }
        return Data(bytes)
    }

    func testWatchTransferRoundTripsSnapshotsAndCommands() throws {
        let snapshot = TaskifyWatchSnapshot(
            tasks: [
                TaskifyWatchTask(
                    id: "task",
                    title: "Call Sam",
                    boardID: "board",
                    boardName: "Work",
                    columnName: "Inbox",
                    dueDate: now,
                    dueTimeEnabled: true,
                    priority: 2,
                    order: 0
                ),
            ],
            boards: [TaskifyWatchBoard(id: "board", name: "Work", openTaskCount: 1)],
            selectedBoardID: "board",
            generatedAt: now
        )
        let command = TaskifyWatchCommand(
            id: "command",
            kind: .completeTask,
            taskID: "task",
            createdAt: now
        )

        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeSnapshot(TaskifyWatchTransfer.encode(snapshot)),
            snapshot
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(command)),
            command
        )
        let create = TaskifyWatchCommand(
            id: "create",
            kind: .createTask,
            title: "Pick up groceries",
            boardID: "board",
            createdAt: now
        )
        let voice = TaskifyWatchCommand(
            id: "voice",
            kind: .processVoiceTranscript,
            boardID: "board",
            transcript: "Remind me to call Sam tomorrow",
            createdAt: now
        )
        let voiceDraft = TaskifyWatchVoiceDraft(
            id: "draft",
            title: "Call Sam",
            dueISO: "2026-08-08T14:00:00Z",
            boardId: "destination-board",
            subtasks: ["Confirm agenda"],
            priority: 2,
            columnId: "destination-column"
        )
        let createVoiceTasks = TaskifyWatchCommand(
            id: "create-voice",
            kind: .createVoiceTasks,
            boardID: "board",
            voiceTasks: [voiceDraft],
            createdAt: now
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(create)),
            create
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(voice)),
            voice
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(createVoiceTasks)),
            createVoiceTasks
        )
        let previewRequest = TaskifyWatchVoicePreviewRequest(
            id: "preview",
            transcript: "Call Sam tomorrow",
            boardID: "board"
        )
        let preview = TaskifyWatchVoicePreview(
            requestID: previewRequest.id,
            transcript: previewRequest.transcript,
            tasks: [voiceDraft]
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeVoicePreviewRequest(
                TaskifyWatchTransfer.encode(previewRequest)
            ),
            previewRequest
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeVoicePreview(TaskifyWatchTransfer.encode(preview)),
            preview
        )
        XCTAssertThrowsError(
            try TaskifyWatchTransfer.decodeVoicePreviewRequest(TaskifyWatchTransfer.encode(voice))
        )
        let receipt = TaskifyWatchCommandReceipt(commandID: command.id, snapshot: snapshot)
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeCommandReceipt(TaskifyWatchTransfer.encode(receipt)),
            receipt
        )
    }

    func testProvisioningPayloadValidatesAndRoundTripsWithoutChangingKeyMaterial() throws {
        let privateKey = Data(repeating: 7, count: 32)
        let publicKey = String(repeating: "a", count: 64)
        let payload = try TaskifyWatchProvisioningPayload(
            privateKey: privateKey,
            publicKeyHex: publicKey,
            publicKeyNpub: "npub1example",
            relayURLs: [" wss://relay.example/ ", "wss://relay.example", "https://not-a-relay.example"],
            snapshot: TaskifyWatchSnapshot(generatedAt: now)
        )

        XCTAssertEqual(payload.privateKey, privateKey)
        XCTAssertEqual(payload.publicKeyNpub, "npub1example")
        XCTAssertEqual(payload.relayURLs, ["wss://relay.example"])
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeProvisioningPayload(TaskifyWatchTransfer.encode(payload)),
            payload
        )

        let legacyEncoder = JSONEncoder()
        legacyEncoder.dateEncodingStrategy = .millisecondsSince1970
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeProvisioningPayload(legacyEncoder.encode(payload)),
            payload
        )
    }

    func testLargeProvisioningPayloadIsBoundedAndKeepsRoutingForRetainedThreads() throws {
        let privateKey = Data(repeating: 7, count: 32)
        let identity = try NostrIdentity(privateKey: privateKey)
        let contacts = (0..<100).map { index in
            TaskifyWatchContact(
                publicKey: String(format: "%064x", index + 1),
                npub: "npub-\(index)",
                displayName: deterministicPayload(
                    seed: UInt64(index + 1_000),
                    count: 900
                ).base64EncodedString(),
                discoveryRelayURLs: ["wss://relay.example"]
            )
        }
        let summaries = contacts.enumerated().map { index, contact in
            TaskifyWatchChatThreadSummary(
                conversationID: String(format: "%064x", 20_000 + index),
                memberPublicKeys: [identity.publicKeyHex, contact.publicKey],
                displayName: "Contact \(index)",
                latestPreview: "Latest private preview \(index)",
                latestActivityAt: 3_000 + index,
                unreadCount: index % 3,
                isRequest: false
            )!
        }
        let tasks = (0..<80).map { index in
            TaskifyWatchTask(
                id: "task-\(index)",
                title: "Task \(index)",
                boardID: "work",
                boardName: "Work",
                columnName: "Inbox",
                dueDate: now,
                dueTimeEnabled: true,
                priority: nil,
                order: index,
                syncPayload: deterministicPayload(seed: UInt64(index + 1), count: 1_024)
            )
        }
        let payload = try TaskifyWatchProvisioningPayload(
            privateKey: privateKey,
            publicKeyHex: identity.publicKeyHex,
            relayURLs: ["wss://relay.example"],
            snapshot: TaskifyWatchSnapshot(
                tasks: tasks,
                boards: [TaskifyWatchBoard(id: "work", name: "Work", openTaskCount: tasks.count)],
                selectedBoardID: "work",
                generatedAt: now
            ),
            chatContext: TaskifyWatchChatProvisioningContext(
                contacts: contacts,
                threadSummaries: summaries,
                discoveryRelayURLs: ["wss://relay.example"],
                pushRelayHTTPSURL: URL(string: "https://push.example")!,
                pushRelayWSSURL: "wss://push.example"
            )
        )

        let data = try TaskifyWatchTransfer.encode(payload, maximumBytes: 12_000)
        let decoded = try TaskifyWatchTransfer.decodeProvisioningPayload(data)
        let retainedThreads = try XCTUnwrap(decoded.chatContext?.threadSummaries)
        let retainedContactKeys = Set(decoded.chatContext?.contacts.map(\.publicKey) ?? [])

        XCTAssertLessThanOrEqual(data.count, 12_000)
        XCTAssertEqual(decoded.privateKey, privateKey)
        XCTAssertEqual(decoded.publicKeyHex, identity.publicKeyHex)
        XCTAssertEqual(decoded.chatContext?.pushRelayWSSURL, "wss://push.example")
        XCTAssertTrue(decoded.snapshot.tasks.isEmpty)
        XCTAssertFalse(retainedThreads.isEmpty)
        XCTAssertLessThan(retainedThreads.count, summaries.count)
        for thread in retainedThreads {
            XCTAssertTrue(
                Set(thread.memberPublicKeys)
                    .subtracting([identity.publicKeyHex])
                    .isSubset(of: retainedContactKeys)
            )
        }
    }

    func testWatchNostrTaskEventIsNativeCodecCompatible() throws {
        let board = Board(
            id: "local-board",
            name: "Work",
            kind: .list,
            columns: [BoardColumn(id: "inbox", name: "Inbox", order: 0)],
            nostrBoardID: "shared-board-secret",
            relayURLs: ["wss://relay.example"]
        )
        let task = TaskItem(
            id: "watch-task",
            boardID: board.id,
            title: "Created independently",
            note: "Encrypted on Apple Watch",
            dueDate: now,
            dueDateEnabled: true,
            priority: .high,
            columnID: "inbox",
            createdBy: String(repeating: "a", count: 64)
        )
        let payload = try JSONEncoder().encode(TaskSyncPayload(task: task))
        let watchEvent = try TaskifyWatchNostrCrypto.taskEvent(
            taskID: task.id,
            boardID: board.effectiveNostrBoardID,
            columnTag: "inbox",
            status: "open",
            payload: payload,
            createdAt: 1_786_000_000
        )
        let nativeEvent = NostrEvent(
            id: watchEvent.id,
            publicKey: watchEvent.publicKey,
            createdAt: watchEvent.createdAt,
            kind: watchEvent.kind,
            tags: watchEvent.tags,
            content: watchEvent.content,
            signature: watchEvent.signature
        )

        XCTAssertTrue(TaskifyWatchNostrCrypto.verify(watchEvent))
        XCTAssertTrue(nativeEvent.verify())
        let decoded = try TaskEventCodec.decodeTaskEvent(nativeEvent, board: board, calendar: calendar)
        XCTAssertEqual(decoded.task.id, task.id)
        XCTAssertEqual(decoded.task.title, task.title)
        XCTAssertEqual(decoded.task.note, task.note)
        XCTAssertEqual(decoded.task.priority, task.priority)
        XCTAssertEqual(decoded.task.columnID, "inbox")
    }

    func testWatchRequestAuthenticationIsStableForFixtureTimestamp() throws {
        let privateKey = Data(repeating: 7, count: 32)
        let identity = try NostrIdentity(privateKey: privateKey)
        let authentication = try TaskifyWatchNostrCrypto.requestAuthentication(
            privateKey: privateKey,
            publicKeyHex: identity.publicKeyHex,
            body: Data("{\"test\":true}".utf8),
            timestamp: 1_786_000_000
        )

        XCTAssertEqual(authentication.publicKeyHex, identity.publicKeyHex)
        XCTAssertEqual(authentication.timestamp, "1786000000")
        XCTAssertEqual(authentication.signature.count, 128)
        XCTAssertThrowsError(
            try TaskifyWatchNostrCrypto.requestAuthentication(
                privateKey: privateKey,
                publicKeyHex: String(repeating: "b", count: 64),
                body: Data("{}".utf8),
                timestamp: 1_786_000_000
            )
        )
    }

    func testWatchDecryptsNativeBoardEventsOnlyOnDevice() throws {
        let board = Board(
            id: "local-board",
            name: "Private Work",
            kind: .list,
            columns: [
                BoardColumn(id: "inbox", name: "Inbox", order: 0),
                BoardColumn(id: "later", name: "Later", order: 1),
            ],
            nostrBoardID: "private-board-secret",
            relayURLs: ["wss://relay.example"]
        )
        let native = try TaskEventCodec.boardEvent(board: board, createdAt: 1_786_000_010)
        let watch = TaskifyWatchNostrEvent(
            id: native.id,
            publicKey: native.publicKey,
            createdAt: native.createdAt,
            kind: native.kind,
            tags: native.tags,
            content: native.content,
            signature: native.signature
        )

        let plaintext = try TaskifyWatchNostrCrypto.decryptBoardPayload(
            watch,
            boardID: board.effectiveNostrBoardID
        )
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
        )
        let columns = try XCTUnwrap(payload["columns"] as? [[String: Any]])

        XCTAssertTrue(TaskifyWatchNostrCrypto.verify(watch))
        XCTAssertEqual(columns.compactMap { $0["id"] as? String }, ["inbox", "later"])
        XCTAssertThrowsError(
            try TaskifyWatchNostrCrypto.decryptBoardPayload(
                watch,
                boardID: "a-different-board-secret"
            )
        )
    }

    func testTaskCacheProofBindsOneBoardSubscriptionToTheWatchAccount() throws {
        let privateKey = Data(repeating: 7, count: 32)
        let identity = try NostrIdentity(privateKey: privateKey)
        let boardID = "private-board-secret"
        let url = try XCTUnwrap(URL(string: "https://push.solife.me/v1/watch/tasks/query"))
        let proof = try TaskifyWatchNostrCrypto.taskCacheAccessProof(
            boardID: boardID,
            accountPublicKey: identity.publicKeyHex,
            url: url,
            createdAt: 1_786_000_020
        )

        XCTAssertEqual(proof.kind, TaskifyWatchNostrCrypto.taskCacheAccessKind)
        XCTAssertEqual(
            proof.publicKey,
            try TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID)
        )
        XCTAssertEqual(proof.firstTagValue(named: "account"), identity.publicKeyHex)
        XCTAssertEqual(
            proof.firstTagValue(named: "b"),
            TaskifyWatchNostrCrypto.boardTag(for: boardID)
        )
        XCTAssertEqual(proof.firstTagValue(named: "u"), url.absoluteString)
        XCTAssertTrue(TaskifyWatchNostrCrypto.verify(proof))
    }

    func testNativeVoiceAuthenticationMatchesWatchRequestProtocol() throws {
        let privateKey = Data(repeating: 9, count: 32)
        let identity = try NostrIdentity(privateKey: privateKey)
        let body = Data("{\"transcript\":\"call dentist\"}".utf8)
        let timestamp = 1_786_000_123
        let nativeHeaders = try identity.taskifyRequestHeaders(body: body, timestamp: timestamp)
        let watchAuthentication = try TaskifyWatchNostrCrypto.requestAuthentication(
            privateKey: privateKey,
            publicKeyHex: identity.publicKeyHex,
            body: body,
            timestamp: timestamp
        )

        XCTAssertEqual(nativeHeaders, watchAuthentication.headers)
    }

    func testSnapshotWrittenBeforeCommandAcknowledgementsStillDecodes() throws {
        let legacyJSON = """
        {"schemaVersion":1,"tasks":[],"boards":[],"generatedAt":1785945600000}
        """

        let snapshot = try TaskifyWatchTransfer.decodeSnapshot(Data(legacyJSON.utf8))

        XCTAssertNil(snapshot.acknowledgedCommandIDs)
        XCTAssertTrue(snapshot.tasks.isEmpty)
    }

    func testCompanionOnlySnapshotStillDecodesAfterIndependentSyncUpgrade() throws {
        let legacyJSON = """
        {
          "schemaVersion":1,
          "tasks":[{
            "id":"legacy-task","title":"Legacy","boardID":"legacy-board",
            "boardName":"Board","dueTimeEnabled":false,"order":0
          }],
          "boards":[{"id":"legacy-board","name":"Board","openTaskCount":1}],
          "selectedBoardID":"legacy-board","generatedAt":1785945600000
        }
        """

        let snapshot = try TaskifyWatchTransfer.decodeSnapshot(Data(legacyJSON.utf8))

        XCTAssertEqual(snapshot.tasks.first?.id, "legacy-task")
        XCTAssertNil(snapshot.tasks.first?.nostrBoardID)
        XCTAssertNil(snapshot.boards.first?.relayURLs)
    }

    func testProvisioningPayloadRejectsMalformedKeyMaterial() {
        XCTAssertThrowsError(
            try TaskifyWatchProvisioningPayload(
                privateKey: Data(repeating: 1, count: 31),
                publicKeyHex: String(repeating: "a", count: 64),
                relayURLs: [],
                snapshot: TaskifyWatchSnapshot()
            )
        )
        XCTAssertThrowsError(
            try TaskifyWatchProvisioningPayload(
                privateKey: Data(repeating: 1, count: 32),
                publicKeyHex: "not-a-public-key",
                relayURLs: [],
                snapshot: TaskifyWatchSnapshot()
            )
        )
    }

    func testWatchCommandRejectsMissingKindSpecificPayload() throws {
        for command in [
            TaskifyWatchCommand(kind: .completeTask),
            TaskifyWatchCommand(kind: .createTask, title: "Task without a board"),
            TaskifyWatchCommand(kind: .createVoiceTasks, boardID: "board", voiceTasks: []),
            TaskifyWatchCommand(kind: .processVoiceTranscript, boardID: "board"),
        ] {
            XCTAssertThrowsError(
                try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(command))
            )
        }
    }
}

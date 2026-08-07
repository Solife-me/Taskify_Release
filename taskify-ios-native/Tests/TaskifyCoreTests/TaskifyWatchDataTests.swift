import Foundation
import XCTest
@testable import TaskifyCore
import TaskifyWatchShared

final class TaskifyWatchDataTests: XCTestCase {
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
        XCTAssertEqual(watch.todayTasks(now: now, calendar: calendar).map(\.id), ["today"])
        XCTAssertEqual(watch.boards.map(\.name), ["Work", "Personal"])
        XCTAssertEqual(watch.boards.map(\.openTaskCount), [2, 0])
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
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(create)),
            create
        )
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(voice)),
            voice
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
            relayURLs: [" wss://relay.example/ ", "wss://relay.example", "https://not-a-relay.example"],
            snapshot: TaskifyWatchSnapshot(generatedAt: now)
        )

        XCTAssertEqual(payload.privateKey, privateKey)
        XCTAssertEqual(payload.relayURLs, ["wss://relay.example"])
        XCTAssertEqual(
            try TaskifyWatchTransfer.decodeProvisioningPayload(TaskifyWatchTransfer.encode(payload)),
            payload
        )
    }

    func testSnapshotWrittenBeforeCommandAcknowledgementsStillDecodes() throws {
        let legacyJSON = """
        {"schemaVersion":1,"tasks":[],"boards":[],"generatedAt":1785945600000}
        """

        let snapshot = try TaskifyWatchTransfer.decodeSnapshot(Data(legacyJSON.utf8))

        XCTAssertNil(snapshot.acknowledgedCommandIDs)
        XCTAssertTrue(snapshot.tasks.isEmpty)
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
            TaskifyWatchCommand(kind: .processVoiceTranscript, boardID: "board"),
        ] {
            XCTAssertThrowsError(
                try TaskifyWatchTransfer.decodeCommand(TaskifyWatchTransfer.encode(command))
            )
        }
    }
}

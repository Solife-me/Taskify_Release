import Foundation
import TaskifyCore

#if TASKIFY_MAC_UI_TEST
enum MacUITestFixture {
    static let boardID = "ui-test-board"
    static let weekBoardID = "ui-test-week-board"
    static let taskID = "ui-test-deep-link-task"
    static let taskTitle = "Open this task from a deep link"
    static let chatPeerPublicKey = String(repeating: "2", count: 64)

    static func prepare(_ configuration: MacUITestRuntimeConfiguration) throws {
        let files = FileManager.default
        if configuration.resetsStore,
           files.fileExists(atPath: configuration.rootDirectory.path) {
            try files.removeItem(at: configuration.rootDirectory)
        }
        try files.createDirectory(
            at: configuration.rootDirectory,
            withIntermediateDirectories: true
        )

        let splitMarker = configuration.rootDirectory
            .appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true)
            .appendingPathComponent("format.json", isDirectory: false)
        guard !files.fileExists(atPath: configuration.storeURL.path),
              !files.fileExists(atPath: splitMarker.path) else { return }

        let column = BoardColumn(id: "ui-test-todo", name: "To do", order: 0)
        let board = Board(
            id: boardID,
            name: "UI Test Board",
            kind: .list,
            columns: [column]
        )
        let weekBoard = Board(
            id: weekBoardID,
            name: "UI Test Week",
            kind: .week,
            columns: WeekdayColumn.ordered(startingAt: .sunday).map {
                BoardColumn(id: $0.rawValue, name: $0.fullName, order: $0.calendarWeekday)
            }
        )
        let task = TaskItem(
            id: taskID,
            boardID: board.id,
            title: taskTitle,
            order: 0,
            columnID: column.id
        )
        let contact = NostrContact(
            publicKeyValue: chatPeerPublicKey,
            petname: "Paste Test Contact"
        )!
        let message = NostrDirectMessage(
            rumorEventID: String(repeating: "3", count: 64),
            wrapEventID: String(repeating: "4", count: 64),
            peerPublicKey: chatPeerPublicKey,
            senderPublicKey: chatPeerPublicKey,
            content: "Paste an image here",
            createdAt: 1_700_000_000,
            isIncoming: true
        )
        // TASKIFY_UI_TEST_CHAT_ATTACHMENTS adds the shared attachment fixture (a photo stack, a
        // PDF, a photo and an audio message) with its decrypted files already cached.
        let attachmentEntries = ChatAttachmentUITestFixture.entries
        let attachmentMessages = attachmentEntries.enumerated().map { offset, entry in
            NostrDirectMessage(
                rumorEventID: String(format: "%064x", 0xA000 + offset),
                wrapEventID: String(format: "%064x", 0xB000 + offset),
                peerPublicKey: chatPeerPublicKey,
                senderPublicKey: entry.isIncoming ? chatPeerPublicKey : String(repeating: "5", count: 64),
                content: entry.attachment.url,
                createdAt: 1_700_000_010 + offset,
                isIncoming: entry.isIncoming,
                attachment: entry.attachment,
                deliveryState: entry.isIncoming ? nil : .sent
            )
        }
        if !attachmentEntries.isEmpty {
            Task { await ChatAttachmentUITestFixture.seedDiskCache(attachmentEntries) }
        }
        var messages = [message] + attachmentMessages
        if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_SENT_BOARD"] == "1" {
            let envelope = TaskifyShareEnvelope(item: .board(SharedBoardDelivery(
                boardID: "ui-test-sent-board", boardName: "Trip planning board"
            )))
            messages.append(NostrDirectMessage(
                rumorEventID: String(repeating: "6", count: 64),
                wrapEventID: String(repeating: "7", count: 64),
                peerPublicKey: chatPeerPublicKey,
                senderPublicKey: String(repeating: "5", count: 64),
                content: try envelope.messageContent(),
                createdAt: 1_700_000_030,
                isIncoming: false,
                deliveryState: .sent
            ))
        }
        let snapshot = TaskifySnapshot(
            boards: [board, weekBoard],
            tasks: [task],
            selectedBoardID: board.id,
            contacts: [contact],
            directMessages: messages
        )
        try JSONEncoder().encode(snapshot).write(to: configuration.storeURL, options: .atomic)
    }
}
#endif

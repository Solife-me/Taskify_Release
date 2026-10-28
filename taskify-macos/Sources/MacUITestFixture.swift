import Foundation
import TaskifyCore

#if TASKIFY_MAC_UI_TEST
enum MacUITestFixture {
    static let boardID = "ui-test-board"
    static let taskID = "ui-test-deep-link-task"
    static let taskTitle = "Open this task from a deep link"
    static let chatPeerPublicKey = String(repeating: "2", count: 64)

    static func prepare(_ configuration: MacUITestRuntimeConfiguration) throws {
        let files = FileManager.default
        UserDefaults.standard.set(
            configuration.walletEnabled || configuration.walletRecoveryPreview,
            forKey: WalletPhaseOut.walletEnabledKey
        )
        UserDefaults.standard.set(
            configuration.walletRecoveryPreview,
            forKey: WalletPhaseOut.removalPreviewKey
        )
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
        let snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [task],
            selectedBoardID: board.id,
            contacts: [contact],
            directMessages: [message] + attachmentMessages
        )
        try JSONEncoder().encode(snapshot).write(to: configuration.storeURL, options: .atomic)
    }
}
#endif

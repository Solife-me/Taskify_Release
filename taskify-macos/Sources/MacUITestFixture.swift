import Foundation
import TaskifyCore

#if TASKIFY_MAC_UI_TEST
enum MacUITestFixture {
    static let boardID = "ui-test-board"
    static let taskID = "ui-test-deep-link-task"
    static let taskTitle = "Open this task from a deep link"

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
        let snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [task],
            selectedBoardID: board.id
        )
        try JSONEncoder().encode(snapshot).write(to: configuration.storeURL, options: .atomic)
    }
}
#endif

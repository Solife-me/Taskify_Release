import Foundation
import SwiftUI
import TaskifyCore

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var snapshot = TaskifySnapshot.empty
    @Published private(set) var isLoading = true
    @Published private(set) var identityPublicKey = ""
    @Published private(set) var identityNpub = ""
    @Published private(set) var syncStatus = "Starting"
    @Published var errorMessage: String?

    private let store: JSONTaskStore
    private let identityStore: KeychainIdentityStore
    private let syncEngine: TaskSyncEngine
    private var saveTask: Task<Void, Never>?
    private var syncListenerTask: Task<Void, Never>?
    private var lastNostrCreatedAt = 0

    init(
        store: JSONTaskStore = JSONTaskStore(),
        identityStore: KeychainIdentityStore = KeychainIdentityStore(),
        syncEngine: TaskSyncEngine = TaskSyncEngine()
    ) {
        self.store = store
        self.identityStore = identityStore
        self.syncEngine = syncEngine
        Task { await load() }
    }

    deinit {
        saveTask?.cancel()
        syncListenerTask?.cancel()
    }

    var visibleBoards: [Board] { snapshot.visibleBoards }
    var selectedBoard: Board? { snapshot.selectedBoard }
    var selectedBoardID: String { snapshot.selectedBoardID }

    func tasks(for weekday: WeekdayColumn, includeCompleted: Bool) -> [TaskItem] {
        guard let boardID = selectedBoard?.id else { return [] }
        return snapshot.tasks(
            boardID: boardID,
            columnID: weekday.rawValue,
            includeCompleted: includeCompleted
        )
    }

    func upcomingTasks(searchText: String = "") -> [TaskItem] {
        let tasks = snapshot.upcomingTasks(from: Date())
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return tasks }
        return tasks.filter {
            $0.title.localizedCaseInsensitiveContains(query) ||
            $0.note.localizedCaseInsensitiveContains(query)
        }
    }

    func selectBoard(_ boardID: String) {
        snapshot.selectBoard(boardID)
        scheduleSave()
    }

    func addQuickTask(title: String, weekday: WeekdayColumn) {
        guard let boardID = selectedBoard?.id else { return }
        let dueDate = WeekDateResolver.date(for: weekday, inWeekContaining: Date())
        guard let task = snapshot.addTask(
            title: title,
            boardID: boardID,
            columnID: weekday.rawValue,
            dueDate: dueDate,
            authorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(task.id)
    }

    func addTask(title: String, dueDate: Date) {
        guard let boardID = selectedBoard?.id else { return }
        let weekday = WeekdayColumn.containing(dueDate)
        guard let task = snapshot.addTask(
            title: title,
            boardID: boardID,
            columnID: weekday.rawValue,
            dueDate: dueDate,
            authorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(task.id)
    }

    func toggleCompletion(_ taskID: String) {
        guard snapshot.toggleCompletion(
            taskID: taskID,
            editorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(taskID)
    }

    func deleteTask(_ taskID: String) {
        guard snapshot.deleteTask(taskID: taskID, editorPublicKey: identityPublicKey.nilIfEmpty) else { return }
        synchronizeTask(taskID, includeDeletionEvent: true)
    }

    @discardableResult
    func createWeekBoard(name: String) -> Bool {
        guard let board = snapshot.createWeekBoard(name: name) else { return false }
        scheduleSave()
        reconfigureSync()
        publishBoard(board)
        return true
    }

    @discardableResult
    func joinWeekBoard(boardID: String, name: String) -> Bool {
        guard snapshot.joinWeekBoard(nostrBoardID: boardID, name: name) != nil else { return false }
        scheduleSave()
        reconfigureSync()
        return true
    }

    @discardableResult
    func importIdentity(_ value: String) -> Bool {
        do {
            let imported = try NostrIdentity(importedValue: value)
            try identityStore.save(imported)
            applyIdentity(imported)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func load() async {
        defer { isLoading = false }
        do {
            applyIdentity(try identityStore.loadOrCreate())
        } catch {
            errorMessage = error.localizedDescription
        }
        do {
            snapshot = try await store.load()
            try await store.save(snapshot)
        } catch {
            errorMessage = "Your native data could not be loaded. A fresh local workspace is being shown."
        }
        startSync()
    }

    private func applyIdentity(_ identity: NostrIdentity) {
        identityPublicKey = identity.publicKeyHex
        identityNpub = identity.npub
    }

    private func startSync() {
        let updates = syncEngine.updates()
        syncListenerTask?.cancel()
        syncListenerTask = Task { [weak self] in
            for await update in updates {
                guard !Task.isCancelled else { return }
                self?.handleSyncUpdate(update)
            }
        }
        reconfigureSync()
    }

    private func reconfigureSync() {
        let boards = snapshot.visibleBoards
        Task { [syncEngine] in
            await syncEngine.configure(boards: boards)
        }
    }

    private func handleSyncUpdate(_ update: TaskSyncUpdate) {
        switch update {
        case .task(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            if snapshot.mergeRemoteTask(record.task, eventCreatedAt: record.eventCreatedAt) {
                scheduleSave()
            }
        case .state(let state):
            switch state {
            case .stopped: syncStatus = "Stopped"
            case .connecting: syncStatus = "Connecting"
            case .online: syncStatus = "Synced"
            case .offline: syncStatus = "Offline — changes queued"
            }
        }
    }

    private func synchronizeTask(_ taskID: String, includeDeletionEvent: Bool = false) {
        guard let index = snapshot.tasks.firstIndex(where: { $0.id == taskID }),
              let board = snapshot.boards.first(where: { $0.id == snapshot.tasks[index].boardID }) else {
            scheduleSave()
            return
        }

        let timestamp = nextNostrTimestamp()
        let deletionTimestamp = includeDeletionEvent ? nextNostrTimestamp() : nil
        snapshot.tasks[index].nostrUpdatedAt = timestamp
        let task = snapshot.tasks[index]
        scheduleSave()
        Task { [syncEngine] in
            do {
                let boardEvent = try TaskEventCodec.boardEvent(board: board, createdAt: timestamp)
                try await syncEngine.publish(boardEvent, board: board, taskID: "_board")
                let event = try TaskEventCodec.taskEvent(task: task, board: board, createdAt: timestamp)
                try await syncEngine.publish(event, board: board, taskID: task.id)
                if let deletionTimestamp {
                    let deletion = try TaskEventCodec.deletionEvent(
                        taskID: task.id,
                        board: board,
                        createdAt: deletionTimestamp
                    )
                    try await syncEngine.publish(
                        deletion,
                        board: board,
                        taskID: "deletion:\(task.id)"
                    )
                }
            } catch {
                await MainActor.run {
                    self.syncStatus = "Offline — changes queued"
                }
            }
        }
    }

    private func publishBoard(_ board: Board) {
        let timestamp = nextNostrTimestamp()
        Task { [syncEngine] in
            do {
                let event = try TaskEventCodec.boardEvent(board: board, createdAt: timestamp)
                try await syncEngine.publish(event, board: board, taskID: "_board")
            } catch {
                await MainActor.run {
                    self.syncStatus = "Offline — changes queued"
                }
            }
        }
    }

    private func nextNostrTimestamp() -> Int {
        let now = Int(Date().timeIntervalSince1970)
        lastNostrCreatedAt = max(now, lastNostrCreatedAt + 1)
        return lastNostrCreatedAt
    }

    private func scheduleSave() {
        let snapshotToSave = snapshot
        saveTask?.cancel()
        saveTask = Task { [store] in
            guard !Task.isCancelled else { return }
            do {
                try await store.save(snapshotToSave)
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.errorMessage = "Taskify could not save the latest change."
                }
            }
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

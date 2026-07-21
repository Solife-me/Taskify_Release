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
    @Published private(set) var syncDetail = "Preparing secure relay connections"
    @Published private(set) var relayStatuses: [TaskRelayStatus] = []
    @Published private(set) var pendingSyncChangeCount = 0
    @Published private(set) var notificationStatus = "Checking"
    @Published var errorMessage: String?

    private let store: JSONTaskStore
    private let identityStore: KeychainIdentityStore
    private let syncEngine: TaskSyncEngine
    private let notificationCoordinator: TaskNotificationCoordinator
    private var saveTask: Task<Void, Never>?
    private var syncListenerTask: Task<Void, Never>?
    private var notificationTask: Task<Void, Never>?
    private var lastNostrCreatedAt = 0
    private var syncState: TaskSyncState = .connecting

    init(
        store: JSONTaskStore = JSONTaskStore(),
        identityStore: KeychainIdentityStore = KeychainIdentityStore(),
        syncEngine: TaskSyncEngine = TaskSyncEngine(),
        notificationCoordinator: TaskNotificationCoordinator = TaskNotificationCoordinator()
    ) {
        self.store = store
        self.identityStore = identityStore
        self.syncEngine = syncEngine
        self.notificationCoordinator = notificationCoordinator
        Task { await load() }
    }

    deinit {
        saveTask?.cancel()
        syncListenerTask?.cancel()
        notificationTask?.cancel()
    }

    var visibleBoards: [Board] { snapshot.visibleBoards }
    var selectedBoard: Board? { snapshot.selectedBoard }
    var selectedBoardID: String { snapshot.selectedBoardID }
    var syncIsOnline: Bool {
        if case .online = syncState { return true }
        return false
    }

    func task(withID taskID: String) -> TaskItem? {
        snapshot.tasks.first { $0.id == taskID && !$0.isDeleted }
    }

    func board(withID boardID: String) -> Board? {
        snapshot.boards.first { $0.id == boardID && $0.isVisible }
    }

    func tasks(for weekday: WeekdayColumn, includeCompleted: Bool) -> [TaskItem] {
        guard let boardID = selectedBoard?.id else { return [] }
        return snapshot.tasks(
            boardID: boardID,
            columnID: weekday.rawValue,
            includeCompleted: includeCompleted
        )
    }

    func tasks(forColumnID columnID: String, includeCompleted: Bool) -> [TaskItem] {
        guard let boardID = selectedBoard?.id else { return [] }
        return snapshot.tasks(
            boardID: boardID,
            columnID: columnID,
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

    func addQuickTask(title: String, columnID: String) {
        guard let board = selectedBoard, board.kind == .list else { return }
        guard let task = snapshot.addTask(
            title: title,
            boardID: board.id,
            columnID: columnID,
            dueDate: nil,
            authorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(task.id)
    }

    func addTask(title: String, dueDate: Date) {
        guard let board = selectedBoard else { return }
        let columnID: String?
        switch board.kind {
        case .week:
            columnID = WeekdayColumn.containing(dueDate).rawValue
        case .list:
            columnID = board.columns.sorted { $0.order < $1.order }.first?.id
        case .compound, .bible:
            columnID = nil
        }
        guard let task = snapshot.addTask(
            title: title,
            boardID: board.id,
            columnID: columnID,
            dueDate: dueDate,
            authorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(task.id)
    }

    @discardableResult
    func updateTask(
        taskID: String,
        title: String,
        note: String,
        dueDate: Date?,
        dueDateEnabled: Bool,
        dueTimeEnabled: Bool,
        priority: TaskPriority?,
        columnID: String?,
        subtasks: [TaskSubtask],
        recurrence: TaskRecurrence?,
        reminders: [TaskReminder],
        reminderTime: String?,
        images: [String],
        documents: [TaskDocument]
    ) -> Bool {
        guard snapshot.updateTask(
            taskID: taskID,
            title: title,
            note: note,
            dueDate: dueDate,
            dueDateEnabled: dueDateEnabled,
            dueTimeEnabled: dueTimeEnabled,
            dueTimeZone: dueTimeEnabled ? TimeZone.current.identifier : nil,
            priority: priority,
            columnID: columnID,
            subtasks: subtasks,
            recurrence: recurrence,
            reminders: reminders,
            reminderTime: reminderTime,
            editorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return false }
        guard snapshot.replaceTaskAttachments(
            taskID: taskID,
            images: images,
            documents: documents,
            editorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return false }
        synchronizeTask(taskID)
        refreshNotifications(requestPermission: !reminders.isEmpty)
        return true
    }

    func toggleCompletion(_ taskID: String) {
        let existingIDs = Set(snapshot.tasks.map(\.id))
        guard snapshot.toggleCompletion(
            taskID: taskID,
            editorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(taskID)
        snapshot.tasks
            .map(\.id)
            .filter { !existingIDs.contains($0) }
            .forEach { synchronizeTask($0) }
        refreshNotifications(requestPermission: false)
    }

    func deleteTask(_ taskID: String) {
        guard snapshot.deleteTask(taskID: taskID, editorPublicKey: identityPublicKey.nilIfEmpty) else { return }
        synchronizeTask(taskID, includeDeletionEvent: true)
        refreshNotifications(requestPermission: false)
    }

    func requestNotificationPermission() {
        refreshNotifications(requestPermission: true)
    }

    func refreshNotificationStatus() {
        refreshNotifications(requestPermission: false)
    }

    func retrySync() {
        syncStatus = "Connecting"
        syncDetail = "Retrying relay connections"
        Task { [syncEngine] in
            await syncEngine.retryNow()
        }
    }

    func refreshSyncIfNeeded() {
        guard !isLoading else { return }
        switch syncState {
        case .offline, .stopped:
            retrySync()
        case .connecting, .online:
            return
        }
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
    func createListBoard(name: String) -> Bool {
        guard let board = snapshot.createListBoard(name: name) else { return false }
        scheduleSave()
        reconfigureSync()
        publishBoard(board)
        return true
    }

    @discardableResult
    func addListColumn(name: String) -> Bool {
        guard let board = selectedBoard,
              snapshot.addListColumn(boardID: board.id, name: name) != nil,
              let updatedBoard = snapshot.boards.first(where: { $0.id == board.id }) else {
            return false
        }
        scheduleSave()
        publishBoard(updatedBoard)
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
        refreshNotifications(requestPermission: false)
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
        case .board(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            if snapshot.mergeRemoteBoard(record.board, eventCreatedAt: record.eventCreatedAt) {
                scheduleSave()
            }
        case .task(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            if snapshot.mergeRemoteTask(record.task, eventCreatedAt: record.eventCreatedAt) {
                scheduleSave()
                refreshNotifications(requestPermission: false)
            }
        case .status(let report):
            applySyncReport(report)
        }
    }

    private func applySyncReport(_ report: TaskSyncReport) {
        syncState = report.state
        relayStatuses = report.relays
        pendingSyncChangeCount = report.queuedChangeCount

        let onlineCount = report.relays.filter { $0.phase == .online }.count
        let activeCount = report.relays.filter {
            $0.phase == .online || $0.phase == .syncing
        }.count
        let relaySummary = report.relays.isEmpty
            ? "No relays configured"
            : "\(onlineCount) of \(report.relays.count) relays synced"

        switch report.state {
        case .stopped:
            syncStatus = "Stopped"
            syncDetail = relaySummary
        case .connecting:
            syncStatus = report.queuedChangeCount > 0
                ? "Connecting • \(report.queuedChangeCount) queued"
                : "Connecting"
            syncDetail = activeCount > 0
                ? "\(activeCount) of \(report.relays.count) relays responding"
                : "Contacting \(report.relays.count) relays"
        case .online:
            syncStatus = report.queuedChangeCount > 0
                ? "Syncing \(report.queuedChangeCount) change\(report.queuedChangeCount == 1 ? "" : "s")"
                : "Synced"
            syncDetail = relaySummary
        case .offline(let message):
            syncStatus = report.queuedChangeCount > 0
                ? "Offline • \(report.queuedChangeCount) queued"
                : "Offline"
            syncDetail = message
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
                    self.errorMessage = "Taskify could not queue this task for Nostr sync."
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
                    self.errorMessage = "Taskify could not queue this board for Nostr sync."
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

    private func refreshNotifications(requestPermission: Bool) {
        let tasks = snapshot.tasks
        notificationTask?.cancel()
        notificationTask = Task { [notificationCoordinator] in
            let status = await notificationCoordinator.reschedule(
                tasks: tasks,
                requestPermission: requestPermission
            )
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self.notificationStatus = status
            }
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

import Foundation
import SwiftUI
import TaskifyCore

struct BoardTemplateShareResult: Sendable {
    let board: Board
    let queuedTaskCount: Int
    let failedTaskCount: Int
}

enum BoardTemplateShareError: LocalizedError {
    case boardUnavailable
    case unsupportedBoard

    var errorDescription: String? {
        switch self {
        case .boardUnavailable:
            "That board is no longer available."
        case .unsupportedBoard:
            "Template sharing currently supports week and list boards."
        }
    }
}

struct SharedTaskSendResult: Sendable {
    let recipientNpub: String
    let relayCount: Int
    let assignment: Bool
}

enum NostrContactDirectoryError: LocalizedError {
    case identityUnavailable
    case invalidPublicKey
    case cannotAddSelf
    case noRelays
    case contactUnavailable

    var errorDescription: String? {
        switch self {
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidPublicKey: "Enter a valid npub or 64-character public key."
        case .cannotAddSelf: "Your own Nostr account does not need to be added as a contact."
        case .noRelays: "No Nostr relays are configured for contact sync."
        case .contactUnavailable: "That contact is no longer available."
        }
    }
}

enum SharedTaskSendError: LocalizedError {
    case taskUnavailable
    case identityUnavailable
    case invalidRecipient
    case cannotSendToSelf
    case noRelays

    var errorDescription: String? {
        switch self {
        case .taskUnavailable: "That task is no longer available."
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "Enter a valid npub or 64-character public key."
        case .cannotSendToSelf: "Choose another Nostr account as the recipient."
        case .noRelays: "No Nostr relays are configured for delivery."
        }
    }
}

enum StructuredShareSendError: LocalizedError {
    case contactUnavailable
    case identityUnavailable
    case invalidRecipient
    case cannotSendToSelf
    case noRelays

    var errorDescription: String? {
        switch self {
        case .contactUnavailable: "That contact is no longer available."
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "That conversation has an invalid Nostr public key."
        case .cannotSendToSelf: "Choose another Nostr account as the recipient."
        case .noRelays: "No Nostr relays are configured for delivery."
        }
    }
}

enum NostrDirectMessageError: LocalizedError {
    case identityUnavailable
    case invalidRecipient
    case cannotMessageSelf
    case emptyMessage
    case noRelays
    case invalidAttachment
    case invalidGroup
    case groupUnavailable
    case emptyGroupName
    case leftGroup

    var errorDescription: String? {
        switch self {
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "That conversation has an invalid Nostr public key."
        case .cannotMessageSelf: "Choose another Nostr account to message."
        case .emptyMessage: "Enter a message before sending."
        case .noRelays: "No Nostr inbox relays are available for this recipient."
        case .invalidAttachment: "That encrypted attachment is invalid or incomplete."
        case .invalidGroup: "Choose at least two contacts. Groups can contain up to 17 people including you."
        case .groupUnavailable: "That group conversation is no longer available."
        case .emptyGroupName: "Enter a group name before saving."
        case .leftGroup: "Rejoin this group before sending a message."
        }
    }
}

// @Observable (vs. the old ObservableObject + @Published) makes SwiftUI track which of these
// properties each view actually reads, so e.g. a relay-status tick no longer re-renders every
// board and chat view in the app — with 26 frequently-churning properties and every screen
// observing the model, that whole-object invalidation was a real scroll-performance cost.
@Observable
@MainActor
final class AppModel {
    private static let accountBackupOutboxScope = "__taskify-account-backup__"
    private static let sharedInboxOutboxScope = "__taskify-shared-inbox__"
    private static let contactsOutboxScope = "__taskify-contacts__"
    private static let directMessagesOutboxScope = "__taskify-direct-messages__"
    private(set) var snapshot = TaskifySnapshot.empty
    private(set) var isLoading = true
    private(set) var identityPublicKey = ""
    private(set) var identityNpub = ""
    private(set) var syncStatus = "Starting"
    private(set) var syncDetail = "Preparing secure relay connections"
    private(set) var relayStatuses: [TaskRelayStatus] = []
    private(set) var pendingSyncChangeCount = 0
    private(set) var notificationStatus = "Checking"
    private(set) var backgroundSyncStatus = "Ready"
    private(set) var encryptedMediaServerURL = TaskifyMediaServerSettings.configuredServer
    private(set) var fastingRemindersEnabled = FastingRemindersSettings.enabled
    private(set) var fastingRemindersMode = FastingRemindersSettings.mode
    private(set) var fastingRemindersPerMonth = FastingRemindersSettings.perMonth
    private(set) var fastingRemindersWeekday = FastingRemindersSettings.weekday
    private(set) var scriptureMemoryState = AppModel.loadScriptureMemoryState()
    private(set) var scriptureMemoryEnabled = ScriptureMemorySettings.enabled
    private(set) var scriptureMemoryBoardID = ScriptureMemorySettings.boardID
    private(set) var scriptureMemoryFrequency = ScriptureMemorySettings.frequency
    private(set) var streaksEnabled = TaskStreakSettings.enabled
    private(set) var isCheckingAccountBackup = false
    private(set) var isRefreshingContacts = false
    private(set) var contactSyncStatus = "Preparing private contact sync"
    private(set) var accountBackupMessage: String?
    var pendingAccountBackup: NostrAppBackupPayload?
    var errorMessage: String?

    // Sync/bookkeeping internals — never read by views, so keep them out of observation
    // tracking (they churn constantly during sync).
    @ObservationIgnored private let store: JSONTaskStore
    @ObservationIgnored private let identityStore: KeychainIdentityStore
    @ObservationIgnored private let syncEngine: TaskSyncEngine
    @ObservationIgnored private let notificationCoordinator: TaskNotificationCoordinator
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var syncListenerTask: Task<Void, Never>?
    @ObservationIgnored private var notificationTask: Task<Void, Never>?
    @ObservationIgnored private var accountBackupSearchTask: Task<Void, Never>?
    @ObservationIgnored private var accountBackupPublishTask: Task<Void, Never>?
    @ObservationIgnored private var contactRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var accountBackupBaseline: NostrAppBackupPayload?
    @ObservationIgnored private var managedAccountBackupBoardIDs: Set<String> = []
    @ObservationIgnored private var lastAccountBackupCreatedAt = 0
    @ObservationIgnored private var lastNostrCreatedAt = 0
    @ObservationIgnored private var accountBackupPublishPending = false
    @ObservationIgnored private var syncState: TaskSyncState = .connecting
    @ObservationIgnored private var lastContactRefreshAt: Date?
    @ObservationIgnored private var walletPaymentDeliveryHandler: (() -> Void)?

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
        accountBackupSearchTask?.cancel()
        accountBackupPublishTask?.cancel()
        contactRefreshTask?.cancel()
    }

    var visibleBoards: [Board] { snapshot.visibleBoards }
    var boardsForManagement: [Board] {
        snapshot.boards.filter { !$0.hidden && $0.kind != .bible }
    }
    var selectedBoard: Board? { snapshot.selectedBoard }
    var selectedBoardID: String { snapshot.selectedBoardID }
    var sharedInboxItems: [SharedInboxItem] { snapshot.sharedInbox }
    var sharedContactInboxItems: [SharedContactInboxItem] { snapshot.sharedContactInbox }
    var sharedCalendarInviteItems: [SharedCalendarInviteInboxItem] { snapshot.sharedCalendarInvites }
    var taskifyEvents: [TaskifyEvent] { snapshot.acceptedTaskifyEvents }
    var walletPaymentRequestRelayURLs: [String] { sharedInboxRelayURLs }
    var pendingSharedInboxCount: Int { snapshot.pendingSharedInboxCount }
    var recentSharedTaskRecipients: [SharedTaskRecipient] { snapshot.recentSharedTaskRecipients }
    var nostrContacts: [NostrContact] { snapshot.contactDirectory }
    var directMessageThreads: [NostrDirectMessageThread] { snapshot.directMessageThreads() }
    var groupConversations: [NostrGroupConversation] { snapshot.groupConversations }
    var syncIsOnline: Bool {
        if case .online = syncState { return true }
        return false
    }

    func registerWalletPaymentReceiver(_ wallet: WalletViewModel) {
        walletPaymentDeliveryHandler = { [weak wallet] in
            wallet?.paymentDeliveryWasQueued()
        }
    }

    func task(withID taskID: String) -> TaskItem? {
        snapshot.tasks.first { $0.id == taskID && !$0.isDeleted }
    }

    func board(withID boardID: String) -> Board? {
        snapshot.boards.first { $0.id == boardID }
    }

    func directMessages(with peerPublicKey: String) -> [NostrDirectMessage] {
        snapshot.directMessages(with: peerPublicKey)
    }

    func directMessageReactions(for message: NostrDirectMessage) -> [NostrDirectMessageReaction] {
        snapshot.directMessageReactions(for: message)
    }

    func isDirectMessageThreadArchived(_ peerPublicKey: String) -> Bool {
        snapshot.isDirectMessageThreadArchived(peerPublicKey)
    }

    func isDirectMessagePeerBlocked(_ peerPublicKey: String) -> Bool {
        snapshot.isDirectMessagePeerBlocked(peerPublicKey)
    }

    func isDirectMessageGroupMuted(_ groupID: String) -> Bool {
        snapshot.isDirectMessageGroupMuted(groupID)
    }

    func hasLeftDirectMessageGroup(_ groupID: String) -> Bool {
        snapshot.hasLeftDirectMessageGroup(groupID)
    }

    func groupConversation(id: String) -> NostrGroupConversation? {
        snapshot.groupConversation(id: id)
    }

    @discardableResult
    func createGroupConversation(name: String, memberPublicKeys: [String]) throws -> String {
        let timestamp = nextNostrTimestamp()
        guard !identityPublicKey.isEmpty,
              let group = NostrGroupConversation(
                name: name,
                memberPublicKeys: memberPublicKeys + [identityPublicKey],
                createdAt: timestamp,
                nameUpdatedAt: timestamp
              ),
              group.memberPublicKeys.count >= 3 else {
            throw NostrDirectMessageError.invalidGroup
        }
        if snapshot.upsertGroupConversation(group) { scheduleSave() }
        return group.groupID
    }

    /// Renames a group using the PWA's metadata-only NIP-17 rumor contract.
    /// The local metadata is updated first so the rename remains usable offline;
    /// every later group message also carries the latest subject as a fallback.
    @discardableResult
    func renameGroupConversation(groupID: String, name: String) async throws -> Bool {
        let nextName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !nextName.isEmpty else { throw NostrDirectMessageError.emptyGroupName }
        guard let identity = try identityStore.load() else {
            throw NostrDirectMessageError.identityUnavailable
        }
        guard let group = snapshot.groupConversation(id: groupID) else {
            throw NostrDirectMessageError.groupUnavailable
        }
        guard group.memberPublicKeys.contains(identity.publicKeyHex) else {
            throw NostrDirectMessageError.invalidGroup
        }
        guard nextName != group.name else { return true }

        let timestamp = nextNostrTimestamp(after: group.nameUpdatedAt ?? group.createdAt)
        guard let renamedGroup = NostrGroupConversation(
            name: nextName,
            memberPublicKeys: group.memberPublicKeys,
            createdAt: group.createdAt,
            nameUpdatedAt: timestamp
        ) else { throw NostrDirectMessageError.invalidGroup }
        if snapshot.upsertGroupConversation(renamedGroup) { scheduleSave() }

        let relayMap = await groupDeliveryRelays(group: renamedGroup, identity: identity)
        let recipientRelays = relayMap.values.flatMap { $0 }
        guard !recipientRelays.isEmpty else { return false }

        let rumor = try NIP17Rumor(
            publicKey: identity.publicKeyHex,
            createdAt: timestamp,
            kind: NIP17GiftWrap.rumorKind,
            tags: renamedGroup.memberPublicKeys.map { ["p", $0] } + [["subject", nextName]],
            content: ""
        )
        for member in renamedGroup.memberPublicKeys where member != identity.publicKeyHex {
            guard let publicKey = NostrPublicKey.parse(member),
                  let relays = relayMap[member], !relays.isEmpty else { continue }
            let wrap = try NIP17GiftWrap.wrap(
                rumor: rumor,
                sender: identity,
                recipientPublicKey: publicKey
            )
            try await syncEngine.publish(
                wrap,
                relayURLs: relays,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "group-metadata:\(renamedGroup.groupID):\(member)"
            )
        }

        let allRelays = TaskifyRelayURL.normalizedList(sharedInboxRelayURLs + recipientRelays)
        let selfWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: identity.publicKey
        )
        try await syncEngine.publish(
            selfWrap,
            relayURLs: allRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "group-metadata:\(renamedGroup.groupID):sender"
        )
        reconfigureChatRelays(allRelays, identity: identity)
        return true
    }

    func nostrContact(publicKey: String) -> NostrContact? {
        snapshot.contact(publicKeyValue: publicKey)
    }

    func markDirectMessageThreadRead(peerPublicKey: String) {
        guard snapshot.markDirectMessageThreadRead(peerPublicKey: peerPublicKey) else { return }
        scheduleSave()
    }

    func archiveDirectMessageThread(peerPublicKey: String) {
        guard snapshot.archiveDirectMessageThread(peerPublicKey: peerPublicKey) else { return }
        scheduleSave()
    }

    func unarchiveDirectMessageThread(peerPublicKey: String) {
        guard snapshot.unarchiveDirectMessageThread(peerPublicKey: peerPublicKey) else { return }
        scheduleSave()
    }

    func deleteDirectMessageThread(peerPublicKey: String) {
        guard snapshot.deleteDirectMessageThread(peerPublicKey: peerPublicKey) else { return }
        scheduleSave()
    }

    func setDirectMessagePeerBlocked(_ peerPublicKey: String, blocked: Bool) {
        guard snapshot.setDirectMessagePeerBlocked(peerPublicKey, blocked: blocked) else { return }
        if blocked {
            _ = snapshot.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
        }
        scheduleSave()
    }

    func setDirectMessageGroupMuted(_ groupID: String, muted: Bool) {
        guard snapshot.setDirectMessageGroupMuted(groupID, muted: muted) else { return }
        if muted {
            _ = snapshot.markDirectMessageThreadRead(peerPublicKey: groupID)
        }
        scheduleSave()
    }

    func setDirectMessageGroupLeft(_ groupID: String, left: Bool) {
        guard snapshot.setDirectMessageGroupLeft(groupID, left: left) else { return }
        scheduleSave()
    }

    func taskCount(forBoardID boardID: String) -> Int {
        snapshot.tasks.filter { $0.boardID == boardID && !$0.isDeleted }.count
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

    func tasks(boardID: String, columnID: String, includeCompleted: Bool) -> [TaskItem] {
        snapshot.tasks(
            boardID: boardID,
            columnID: columnID,
            includeCompleted: includeCompleted
        )
    }

    func compoundChildBoards(for boardID: String) -> [Board] {
        snapshot.compoundChildBoards(for: boardID)
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

    func addQuickTask(title: String, boardID: String, columnID: String) {
        guard let board = snapshot.boards.first(where: { $0.id == boardID && $0.kind == .list }),
              board.columns.contains(where: { $0.id == columnID }) else { return }
        guard let task = snapshot.addTask(
            title: title,
            boardID: board.id,
            columnID: columnID,
            dueDate: nil,
            authorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(task.id)
    }

    @discardableResult
    func moveTask(
        _ taskID: String,
        toBoardID targetBoardID: String,
        columnID targetColumnID: String,
        beforeTaskID: String? = nil
    ) -> Bool {
        guard let sourceTask = task(withID: taskID),
              let sourceBoard = board(withID: sourceTask.boardID),
              let result = snapshot.moveTask(
                taskID: taskID,
                toBoardID: targetBoardID,
                columnID: targetColumnID,
                beforeTaskID: beforeTaskID,
                editorPublicKey: identityPublicKey.nilIfEmpty
              ) else { return false }

        if result.crossedBoards {
            synchronizeTaskMove(
                taskID,
                sourceTask: sourceTask,
                sourceBoard: sourceBoard
            )
            result.updatedTaskIDs
                .filter { $0 != taskID }
                .forEach { synchronizeTask($0) }
        } else {
            result.updatedTaskIDs.forEach { synchronizeTask($0) }
        }
        refreshNotifications(requestPermission: false)
        return true
    }

    func addTask(title: String, dueDate: Date) {
        guard let selectedBoard else { return }
        let board: Board
        let columnID: String?
        switch selectedBoard.kind {
        case .week:
            board = selectedBoard
            columnID = WeekdayColumn.containing(dueDate).rawValue
        case .list:
            board = selectedBoard
            columnID = selectedBoard.columns.sorted { $0.order < $1.order }.first?.id
        case .compound:
            guard let child = snapshot.compoundChildBoards(for: selectedBoard.id).first else { return }
            board = child
            columnID = child.columns.sorted { $0.order < $1.order }.first?.id
        case .bible:
            return
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
    func addTaskifyEvent(
        title: String,
        details: String,
        location: String,
        startDate: Date,
        endDate: Date,
        isAllDay: Bool,
        boardID requestedBoardID: String
    ) -> Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty,
              let board = snapshot.boards.first(where: {
                  $0.id == requestedBoardID && $0.isVisible && ($0.kind == .week || $0.kind == .list)
              }) else { return false }
        let eventID = UUID().uuidString
        let order = (snapshot.taskifyEvents ?? [])
            .filter { $0.boardID == board.id }
            .compactMap(\.order)
            .max()
            .map { $0 + 1 } ?? 0
        let resolvedEnd = isAllDay
            ? max(startDate, endDate)
            : (endDate > startDate ? endDate : startDate.addingTimeInterval(60 * 60))
        let event = TaskifyEvent(
            id: eventID,
            boardID: board.id,
            columnID: board.kind == .list
                ? board.columns.sorted(by: { $0.order < $1.order }).first?.id
                : nil,
            order: order,
            title: trimmedTitle,
            details: details.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            locations: location.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty.map { [$0] },
            schedule: isAllDay ? .date : .time,
            startDateValue: isAllDay ? Self.taskifyDateValue(startDate) : nil,
            endDateValue: isAllDay ? Self.taskifyDateValue(resolvedEnd) : nil,
            startISO: isAllDay ? nil : Self.taskifyISOValue(startDate),
            endISO: isAllDay ? nil : Self.taskifyISOValue(resolvedEnd),
            startTimeZoneID: isAllDay ? nil : TimeZone.current.identifier,
            endTimeZoneID: isAllDay ? nil : TimeZone.current.identifier,
            createdBy: identityPublicKey.nilIfEmpty,
            lastEditedBy: identityPublicKey.nilIfEmpty,
            canonicalAddress: "",
            viewAddress: "",
            eventKey: TaskifyCalendarEventCodec.generateEventKey(),
            inviteToken: "",
            relayURLs: board.effectiveRelayURLs,
            rsvpStatus: .accepted,
            readOnly: false,
            deleted: false
        )
        _ = snapshot.upsertTaskifyEvent(event)
        synchronizeTaskifyEvent(eventID)
        return true
    }

    @discardableResult
    func updateTaskifyEvent(
        eventID: String,
        title: String,
        details: String,
        location: String,
        startDate: Date,
        endDate: Date,
        isAllDay: Bool
    ) -> Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty,
              var events = snapshot.taskifyEvents,
              let index = events.firstIndex(where: { $0.id == eventID && !$0.isReadOnly && !$0.isDeleted }) else {
            return false
        }
        let resolvedEnd = isAllDay
            ? max(startDate, endDate)
            : (endDate > startDate ? endDate : startDate.addingTimeInterval(60 * 60))
        events[index].title = trimmedTitle
        events[index].details = details.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        events[index].locations = location.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty.map { [$0] }
        events[index].schedule = isAllDay ? .date : .time
        events[index].startDateValue = isAllDay ? Self.taskifyDateValue(startDate) : nil
        events[index].endDateValue = isAllDay ? Self.taskifyDateValue(resolvedEnd) : nil
        events[index].startISO = isAllDay ? nil : Self.taskifyISOValue(startDate)
        events[index].endISO = isAllDay ? nil : Self.taskifyISOValue(resolvedEnd)
        events[index].startTimeZoneID = isAllDay ? nil : TimeZone.current.identifier
        events[index].endTimeZoneID = isAllDay ? nil : TimeZone.current.identifier
        events[index].lastEditedBy = identityPublicKey.nilIfEmpty
        events[index].deleted = false
        snapshot.taskifyEvents = events
        synchronizeTaskifyEvent(eventID)
        return true
    }

    func deleteTaskifyEvent(_ eventID: String) {
        guard var events = snapshot.taskifyEvents,
              let index = events.firstIndex(where: { $0.id == eventID && !$0.isReadOnly && !$0.isDeleted }) else {
            return
        }
        events[index].deleted = true
        events[index].lastEditedBy = identityPublicKey.nilIfEmpty
        snapshot.taskifyEvents = events
        synchronizeTaskifyEvent(eventID)
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

    /// Shifts a task's due date forward by the given number of days, preserving its due time.
    /// A touch-friendly counterpart to the PWA's "drag onto Upcoming to postpone a week" gesture.
    @discardableResult
    func postponeTask(_ taskID: String, byDays days: Int) -> Bool {
        guard let task = task(withID: taskID),
              task.dueDateEnabled,
              let dueDate = task.dueDate,
              let nextDueDate = Calendar.current.date(byAdding: .day, value: days, to: dueDate) else {
            return false
        }
        return updateTask(
            taskID: taskID,
            title: task.title,
            note: task.note,
            dueDate: nextDueDate,
            dueDateEnabled: true,
            dueTimeEnabled: task.dueTimeEnabled,
            priority: task.priority,
            columnID: task.columnID,
            subtasks: task.subtasks ?? [],
            recurrence: task.recurrence,
            reminders: task.reminders ?? [],
            reminderTime: task.reminderTime,
            images: task.images ?? [],
            documents: task.documents ?? []
        )
    }

    func toggleCompletion(_ taskID: String) {
        let existingIDs = Set(snapshot.tasks.map(\.id))
        guard snapshot.toggleCompletion(
            taskID: taskID,
            editorPublicKey: identityPublicKey.nilIfEmpty,
            streaksEnabled: streaksEnabled
        ) else { return }
        synchronizeTask(taskID)
        snapshot.tasks
            .map(\.id)
            .filter { !existingIDs.contains($0) }
            .forEach { synchronizeTask($0) }
        refreshNotifications(requestPermission: false)
        reconcileScriptureMemory()
    }

    func deleteTask(_ taskID: String) {
        guard snapshot.deleteTask(taskID: taskID, editorPublicKey: identityPublicKey.nilIfEmpty) else { return }
        synchronizeTask(taskID, includeDeletionEvent: true)
        refreshNotifications(requestPermission: false)
        reconcileScriptureMemory()
    }

    /// Deletes every completed task on a board (and, for compound boards, its linked child boards),
    /// mirroring the PWA's "Clear completed" action.
    func clearCompletedTasks(forBoardID boardID: String) {
        let scopeIDs: Set<String>
        if let board = board(withID: boardID), board.kind == .compound {
            scopeIDs = Set(compoundChildBoards(for: boardID).map(\.id))
        } else {
            scopeIDs = [boardID]
        }

        let targetIDs = snapshot.tasks
            .filter { !$0.isDeleted && $0.completed && scopeIDs.contains($0.boardID) }
            .map(\.id)
        guard !targetIDs.isEmpty else { return }

        for taskID in targetIDs {
            guard snapshot.deleteTask(taskID: taskID, editorPublicKey: identityPublicKey.nilIfEmpty) else { continue }
            synchronizeTask(taskID, includeDeletionEvent: true)
        }
        refreshNotifications(requestPermission: false)
    }

    func requestNotificationPermission() {
        refreshNotifications(requestPermission: true)
    }

    func refreshNotificationStatus() {
        refreshNotifications(requestPermission: false)
    }

    @discardableResult
    func updateEncryptedMediaServer(_ value: String) -> Bool {
        guard let normalized = TaskifyMediaServerSettings.save(value) else {
            errorMessage = "Enter a valid HTTPS Originless server address."
            return false
        }
        encryptedMediaServerURL = normalized
        scheduleAccountBackupPublish()
        return true
    }

    func resetEncryptedMediaServer() {
        TaskifyMediaServerSettings.reset()
        encryptedMediaServerURL = TaskifyMediaServerSettings.configuredServer
        scheduleAccountBackupPublish()
    }

    func retrySync() {
        syncStatus = "Connecting"
        syncDetail = "Retrying relay connections"
        if accountBackupPublishPending {
            scheduleAccountBackupPublish()
        }
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
    func respondToSharedInboxItem(
        _ itemID: String,
        status: SharedInboxItemStatus
    ) -> Bool {
        guard let item = snapshot.sharedInbox.first(where: { $0.id == itemID }),
              item.status == .pending,
              (status == .accepted || status == .declined || status == .tentative) else {
            return false
        }

        var acceptedTaskID: String?
        if status == .accepted {
            guard let destination = sharedInboxDestination(),
                  let task = snapshot.acceptSharedTask(
                      inboxItemID: itemID,
                      destinationBoardID: destination.boardID,
                      destinationColumnID: destination.columnID,
                      recipientPublicKey: identityPublicKey
                  ) else { return false }
            acceptedTaskID = task.id
        } else {
            guard snapshot.setSharedInboxStatus(itemID: itemID, status: status) != nil else {
                return false
            }
        }

        scheduleSave()
        if let acceptedTaskID {
            synchronizeTask(acceptedTaskID)
            refreshNotifications(requestPermission: false)
        }
        if item.task.isAssignment,
           (status == .accepted || status == .declined || status == .tentative) {
            sendSharedTaskAssignmentResponse(item: item, status: status)
        }
        return true
    }

    func dismissSharedInboxItem(_ itemID: String) {
        guard snapshot.setSharedInboxStatus(itemID: itemID, status: .deleted) != nil else { return }
        scheduleSave()
    }

    func acceptSharedContactInboxItem(_ itemID: String) async throws {
        guard let item = snapshot.sharedContactInbox.first(where: { $0.id == itemID }),
              item.status == .pending else { return }
        if snapshot.contact(publicKeyValue: item.contact.npub) != nil {
            _ = snapshot.setSharedContactInboxStatus(itemID: itemID, status: .accepted)
            scheduleSave()
            return
        }
        _ = try await saveNostrContact(
            publicKeyValue: item.contact.npub,
            petname: item.contact.displayName ?? item.contact.name,
            relayURL: item.contact.relayURLs?.first
        )
        guard snapshot.setSharedContactInboxStatus(itemID: itemID, status: .accepted) != nil else {
            return
        }
        scheduleSave()
    }

    func dismissSharedContactInboxItem(_ itemID: String) {
        guard snapshot.setSharedContactInboxStatus(itemID: itemID, status: .deleted) != nil else { return }
        scheduleSave()
    }

    func setSharedCalendarInviteStatus(_ itemID: String, status: SharedInboxItemStatus) {
        guard status == .accepted || status == .declined || status == .tentative || status == .deleted,
              snapshot.setSharedCalendarInviteStatus(itemID: itemID, status: status) != nil else {
            return
        }
        scheduleSave()
    }

    func respondToSharedCalendarInvite(
        _ itemID: String,
        status: SharedInboxItemStatus
    ) async throws {
        guard status == .accepted || status == .declined || status == .tentative,
              let item = snapshot.sharedCalendarInvites.first(where: { $0.id == itemID }) else {
            return
        }
        guard let identity = try identityStore.load() else {
            throw StructuredShareSendError.identityUnavailable
        }
        let relayURLs = TaskifyRelayURL.normalizedList(
            (item.event.relayURLs ?? []) + sharedInboxRelayURLs
        )
        guard !relayURLs.isEmpty else { throw StructuredShareSendError.noRelays }

        if status == .accepted || status == .tentative {
            let taskifyEvent = try await TaskifyEventInvitationResolver.resolve(
                invite: item.event,
                status: status,
                relayURLs: relayURLs
            )
            _ = snapshot.upsertTaskifyEvent(taskifyEvent)
            scheduleSave()
        }

        let event = try SharedCalendarRSVPContract.event(
            invite: item.event,
            status: status,
            identity: identity,
            createdAt: nextNostrTimestamp()
        )
        try await syncEngine.publish(
            event,
            relayURLs: relayURLs,
            outboxScope: Self.sharedInboxOutboxScope,
            recordID: "calendar-rsvp:\(item.event.eventID):\(identity.publicKeyHex)"
        )
        guard snapshot.setSharedCalendarInviteStatus(itemID: itemID, status: status) != nil else {
            return
        }
        scheduleSave()
    }

    func sendSharedTask(
        taskID: String,
        recipientValue: String,
        assignment: Bool
    ) async throws -> SharedTaskSendResult {
        guard let task = task(withID: taskID),
              let board = board(withID: task.boardID) else {
            throw SharedTaskSendError.taskUnavailable
        }
        guard let recipientPublicKey = NostrPublicKey.parse(recipientValue),
              let recipientNpub = NostrPublicKey.npub(from: recipientPublicKey) else {
            throw SharedTaskSendError.invalidRecipient
        }
        guard recipientPublicKey.hexString != identityPublicKey else {
            throw SharedTaskSendError.cannotSendToSelf
        }
        guard let identity = try identityStore.load() else {
            throw SharedTaskSendError.identityUnavailable
        }

        let knownContactRelays = snapshot.contact(
            publicKeyValue: recipientPublicKey.hexString
        )?.relayURLs ?? []
        let fallbackRelays = TaskifyRelayURL.normalizedList(
            knownContactRelays + board.effectiveRelayURLs + sharedInboxRelayURLs
        )
        guard !fallbackRelays.isEmpty else { throw SharedTaskSendError.noRelays }
        let recipientHex = recipientPublicKey.hexString
        let deliveryRelays = syncIsOnline
            ? await NIP17InboxRelayResolver.resolve(
                recipientPublicKey: recipientHex,
                fallbackRelayURLs: fallbackRelays
            )
            : fallbackRelays
        guard !deliveryRelays.isEmpty else { throw SharedTaskSendError.noRelays }

        let delivery = SharedTaskDelivery(
            task: task,
            relayURLs: deliveryRelays,
            assignmentRecipientPublicKey: assignment ? recipientHex : nil
        )
        let envelope = TaskifyShareEnvelope(
            item: .task(delivery),
            senderNpub: identity.npub
        )
        let event = try NIP17GiftWrap.wrap(
            envelope: envelope,
            sender: identity,
            recipientPublicKey: recipientPublicKey
        )

        snapshot.upsertSharedTaskRecipient(SharedTaskRecipient(
            publicKey: recipientHex,
            npub: recipientNpub,
            relayURLs: deliveryRelays
        ))
        scheduleSave()
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: sharedInboxRelayURLs,
            inboxPublicKey: identityPublicKey.nilIfEmpty
        )
        try await syncEngine.publish(
            event,
            relayURLs: deliveryRelays,
            outboxScope: Self.sharedInboxOutboxScope,
            recordID: assignment
                ? "assignment:\(task.id):\(recipientHex)"
                : "share:\(event.id)"
        )

        if assignment,
           snapshot.markTaskAssigned(
               taskID: task.id,
               recipientPublicKey: recipientHex,
               recipientRelayURL: deliveryRelays.first,
               editorPublicKey: identity.publicKeyHex
           ) != nil {
            scheduleSave()
            synchronizeTask(task.id)
        }
        return SharedTaskSendResult(
            recipientNpub: recipientNpub,
            relayCount: deliveryRelays.count,
            assignment: assignment
        )
    }

    func sendSharedContact(
        contactPublicKey: String,
        to recipientValue: String
    ) async throws {
        guard let contact = snapshot.contact(publicKeyValue: contactPublicKey) else {
            throw StructuredShareSendError.contactUnavailable
        }
        guard let recipientPublicKey = NostrPublicKey.parse(recipientValue) else {
            throw StructuredShareSendError.invalidRecipient
        }
        guard recipientPublicKey.hexString != identityPublicKey else {
            throw StructuredShareSendError.cannotSendToSelf
        }
        guard let identity = try identityStore.load() else {
            throw StructuredShareSendError.identityUnavailable
        }
        let knownRecipientRelays = snapshot.contact(
            publicKeyValue: recipientPublicKey.hexString
        )?.relayURLs ?? []
        let fallbackRelays = TaskifyRelayURL.normalizedList(
            knownRecipientRelays + contact.relayURLs + sharedInboxRelayURLs
        )
        guard !fallbackRelays.isEmpty else { throw StructuredShareSendError.noRelays }
        let deliveryRelays = syncIsOnline
            ? await NIP17InboxRelayResolver.resolve(
                recipientPublicKey: recipientPublicKey.hexString,
                fallbackRelayURLs: fallbackRelays
            )
            : fallbackRelays
        guard !deliveryRelays.isEmpty else { throw StructuredShareSendError.noRelays }

        var delivery = SharedContactDelivery(contact: contact)
        let contactRelays = TaskifyRelayURL.normalizedList(
            (delivery.relayURLs ?? []) + deliveryRelays
        )
        delivery.relayURLs = contactRelays.isEmpty ? nil : contactRelays
        let envelope = TaskifyShareEnvelope(
            item: .contact(delivery),
            senderNpub: identity.npub
        )
        let event = try NIP17GiftWrap.wrap(
            envelope: envelope,
            sender: identity,
            recipientPublicKey: recipientPublicKey
        )
        try await syncEngine.publish(
            event,
            relayURLs: deliveryRelays,
            outboxScope: Self.sharedInboxOutboxScope,
            recordID: "contact-share:\(event.id)"
        )
    }

    func sendDirectMessage(
        to recipientValue: String,
        content: String,
        replyToEventID: String? = nil
    ) async throws {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw NostrDirectMessageError.emptyMessage }
        try await publishDirectMessageRumor(
            to: recipientValue,
            kind: NIP17GiftWrap.rumorKind,
            content: text,
            additionalTags: [],
            replyToEventID: replyToEventID
        )
    }

    func sendDirectMessageAttachment(
        to recipientValue: String,
        attachment: NostrDirectMessageAttachment,
        replyToEventID: String? = nil
    ) async throws {
        guard let validated = NostrDirectMessageAttachment(
            url: attachment.url,
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            size: attachment.size,
            width: attachment.width,
            height: attachment.height,
            algorithm: attachment.algorithm,
            keyHex: attachment.keyHex,
            nonceHex: attachment.nonceHex,
            sha256: attachment.sha256
        ) else {
            throw NostrDirectMessageError.invalidAttachment
        }
        try await publishDirectMessageRumor(
            to: recipientValue,
            kind: NostrDirectMessageAttachment.rumorKind,
            content: validated.url,
            additionalTags: validated.rumorTags,
            replyToEventID: replyToEventID
        )
    }

    private func publishDirectMessageRumor(
        to recipientValue: String,
        kind: Int,
        content: String,
        additionalTags: [[String]],
        replyToEventID: String?
    ) async throws {
        if let group = snapshot.groupConversation(id: recipientValue) {
            guard !snapshot.hasLeftDirectMessageGroup(group.groupID) else {
                throw NostrDirectMessageError.leftGroup
            }
            try await publishGroupRumor(
                group: group,
                kind: kind,
                content: content,
                additionalTags: additionalTags,
                replyToEventID: replyToEventID
            )
            return
        }
        guard let identity = try identityStore.load() else {
            throw NostrDirectMessageError.identityUnavailable
        }
        guard let recipientPublicKey = NostrPublicKey.parse(recipientValue) else {
            throw NostrDirectMessageError.invalidRecipient
        }
        let recipientHex = recipientPublicKey.hexString
        guard recipientHex != identity.publicKeyHex else {
            throw NostrDirectMessageError.cannotMessageSelf
        }

        let contactRelays = snapshot.contact(publicKeyValue: recipientHex)?.relayURLs ?? []
        let rememberedRelays = snapshot.directMessages(with: recipientHex)
            .flatMap { $0.relayURLs ?? [] }
        let fallbackRelays = TaskifyRelayURL.normalizedList(
            contactRelays + rememberedRelays + sharedInboxRelayURLs
        )
        guard !fallbackRelays.isEmpty else { throw NostrDirectMessageError.noRelays }
        let deliveryRelays = syncIsOnline
            ? await NIP17InboxRelayResolver.resolve(
                recipientPublicKey: recipientHex,
                fallbackRelayURLs: fallbackRelays
            )
            : fallbackRelays
        guard !deliveryRelays.isEmpty else { throw NostrDirectMessageError.noRelays }

        var rumorTags = [["p", recipientHex]] + additionalTags
        if let replyID = replyToEventID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
           replyID.count == 64,
           (try? Data(hex: replyID)) != nil {
            rumorTags.append(["e", replyID])
        }

        let rumor = try NIP17Rumor(
            publicKey: identity.publicKeyHex,
            createdAt: nextNostrTimestamp(),
            kind: kind,
            tags: rumorTags,
            content: content
        )
        let recipientWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: recipientPublicKey
        )
        let senderWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: identity.publicKey
        )
        let decrypted = NIP17DecryptedRumor(
            wrapEventID: senderWrap.id,
            rumor: rumor
        )
        guard let localMessage = NostrDirectMessage(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex,
            relayURLs: deliveryRelays
        ) else { throw NostrDirectMessageError.invalidRecipient }

        if snapshot.ingestDirectMessage(localMessage) { scheduleSave() }
        let allDeliveryRelays = TaskifyRelayURL.normalizedList(
            sharedInboxRelayURLs + deliveryRelays
        )
        try await syncEngine.publish(
            recipientWrap,
            relayURLs: deliveryRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):recipient"
        )
        try await syncEngine.publish(
            senderWrap,
            relayURLs: allDeliveryRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):sender"
        )
        let boards = snapshot.boardsForSync
        Task { [syncEngine] in
            await syncEngine.configure(
                boards: boards,
                auxiliaryRelayURLs: allDeliveryRelays,
                inboxPublicKey: identity.publicKeyHex
            )
        }
    }

    func sendDirectMessageReaction(
        to message: NostrDirectMessage,
        emoji: String
    ) async throws {
        let value = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw NostrDirectMessageError.emptyMessage }
        guard let identity = try identityStore.load() else {
            throw NostrDirectMessageError.identityUnavailable
        }
        if let groupID = message.groupID,
           let group = snapshot.groupConversation(id: groupID) {
            guard !snapshot.hasLeftDirectMessageGroup(group.groupID) else {
                throw NostrDirectMessageError.leftGroup
            }
            try await publishGroupReaction(
                group: group,
                message: message,
                emoji: value,
                identity: identity
            )
            return
        }
        guard let recipientPublicKey = NostrPublicKey.parse(message.peerPublicKey) else {
            throw NostrDirectMessageError.invalidRecipient
        }
        let recipientHex = recipientPublicKey.hexString
        let contactRelays = snapshot.contact(publicKeyValue: recipientHex)?.relayURLs ?? []
        let rememberedRelays = snapshot.directMessages(with: recipientHex)
            .flatMap { $0.relayURLs ?? [] }
        let fallbackRelays = TaskifyRelayURL.normalizedList(
            contactRelays + rememberedRelays + sharedInboxRelayURLs
        )
        guard !fallbackRelays.isEmpty else { throw NostrDirectMessageError.noRelays }
        let deliveryRelays = syncIsOnline
            ? await NIP17InboxRelayResolver.resolve(
                recipientPublicKey: recipientHex,
                fallbackRelayURLs: fallbackRelays
            )
            : fallbackRelays
        guard !deliveryRelays.isEmpty else { throw NostrDirectMessageError.noRelays }

        let rumor = try NIP17Rumor(
            publicKey: identity.publicKeyHex,
            createdAt: nextNostrTimestamp(),
            kind: 7,
            tags: [
                ["p", recipientHex],
                ["e", message.rumorEventID],
                ["p", message.senderPublicKey],
            ],
            content: value
        )
        let recipientWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: recipientPublicKey
        )
        let senderWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: identity.publicKey
        )
        let decrypted = NIP17DecryptedRumor(wrapEventID: senderWrap.id, rumor: rumor)
        guard let localReaction = NostrDirectMessageReaction(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex
        ) else { throw NostrDirectMessageError.invalidRecipient }
        if snapshot.ingestDirectMessageReaction(localReaction) { scheduleSave() }

        let allDeliveryRelays = TaskifyRelayURL.normalizedList(
            sharedInboxRelayURLs + deliveryRelays
        )
        try await syncEngine.publish(
            recipientWrap,
            relayURLs: deliveryRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):reaction:recipient"
        )
        try await syncEngine.publish(
            senderWrap,
            relayURLs: allDeliveryRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):reaction:sender"
        )
        let boards = snapshot.boardsForSync
        Task { [syncEngine] in
            await syncEngine.configure(
                boards: boards,
                auxiliaryRelayURLs: allDeliveryRelays,
                inboxPublicKey: identity.publicKeyHex
            )
        }
    }

    private func publishGroupRumor(
        group: NostrGroupConversation,
        kind: Int,
        content: String,
        additionalTags: [[String]],
        replyToEventID: String?
    ) async throws {
        guard let identity = try identityStore.load() else {
            throw NostrDirectMessageError.identityUnavailable
        }
        guard group.memberPublicKeys.contains(identity.publicKeyHex),
              group.memberPublicKeys.count <= NostrGroupConversation.maximumMemberCount else {
            throw NostrDirectMessageError.invalidGroup
        }
        var tags = group.memberPublicKeys.map { ["p", $0] }
        if !group.name.isEmpty { tags.append(["subject", group.name]) }
        tags.append(contentsOf: additionalTags)
        if let replyID = validNostrEventID(replyToEventID) { tags.append(["e", replyID]) }
        let rumor = try NIP17Rumor(
            publicKey: identity.publicKeyHex,
            createdAt: nextNostrTimestamp(),
            kind: kind,
            tags: tags,
            content: content
        )
        let relayMap = await groupDeliveryRelays(group: group, identity: identity)
        let recipientRelays = relayMap.values.flatMap { $0 }
        guard !recipientRelays.isEmpty else { throw NostrDirectMessageError.noRelays }

        let selfWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: identity.publicKey
        )
        let decrypted = NIP17DecryptedRumor(wrapEventID: selfWrap.id, rumor: rumor)
        guard let localMessage = NostrDirectMessage(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex,
            relayURLs: recipientRelays
        ) else { throw NostrDirectMessageError.invalidGroup }
        if snapshot.ingestDirectMessage(localMessage) { scheduleSave() }

        for member in group.memberPublicKeys where member != identity.publicKeyHex {
            guard let publicKey = NostrPublicKey.parse(member),
                  let relays = relayMap[member], !relays.isEmpty else { continue }
            let wrap = try NIP17GiftWrap.wrap(
                rumor: rumor,
                sender: identity,
                recipientPublicKey: publicKey
            )
            try await syncEngine.publish(
                wrap,
                relayURLs: relays,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "\(rumor.id):group:\(member)"
            )
        }
        let allRelays = TaskifyRelayURL.normalizedList(sharedInboxRelayURLs + recipientRelays)
        try await syncEngine.publish(
            selfWrap,
            relayURLs: allRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):group:sender"
        )
        reconfigureChatRelays(allRelays, identity: identity)
    }

    private func publishGroupReaction(
        group: NostrGroupConversation,
        message: NostrDirectMessage,
        emoji: String,
        identity: NostrIdentity
    ) async throws {
        guard group.memberPublicKeys.contains(identity.publicKeyHex) else {
            throw NostrDirectMessageError.invalidGroup
        }
        var tags = group.memberPublicKeys.map { ["p", $0] }
        tags.append(["e", message.rumorEventID])
        tags.append(["p", message.senderPublicKey])
        let rumor = try NIP17Rumor(
            publicKey: identity.publicKeyHex,
            createdAt: nextNostrTimestamp(),
            kind: 7,
            tags: tags,
            content: emoji
        )
        let relayMap = await groupDeliveryRelays(group: group, identity: identity)
        let recipientRelays = relayMap.values.flatMap { $0 }
        guard !recipientRelays.isEmpty else { throw NostrDirectMessageError.noRelays }
        let selfWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: identity.publicKey
        )
        guard let localReaction = NostrDirectMessageReaction(
            decrypted: NIP17DecryptedRumor(wrapEventID: selfWrap.id, rumor: rumor),
            identityPublicKey: identity.publicKeyHex
        ) else { throw NostrDirectMessageError.invalidGroup }
        if snapshot.ingestDirectMessageReaction(localReaction) { scheduleSave() }

        for member in group.memberPublicKeys where member != identity.publicKeyHex {
            guard let publicKey = NostrPublicKey.parse(member),
                  let relays = relayMap[member], !relays.isEmpty else { continue }
            let wrap = try NIP17GiftWrap.wrap(
                rumor: rumor,
                sender: identity,
                recipientPublicKey: publicKey
            )
            try await syncEngine.publish(
                wrap,
                relayURLs: relays,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "\(rumor.id):group-reaction:\(member)"
            )
        }
        let allRelays = TaskifyRelayURL.normalizedList(sharedInboxRelayURLs + recipientRelays)
        try await syncEngine.publish(
            selfWrap,
            relayURLs: allRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):group-reaction:sender"
        )
        reconfigureChatRelays(allRelays, identity: identity)
    }

    private func groupDeliveryRelays(
        group: NostrGroupConversation,
        identity: NostrIdentity
    ) async -> [String: [String]] {
        var result: [String: [String]] = [:]
        for member in group.memberPublicKeys where member != identity.publicKeyHex {
            let contactRelays = snapshot.contact(publicKeyValue: member)?.relayURLs ?? []
            let remembered = snapshot.directMessageHistory
                .filter { $0.groupID == group.groupID || $0.senderPublicKey == member }
                .flatMap { $0.relayURLs ?? [] }
            let fallback = TaskifyRelayURL.normalizedList(
                contactRelays + remembered + sharedInboxRelayURLs
            )
            guard !fallback.isEmpty else { continue }
            result[member] = syncIsOnline
                ? await NIP17InboxRelayResolver.resolve(
                    recipientPublicKey: member,
                    fallbackRelayURLs: fallback
                )
                : fallback
        }
        return result
    }

    private func validNostrEventID(_ value: String?) -> String? {
        guard let normalized = value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
              normalized.count == 64,
              (try? Data(hex: normalized))?.count == 32 else { return nil }
        return normalized
    }

    private func reconfigureChatRelays(_ relays: [String], identity: NostrIdentity) {
        let boards = snapshot.boardsForSync
        Task { [syncEngine] in
            await syncEngine.configure(
                boards: boards,
                auxiliaryRelayURLs: relays,
                inboxPublicKey: identity.publicKeyHex
            )
        }
    }

    func refreshContacts() {
        guard !isRefreshingContacts else { return }
        contactRefreshTask?.cancel()
        contactRefreshTask = Task { [weak self] in
            await self?.refreshContactsFromNostr(silent: false)
        }
    }

    func refreshContactsIfNeeded() {
        guard !isLoading,
              !isRefreshingContacts,
              lastContactRefreshAt.map({ Date().timeIntervalSince($0) > 60 }) ?? true else { return }
        refreshContacts()
    }

    @discardableResult
    func saveNostrContact(
        publicKeyValue: String,
        petname: String?,
        relayURL: String?
    ) async throws -> NostrContact {
        guard let identity = try identityStore.load() else {
            throw NostrContactDirectoryError.identityUnavailable
        }
        guard let key = NostrPublicKey.parse(publicKeyValue) else {
            throw NostrContactDirectoryError.invalidPublicKey
        }
        guard key.hexString != identity.publicKeyHex else {
            throw NostrContactDirectoryError.cannotAddSelf
        }

        contactSyncStatus = "Checking the latest private contact list…"
        await refreshContactsBeforeMutation()
        let fallback = TaskifyRelayURL.normalizedList(
            (relayURL.map { [$0] } ?? []) + contactsSyncRelayURLs
        )
        guard !fallback.isEmpty else { throw NostrContactDirectoryError.noRelays }
        let discovered = await NIP17InboxRelayResolver.resolve(
            recipientPublicKey: key.hexString,
            fallbackRelayURLs: fallback
        )
        let timestamp = nextNostrTimestamp(after: snapshot.contactsListUpdatedAt ?? 0)
        guard let contact = snapshot.upsertContact(
            publicKeyValue: key.hexString,
            relayURLs: discovered,
            petname: petname,
            updatedAt: timestamp
        ) else { throw NostrContactDirectoryError.invalidPublicKey }
        scheduleSave()
        try await publishContacts(identity: identity, createdAt: timestamp)

        let profiles = await NostrContactFinder.profiles(
            publicKeys: [contact.publicKey],
            relayURLs: discovered
        )
        if snapshot.applyContactProfiles(profiles) { scheduleSave() }
        contactSyncStatus = "Contacts synced privately"
        return snapshot.contact(publicKeyValue: contact.publicKey) ?? contact
    }

    func deleteNostrContact(publicKey: String) async throws {
        guard let identity = try identityStore.load() else {
            throw NostrContactDirectoryError.identityUnavailable
        }
        guard snapshot.contact(publicKeyValue: publicKey) != nil else {
            throw NostrContactDirectoryError.contactUnavailable
        }
        contactSyncStatus = "Checking the latest private contact list…"
        await refreshContactsBeforeMutation()
        let timestamp = nextNostrTimestamp(after: snapshot.contactsListUpdatedAt ?? 0)
        guard snapshot.removeContact(publicKeyValue: publicKey, updatedAt: timestamp) else {
            throw NostrContactDirectoryError.contactUnavailable
        }
        scheduleSave()
        try await publishContacts(identity: identity, createdAt: timestamp)
        contactSyncStatus = "Contacts synced privately"
    }

    func prepareForBackground() async {
        await persistImmediately()
        if accountBackupPublishPending {
            accountBackupPublishTask?.cancel()
            await publishAccountBackupSafely()
        }
        await syncEngine.flushQueuedPublishes()
        backgroundSyncStatus = pendingSyncChangeCount > 0
            ? "Queued for background delivery"
            : "Ready"
    }

    func performBackgroundRefresh() async -> Bool {
        let loadDeadline = Date().addingTimeInterval(5)
        while isLoading, Date() < loadDeadline, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard !Task.isCancelled, !isLoading else { return false }

        backgroundSyncStatus = "Refreshing"
        await persistImmediately()
        if accountBackupPublishPending {
            accountBackupPublishTask?.cancel()
            await publishAccountBackupSafely()
        }

        await syncEngine.retryNow()
        let listenUntil = Date().addingTimeInterval(3)
        let deadline = Date().addingTimeInterval(18)
        var remaining = await syncEngine.pendingPublishCount()

        while !Task.isCancelled, Date() < deadline {
            await syncEngine.flushQueuedPublishes()
            remaining = await syncEngine.pendingPublishCount()
            if remaining == 0, Date() >= listenUntil { break }
            try? await Task.sleep(for: .milliseconds(500))
        }

        guard !Task.isCancelled else { return false }
        await persistImmediately()
        backgroundSyncStatus = remaining == 0
            ? "Refreshed in background"
            : "Waiting for relay delivery"
        return remaining == 0
    }

    func backgroundRefreshExpired() {
        backgroundSyncStatus = "Waiting for another iOS refresh"
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
    func createCompoundBoard(name: String, childBoardIDs: [String]) -> Bool {
        guard let board = snapshot.createCompoundBoard(
            name: name,
            childBoardIDs: childBoardIDs
        ) else { return false }
        scheduleSave()
        reconfigureSync()
        publishBoard(board)
        return true
    }

    var bibleTrackerEnabled: Bool {
        snapshot.boards.contains { $0.id == TaskifySnapshot.bibleBoardID && !$0.hidden }
    }

    /// Toggles the singleton Bible reading tracker board on/off. Local-only: unlike other board
    /// kinds, this never publishes to Nostr since the board carries no shareable content.
    @discardableResult
    func setBibleTrackerEnabled(_ enabled: Bool) -> Bool {
        guard snapshot.setBibleTrackerEnabled(enabled) else { return false }
        scheduleSave()
        return true
    }

    /// Saves the Fasting Reminders settings and immediately reconciles the generated tasks
    /// against the new schedule (e.g. flipping from "weekday" to "random" replaces future
    /// occurrences right away rather than waiting for the next app launch).
    func updateFastingReminders(enabled: Bool, mode: FastingRemindersMode, perMonth: Int, weekday: Int) {
        FastingRemindersSettings.save(enabled: enabled, mode: mode, perMonth: perMonth, weekday: weekday)
        fastingRemindersEnabled = FastingRemindersSettings.enabled
        fastingRemindersMode = FastingRemindersSettings.mode
        fastingRemindersPerMonth = FastingRemindersSettings.perMonth
        fastingRemindersWeekday = FastingRemindersSettings.weekday
        reconcileFastingReminders()
    }

    /// Re-runs fasting-reminder task generation against the current settings. Safe to call
    /// repeatedly (e.g. on every app launch) — it only creates/prunes tasks that drifted from
    /// the desired schedule.
    func reconcileFastingReminders() {
        let result = snapshot.reconcileFastingReminders(
            enabled: fastingRemindersEnabled,
            mode: fastingRemindersMode,
            weekday: fastingRemindersWeekday,
            perMonth: fastingRemindersPerMonth,
            seed: FastingRemindersSettings.seed
        )
        guard !result.created.isEmpty || !result.updatedIDs.isEmpty else { return }
        scheduleSave()
        for task in result.created {
            synchronizeTask(task.id)
        }
        for taskID in result.updatedIDs {
            let isDeletion = snapshot.tasks.first(where: { $0.id == taskID })?.isDeleted == true
            synchronizeTask(taskID, includeDeletionEvent: isDeletion)
        }
    }

    private static let scriptureMemorySeriesID = "scripture-memory-series"
    private static let scriptureMemoryStorageKey = "taskify.scriptureMemory.state.v1"

    static func loadScriptureMemoryState() -> ScriptureMemoryState {
        guard let data = UserDefaults.standard.data(forKey: scriptureMemoryStorageKey),
              let decoded = try? JSONDecoder().decode(ScriptureMemoryState.self, from: data) else {
            return ScriptureMemoryState()
        }
        return decoded
    }

    private func persistScriptureMemoryState() {
        guard let data = try? JSONEncoder().encode(scriptureMemoryState) else { return }
        UserDefaults.standard.set(data, forKey: Self.scriptureMemoryStorageKey)
    }

    /// Boards a scripture-memory review task can be created on. Compound boards are excluded:
    /// their "columns" belong to child list boards, so a task can't be unambiguously placed there.
    var scriptureMemoryEligibleBoards: [Board] {
        snapshot.boards.filter { $0.isVisible && ($0.kind == .week || $0.kind == .list) }
    }

    func addScriptureMemoryEntry(bookID: String, chapter: Int, startVerse: Int?, endVerse: Int?) {
        let entry = ScriptureMemoryEntry(
            bookID: bookID,
            chapter: chapter,
            startVerse: startVerse,
            endVerse: endVerse,
            addedAtISO: ISO8601DateFormatter().string(from: Date())
        )
        scriptureMemoryState.entries.append(entry)
        persistScriptureMemoryState()
        reconcileScriptureMemory()
    }

    func removeScriptureMemoryEntry(_ entryID: String) {
        guard scriptureMemoryState.entries.contains(where: { $0.id == entryID }) else { return }
        scriptureMemoryState.entries.removeAll { $0.id == entryID }
        persistScriptureMemoryState()
        if let pendingTaskID = snapshot.tasks.first(where: {
            $0.scriptureMemoryID == entryID && !$0.completed && !$0.isDeleted
        })?.id {
            deleteTask(pendingTaskID)
        }
        reconcileScriptureMemory()
    }

    func updateScriptureMemorySettings(enabled: Bool, boardID: String?, frequency: ScriptureMemoryFrequency) {
        ScriptureMemorySettings.setEnabled(enabled)
        ScriptureMemorySettings.setBoardID(boardID)
        ScriptureMemorySettings.setFrequency(frequency)
        scriptureMemoryEnabled = ScriptureMemorySettings.enabled
        scriptureMemoryBoardID = ScriptureMemorySettings.boardID
        scriptureMemoryFrequency = ScriptureMemorySettings.frequency
        reconcileScriptureMemory()
    }

    /// Marks an entry reviewed right now: completes its pending task if one exists (so the
    /// board reflects it too), otherwise advances the entry directly. Matches the PWA's
    /// `handleReviewScriptureMemory`.
    func reviewScriptureMemoryEntry(_ entryID: String) {
        if let pending = snapshot.tasks.first(where: {
            $0.scriptureMemoryID == entryID && !$0.completed && !$0.isDeleted
        }) {
            toggleCompletion(pending.id)
            return
        }
        guard let index = scriptureMemoryState.entries.firstIndex(where: { $0.id == entryID }) else { return }
        scriptureMemoryState.entries[index].stage = min(
            ScriptureMemoryAlgorithm.maxStage,
            max(0, scriptureMemoryState.entries[index].stage + 1)
        )
        scriptureMemoryState.entries[index].totalReviews += 1
        scriptureMemoryState.entries[index].lastReviewISO = ISO8601DateFormatter().string(from: Date())
        scriptureMemoryState.entries[index].scheduledAtISO = nil
        persistScriptureMemoryState()
        reconcileScriptureMemory()
    }

    /// Advances entries whose review task was completed, then makes sure exactly one active
    /// review task exists (picking the most-overdue entry) — mirrors the PWA's two scripture
    /// memory effects (`markScriptureEntryReviewed` reconciliation + task generation).
    func reconcileScriptureMemory() {
        guard scriptureMemoryEnabled, !scriptureMemoryState.entries.isEmpty else { return }

        let isoFormatter = ISO8601DateFormatter()
        var stateChanged = false
        for task in snapshot.tasks where task.completed && !task.isDeleted {
            guard let entryID = task.scriptureMemoryID,
                  let completedAt = task.completedAt,
                  let entryIndex = scriptureMemoryState.entries.firstIndex(where: { $0.id == entryID }) else { continue }
            let entry = scriptureMemoryState.entries[entryIndex]
            if let entryLastReview = entry.lastReviewISO.flatMap({ isoFormatter.date(from: $0) }),
               entryLastReview >= completedAt {
                continue
            }
            scriptureMemoryState.entries[entryIndex].stage = min(ScriptureMemoryAlgorithm.maxStage, max(0, entry.stage + 1))
            scriptureMemoryState.entries[entryIndex].totalReviews += 1
            scriptureMemoryState.entries[entryIndex].lastReviewISO = isoFormatter.string(from: completedAt)
            scriptureMemoryState.entries[entryIndex].scheduledAtISO = nil
            stateChanged = true
        }
        if stateChanged { persistScriptureMemoryState() }

        guard let boardID = scriptureMemoryBoardID,
              let targetBoard = scriptureMemoryEligibleBoards.first(where: { $0.id == boardID }),
              targetBoard.kind != .list || !targetBoard.columns.isEmpty else {
            return
        }

        let hasActive = snapshot.tasks.contains {
            $0.seriesID == Self.scriptureMemorySeriesID && !$0.completed && !$0.isDeleted
        }
        guard !hasActive else { return }

        let baseDays = Double(scriptureMemoryFrequency.days)
        guard let selection = ScriptureMemoryAlgorithm.chooseNext(
            entries: scriptureMemoryState.entries,
            baseDays: baseDays,
            now: Date()
        ) else { return }

        let calendar = Calendar.current
        let now = Date()
        let dueDays = selection.stats.dueInDays.isFinite && selection.stats.dueInDays > 0
            ? Int(selection.stats.dueInDays.rounded(.up))
            : 0
        let dueDate = calendar.startOfDay(for: calendar.date(byAdding: .day, value: dueDays, to: now) ?? now)

        let resolvedColumnID: String? = targetBoard.kind == .week
            ? WeekdayColumn.containing(dueDate, calendar: calendar).rawValue
            : targetBoard.columns.first?.id

        let hiddenUntil: Date?
        if targetBoard.kind == .list {
            hiddenUntil = dueDate > calendar.startOfDay(for: now) ? dueDate : nil
        } else {
            let nowWeekStart = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? now
            let dueWeekStart = calendar.dateInterval(of: .weekOfYear, for: dueDate)?.start ?? dueDate
            hiddenUntil = dueWeekStart > nowWeekStart ? dueWeekStart : nil
        }

        let nextOrder = (
            snapshot.tasks
                .filter { $0.boardID == targetBoard.id && $0.columnID == resolvedColumnID }
                .map(\.order)
                .max() ?? -1
        ) + 1

        let task = TaskItem(
            boardID: targetBoard.id,
            title: "Review \(ScriptureMemoryAlgorithm.reference(for: selection.entry))",
            dueDate: dueDate,
            dueDateEnabled: true,
            seriesID: Self.scriptureMemorySeriesID,
            scriptureMemoryID: selection.entry.id,
            hiddenUntilDate: hiddenUntil,
            createdAt: now,
            order: nextOrder,
            columnID: resolvedColumnID
        )
        snapshot.tasks.append(task)
        if let entryIndex = scriptureMemoryState.entries.firstIndex(where: { $0.id == selection.entry.id }) {
            scriptureMemoryState.entries[entryIndex].scheduledAtISO = isoFormatter.string(from: now)
            persistScriptureMemoryState()
        }
        scheduleSave()
        synchronizeTask(task.id)
    }

    @discardableResult
    func renameBoard(boardID: String, name: String) -> Bool {
        guard snapshot.renameBoard(boardID: boardID, name: name),
              let board = snapshot.boards.first(where: { $0.id == boardID }) else { return false }
        scheduleSave()
        publishBoard(board)
        return true
    }

    func setStreaksEnabled(_ enabled: Bool) {
        TaskStreakSettings.setEnabled(enabled)
        streaksEnabled = enabled
    }

    /// Reorders a board relative to its neighbors in the switcher. Local-only (no board-order
    /// field is synced), so this just persists locally — no publish needed.
    @discardableResult
    func moveBoard(boardID: String, direction: Int) -> Bool {
        guard snapshot.moveBoard(boardID: boardID, direction: direction) else { return false }
        scheduleSave()
        return true
    }

    @discardableResult
    func updateBoardRelayURLs(boardID: String, relayURLs: [String]) -> Bool {
        let normalizedRelays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !normalizedRelays.isEmpty,
              snapshot.updateBoardRelayURLs(
                boardID: boardID,
                relayURLs: normalizedRelays
              ),
              let board = snapshot.boards.first(where: { $0.id == boardID }) else {
            return false
        }

        let boardsForSync = snapshot.boardsForSync
        let auxiliaryRelays = sharedInboxRelayURLs
        let inboxPublicKey = identityPublicKey.nilIfEmpty
        let timestamp = nextNostrTimestamp()
        scheduleSave()
        scheduleAccountBackupPublish()
        Task { [syncEngine] in
            do {
                try await syncEngine.replaceQueuedRelayTargets(
                    boardLocalID: board.id,
                    relayURLs: board.effectiveRelayURLs
                )
                await syncEngine.configure(
                    boards: boardsForSync,
                    auxiliaryRelayURLs: auxiliaryRelays,
                    inboxPublicKey: inboxPublicKey
                )
                let boardEvent = try TaskEventCodec.boardEvent(
                    board: board,
                    createdAt: timestamp
                )
                try await syncEngine.publish(
                    boardEvent,
                    board: board,
                    taskID: "_board"
                )
            } catch {
                await MainActor.run {
                    self.errorMessage = "Taskify saved the relays locally but could not queue the updated board metadata."
                }
            }
        }
        return true
    }

    @discardableResult
    func archiveBoard(boardID: String) -> Bool {
        guard snapshot.archiveBoard(boardID: boardID) else { return false }
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
        return true
    }

    @discardableResult
    func unarchiveBoard(boardID: String) -> Bool {
        guard snapshot.unarchiveBoard(boardID: boardID) else { return false }
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
        return true
    }

    @discardableResult
    func deleteBoard(boardID: String) -> Bool {
        guard let result = snapshot.deleteBoard(boardID: boardID) else { return false }
        let updatedCompoundBoards = result.updatedCompoundBoardIDs.compactMap { boardID in
            snapshot.boards.first { $0.id == boardID }
        }
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
        updatedCompoundBoards.forEach(publishBoard)
        if !result.deletedTaskIDs.isEmpty {
            refreshNotifications(requestPermission: false)
        }
        return true
    }

    @discardableResult
    func setCompoundChild(boardID: String, childBoardID: String, included: Bool) -> Bool {
        guard snapshot.setCompoundChild(
            boardID: boardID,
            childBoardID: childBoardID,
            included: included
        ), let board = snapshot.boards.first(where: { $0.id == boardID }) else { return false }
        scheduleSave()
        reconfigureSync()
        publishBoard(board)
        return true
    }

    @discardableResult
    func moveCompoundChild(boardID: String, childBoardID: String, direction: Int) -> Bool {
        guard snapshot.moveCompoundChild(
            boardID: boardID,
            childBoardID: childBoardID,
            direction: direction
        ), let board = snapshot.boards.first(where: { $0.id == boardID }) else { return false }
        scheduleSave()
        publishBoard(board)
        return true
    }

    @discardableResult
    func setCompoundHideChildBoardNames(boardID: String, hidden: Bool) -> Bool {
        guard snapshot.setCompoundHideChildBoardNames(boardID: boardID, hidden: hidden),
              let board = snapshot.boards.first(where: { $0.id == boardID }) else { return false }
        scheduleSave()
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
    func renameListColumn(columnID: String, name: String) -> Bool {
        guard let board = selectedBoard,
              snapshot.renameListColumn(boardID: board.id, columnID: columnID, name: name),
              let updatedBoard = snapshot.boards.first(where: { $0.id == board.id }) else {
            return false
        }
        scheduleSave()
        publishBoard(updatedBoard)
        return true
    }

    @discardableResult
    func moveListColumn(columnID: String, direction: Int) -> Bool {
        guard let board = selectedBoard, board.kind == .list else { return false }
        var orderedIDs = board.columns
            .sorted {
                if $0.order != $1.order { return $0.order < $1.order }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            .map(\.id)
        guard let currentIndex = orderedIDs.firstIndex(of: columnID) else { return false }
        let destinationIndex = currentIndex + direction
        guard orderedIDs.indices.contains(destinationIndex) else { return false }
        orderedIDs.swapAt(currentIndex, destinationIndex)
        guard snapshot.reorderListColumns(boardID: board.id, orderedColumnIDs: orderedIDs),
              let updatedBoard = snapshot.boards.first(where: { $0.id == board.id }) else {
            return false
        }
        scheduleSave()
        publishBoard(updatedBoard)
        return true
    }

    @discardableResult
    func removeListColumn(columnID: String, moveTasksTo destinationColumnID: String?) -> Bool {
        guard let board = selectedBoard, board.kind == .list else { return false }
        let strategy: ListColumnRemovalStrategy = destinationColumnID.map {
            .moveTasks(toColumnID: $0)
        } ?? .deleteTasks
        guard let result = snapshot.removeListColumn(
            boardID: board.id,
            columnID: columnID,
            strategy: strategy,
            editorPublicKey: identityPublicKey.nilIfEmpty
        ), let updatedBoard = snapshot.boards.first(where: { $0.id == board.id }) else {
            errorMessage = "A list board must keep at least one list."
            return false
        }

        scheduleSave()
        publishBoard(updatedBoard)
        result.movedTaskIDs.forEach { synchronizeTask($0) }
        result.deletedTaskIDs.forEach { synchronizeTask($0, includeDeletionEvent: true) }
        if !result.deletedTaskIDs.isEmpty {
            refreshNotifications(requestPermission: false)
        }
        return true
    }

    @discardableResult
    func joinWeekBoard(boardID: String, name: String) -> Bool {
        guard snapshot.joinWeekBoard(nostrBoardID: boardID, name: name) != nil else { return false }
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
        return true
    }

    @discardableResult
    func joinSharedBoard(shareText: String, name: String) -> Bool {
        guard let share = BoardShareContract.decode(shareText) else {
            errorMessage = "Paste a valid Taskify board share or board ID."
            return false
        }
        let customName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = customName.isEmpty ? (share.boardName ?? "Shared Board") : customName
        let relays = share.relayURLs.isEmpty ? TaskifyRelayDefaults.urls : share.relayURLs
        guard snapshot.joinWeekBoard(
            nostrBoardID: share.boardID,
            name: resolvedName,
            relayURLs: relays
        ) != nil else {
            return false
        }
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
        return true
    }

    func createTemplateShare(for boardID: String) async throws -> BoardTemplateShareResult {
        guard let sourceBoard = board(withID: boardID) else {
            throw BoardTemplateShareError.boardUnavailable
        }
        guard sourceBoard.kind == .week || sourceBoard.kind == .list else {
            throw BoardTemplateShareError.unsupportedBoard
        }

        let templateBoard = sourceBoard.templateSnapshot()
        // Every template record has a distinct addressable-event coordinate,
        // so a shared snapshot can use one current timestamp without pushing a
        // large board's later tasks artificially into the future.
        let templateCreatedAt = nextNostrTimestamp()
        let boardEvent = try TaskEventCodec.boardEvent(
            board: templateBoard,
            createdAt: templateCreatedAt
        )
        var publishRequests = [
            TaskSyncPublishRequest(
                event: boardEvent,
                board: templateBoard,
                taskID: "_board"
            )
        ]

        let boardTasks = snapshot.tasks.filter {
            $0.boardID == sourceBoard.id && !$0.isDeleted
        }
        var queuedTaskCount = 0
        var failedTaskCount = 0

        for task in boardTasks {
            do {
                let event = try TaskEventCodec.taskEvent(
                    task: task,
                    board: templateBoard,
                    createdAt: templateCreatedAt
                )
                publishRequests.append(TaskSyncPublishRequest(
                    event: event,
                    board: templateBoard,
                    taskID: task.id
                ))
                queuedTaskCount += 1
            } catch {
                failedTaskCount += 1
            }
        }

        try await syncEngine.queueForPublish(publishRequests)
        Task { [syncEngine] in
            await syncEngine.flushQueuedPublishes()
        }

        return BoardTemplateShareResult(
            board: templateBoard,
            queuedTaskCount: queuedTaskCount,
            failedTaskCount: failedTaskCount
        )
    }

    @discardableResult
    func importIdentity(_ value: String) -> Bool {
        do {
            let imported = try NostrIdentity(importedValue: value)
            try identityStore.save(imported)
            applyIdentity(imported)
            accountBackupPublishTask?.cancel()
            accountBackupBaseline = nil
            managedAccountBackupBoardIDs = []
            lastAccountBackupCreatedAt = 0
            accountBackupPublishPending = false
            snapshot.sharedInboxItems = nil
            snapshot.sharedContactInboxItems = nil
            snapshot.sharedCalendarInviteItems = nil
            snapshot.taskifyEvents = nil
            snapshot.sharedTaskRecipients = nil
            snapshot.contacts = nil
            snapshot.contactsListUpdatedAt = nil
            snapshot.contactsListExtraTags = nil
            snapshot.directMessages = nil
            snapshot.directMessageReadAt = nil
            snapshot.directMessageReactions = nil
            snapshot.nostrGroupConversations = nil
            snapshot.directMessageArchivedAt = nil
            snapshot.directMessageDeletedEventIDs = nil
            snapshot.directMessageBlockedPeers = nil
            snapshot.directMessageMutedGroups = nil
            snapshot.directMessageLeftGroups = nil
            contactSyncStatus = "Preparing private contact sync"
            lastContactRefreshAt = nil
            scheduleSave()
            Task { [syncEngine] in
                try? await syncEngine.discardQueuedPublishes(
                    outboxScope: Self.accountBackupOutboxScope
                )
                try? await syncEngine.discardQueuedPublishes(
                    outboxScope: Self.sharedInboxOutboxScope
                )
                try? await syncEngine.discardQueuedPublishes(
                    outboxScope: Self.contactsOutboxScope
                )
                try? await syncEngine.discardQueuedPublishes(
                    outboxScope: Self.directMessagesOutboxScope
                )
            }
            reconfigureSync()
            findPWAAccountBackup(identity: imported)
            refreshContacts()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    var pendingAccountBackupReview: NostrAppBackupReview? {
        pendingAccountBackup.map {
            NostrAppBackupReview(payload: $0, currentBoards: snapshot.boards)
        }
    }

    func findPWAAccountBackup() {
        do {
            guard let identity = try identityStore.load() else {
                accountBackupMessage = "Import a Nostr identity before looking for a PWA backup."
                return
            }
            findPWAAccountBackup(identity: identity)
        } catch {
            accountBackupMessage = error.localizedDescription
        }
    }

    func dismissPWAAccountBackup() {
        pendingAccountBackup = nil
        accountBackupMessage = "PWA backup left unchanged. You can check again at any time."
    }

    func applyPendingPWAAccountBackup() {
        guard let payload = pendingAccountBackup else { return }
        accountBackupBaseline = payload
        managedAccountBackupBoardIDs = payload.nativeManagedNostrBoardIDs
        lastAccountBackupCreatedAt = max(lastAccountBackupCreatedAt, payload.timestamp)
        applyEncryptedMediaServer(from: payload)
        let result = snapshot.mergePWAAccountBackup(payload)
        pendingAccountBackup = nil
        let imported = result.importedBoardCount
        let updated = result.updatedBoardCount
        accountBackupMessage = imported > 0
            ? "Added \(imported) board\(imported == 1 ? "" : "s") and connected \(updated) existing board\(updated == 1 ? "" : "s"). Tasks will arrive through Nostr sync."
            : "Connected \(updated) existing board\(updated == 1 ? "" : "s") to the backup relay settings."
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
    }

    private func findPWAAccountBackup(
        identity: NostrIdentity,
        automaticallyActivateWhenAlreadyConnected: Bool = false
    ) {
        accountBackupSearchTask?.cancel()
        pendingAccountBackup = nil
        isCheckingAccountBackup = true
        accountBackupMessage = "Checking your configured relays for a PWA account backup…"
        let relays = TaskifyRelayURL.normalizedList(
            TaskifyRelayDefaults.urls + snapshot.boards.flatMap(\.effectiveRelayURLs)
        )
        accountBackupSearchTask = Task { [weak self] in
            let candidates = await NostrAccountBackupFinder.findCandidates(
                publicKey: identity.publicKeyHex,
                relayURLs: relays
            )
            guard !Task.isCancelled, let self else { return }
            var decodedPayload: NostrAppBackupPayload?
            for event in candidates {
                if let payload = try? NostrAppBackupContract.decode(event: event, identity: identity) {
                    decodedPayload = payload
                    break
                }
            }
            guard !Task.isCancelled else { return }
            isCheckingAccountBackup = false
            if let decodedPayload {
                let review = NostrAppBackupReview(
                    payload: decodedPayload,
                    currentBoards: snapshot.boards
                )
                if automaticallyActivateWhenAlreadyConnected,
                   review.importableBoardCount == 0 {
                    accountBackupBaseline = decodedPayload
                    managedAccountBackupBoardIDs = decodedPayload.nativeManagedNostrBoardIDs
                    applyEncryptedMediaServer(from: decodedPayload)
                    lastAccountBackupCreatedAt = max(
                        lastAccountBackupCreatedAt,
                        decodedPayload.timestamp
                    )
                    accountBackupMessage = "Encrypted PWA account-backup continuity is active."
                    reconfigureSync()
                    let projectedPayload = decodedPayload.updatingNativeBoards(
                        snapshot.boards,
                        managedNostrBoardIDs: managedAccountBackupBoardIDs,
                        timestamp: decodedPayload.timestamp
                    )
                    if projectedPayload != decodedPayload {
                        scheduleAccountBackupPublish()
                    }
                } else {
                    pendingAccountBackup = decodedPayload
                    accountBackupMessage = "PWA account backup found. Review it before adding its boards."
                }
            } else if candidates.isEmpty {
                accountBackupMessage = automaticallyActivateWhenAlreadyConnected
                    ? nil
                    : "No PWA account backup was found on your configured Taskify relays."
            } else {
                accountBackupMessage = "A backup event was found, but it could not be decrypted with this identity."
            }
        }
    }

    private func load() async {
        defer { isLoading = false }
        var loadedIdentity: NostrIdentity?
        do {
            let identity = try identityStore.loadOrCreate()
            loadedIdentity = identity
            applyIdentity(identity)
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
        reconcileFastingReminders()
        reconcileScriptureMemory()
        startSync()
        refreshContacts()
        if let loadedIdentity {
            findPWAAccountBackup(
                identity: loadedIdentity,
                automaticallyActivateWhenAlreadyConnected: true
            )
        }
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
        let boards = snapshot.boardsForSync
        let auxiliaryRelays = sharedInboxRelayURLs
        let inboxPublicKey = identityPublicKey.nilIfEmpty
        Task { [syncEngine] in
            await syncEngine.configure(
                boards: boards,
                auxiliaryRelayURLs: auxiliaryRelays,
                inboxPublicKey: inboxPublicKey
            )
        }
    }

    private func handleSyncUpdate(_ update: TaskSyncUpdate) {
        switch update {
        case .board(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            if snapshot.mergeRemoteBoard(record.board, eventCreatedAt: record.eventCreatedAt) {
                if record.board.kind == .compound {
                    _ = snapshot.ensureCompoundChildBoards(parentBoardID: record.board.id)
                    reconfigureSync()
                }
                scheduleSave()
                scheduleAccountBackupPublish()
            }
        case .task(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            if snapshot.mergeRemoteTask(record.task, eventCreatedAt: record.eventCreatedAt) {
                scheduleSave()
                refreshNotifications(requestPermission: false)
            }
        case .calendarEvent(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            if snapshot.mergeRemoteTaskifyEvent(
                record.event,
                eventCreatedAt: record.eventCreatedAt
            ) {
                scheduleSave()
            }
        case .sharedInbox(let event):
            receiveSharedInboxEvent(event)
        case .status(let report):
            applySyncReport(report)
        }
    }

    private func receiveSharedInboxEvent(_ event: NostrEvent) {
        let identity: NostrIdentity
        do {
            guard let storedIdentity = try identityStore.load() else { return }
            identity = storedIdentity
        } catch {
            return
        }
        guard let decrypted = try? NIP17GiftWrap.unwrapRumor(event, recipient: identity) else {
            return
        }
        let rumor = decrypted.rumor
        if rumor.publicKey != identity.publicKeyHex,
           let payloadJSON = CashuPaymentRequestContract.paymentPayloadJSON(from: rumor.content) {
            do {
                let inboxURL = try CashuNostrPaymentInboxStore.defaultURL()
                let delivery = CashuNostrPaymentDelivery(
                    eventID: decrypted.wrapEventID,
                    payloadJSON: payloadJSON,
                    senderPublicKey: rumor.publicKey,
                    receivedAt: Date(timeIntervalSince1970: TimeInterval(rumor.createdAt))
                )
                if try CashuNostrPaymentInboxStore.enqueue(delivery, at: inboxURL) {
                    walletPaymentDeliveryHandler?()
                }
            } catch {
                errorMessage = "Taskify could not save an incoming Cashu payment."
            }
            return
        }
        if let group = NostrGroupConversation(
            rumor: rumor,
            identityPublicKey: identity.publicKeyHex
        ) {
            if snapshot.upsertGroupConversation(group) { scheduleSave() }
            if rumor.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               rumor.tags.contains(where: { $0.count >= 2 && $0[0] == "subject" }) {
                return
            }
        }
        if rumor.kind == NIP17GiftWrap.rumorKind,
           let envelope = TaskifyShareEnvelope.decode(content: rumor.content) {
            guard rumor.publicKey != identity.publicKeyHex else { return }
            let message = NIP17InboxMessage(
                wrapEventID: decrypted.wrapEventID,
                rumorEventID: rumor.id,
                senderPublicKey: rumor.publicKey,
                createdAt: rumor.createdAt,
                envelope: envelope
            )
            switch envelope.item {
            case .task(let delivery):
                receiveSharedTask(delivery, message: message)
            case .contact(let delivery):
                receiveSharedContact(delivery, message: message)
            case .calendarEvent(let delivery):
                receiveSharedCalendarInvite(delivery, message: message)
            case .assignmentResponse(let response):
                receiveSharedTaskAssignmentResponse(response, message: message)
            }
            return
        }

        if let reaction = NostrDirectMessageReaction(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex
        ) {
            if snapshot.ingestDirectMessageReaction(reaction) {
                scheduleSave()
            }
            return
        }

        guard let directMessage = NostrDirectMessage(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex
        ) else { return }
        if snapshot.ingestDirectMessage(directMessage) {
            scheduleSave()
        }
    }

    private func receiveSharedTask(
        _ delivery: SharedTaskDelivery,
        message: NIP17InboxMessage
    ) {
        let senderKey = (try? Data(hex: message.senderPublicKey))
        let sender = SharedInboxSender(
            publicKey: message.senderPublicKey,
            npub: message.envelope.senderNpub
                ?? senderKey.flatMap { try? Bech32.encode(prefix: "npub", data: $0) },
            name: message.envelope.senderName
        )
        let item = SharedInboxItem(
            wrapEventID: message.wrapEventID,
            rumorEventID: message.rumorEventID,
            sender: sender,
            task: delivery,
            receivedAt: Date(timeIntervalSince1970: TimeInterval(message.createdAt))
        )
        let connectedInboxRelays = Set(sharedInboxRelayURLs)
        let addsRelay = TaskifyRelayURL.normalizedList(delivery.relayURLs ?? [])
            .contains { !connectedInboxRelays.contains($0) }
        if snapshot.ingestSharedInboxItem(item) {
            scheduleSave()
            if addsRelay { reconfigureSync() }
        }
    }

    private func receiveSharedContact(
        _ delivery: SharedContactDelivery,
        message: NIP17InboxMessage
    ) {
        let item = SharedContactInboxItem(
            wrapEventID: message.wrapEventID,
            rumorEventID: message.rumorEventID,
            sender: sharedInboxSender(for: message),
            contact: delivery,
            receivedAt: Date(timeIntervalSince1970: TimeInterval(message.createdAt))
        )
        let connectedInboxRelays = Set(sharedInboxRelayURLs)
        let addsRelay = TaskifyRelayURL.normalizedList(delivery.relayURLs ?? [])
            .contains { !connectedInboxRelays.contains($0) }
        if snapshot.ingestSharedContactInboxItem(item) {
            scheduleSave()
            if addsRelay { reconfigureSync() }
        }
    }

    private func receiveSharedCalendarInvite(
        _ delivery: SharedCalendarEventDelivery,
        message: NIP17InboxMessage
    ) {
        let item = SharedCalendarInviteInboxItem(
            wrapEventID: message.wrapEventID,
            rumorEventID: message.rumorEventID,
            sender: sharedInboxSender(for: message),
            event: delivery,
            receivedAt: Date(timeIntervalSince1970: TimeInterval(message.createdAt))
        )
        let connectedInboxRelays = Set(sharedInboxRelayURLs)
        let addsRelay = TaskifyRelayURL.normalizedList(delivery.relayURLs ?? [])
            .contains { !connectedInboxRelays.contains($0) }
        if snapshot.ingestSharedCalendarInvite(item) {
            scheduleSave()
            if addsRelay { reconfigureSync() }
        }
    }

    private func sharedInboxSender(for message: NIP17InboxMessage) -> SharedInboxSender {
        let senderKey = try? Data(hex: message.senderPublicKey)
        return SharedInboxSender(
            publicKey: message.senderPublicKey,
            npub: message.envelope.senderNpub
                ?? senderKey.flatMap { try? Bech32.encode(prefix: "npub", data: $0) },
            name: message.envelope.senderName
        )
    }

    private func receiveSharedTaskAssignmentResponse(
        _ response: SharedTaskAssignmentResponse,
        message: NIP17InboxMessage
    ) {
        let respondedAt = response.respondedAt.flatMap(Self.parseSharedResponseDate)
            ?? Date(timeIntervalSince1970: TimeInterval(message.createdAt))
        guard let updatedTask = snapshot.applyTaskAssignmentResponse(
            taskID: response.taskID,
            senderPublicKey: message.senderPublicKey,
            status: response.status,
            respondedAt: respondedAt,
            editorPublicKey: message.senderPublicKey
        ) else { return }
        scheduleSave()
        synchronizeTask(updatedTask.id)
    }

    private func sharedInboxDestination() -> (boardID: String, columnID: String?)? {
        guard let selectedBoard else { return nil }
        switch selectedBoard.kind {
        case .week:
            return (selectedBoard.id, nil)
        case .list:
            guard let column = selectedBoard.columns.sorted(by: { $0.order < $1.order }).first else {
                return nil
            }
            return (selectedBoard.id, column.id)
        case .compound:
            guard let child = snapshot.compoundChildBoards(for: selectedBoard.id).first,
                  let column = child.columns.sorted(by: { $0.order < $1.order }).first else {
                return nil
            }
            return (child.id, column.id)
        case .bible:
            return nil
        }
    }

    private func sendSharedTaskAssignmentResponse(
        item: SharedInboxItem,
        status: SharedInboxItemStatus
    ) {
        guard let sourceTaskID = item.task.sourceTaskID,
              let responseStatus = SharedTaskAssignmentStatus(rawValue: status.rawValue),
              responseStatus != .pending else { return }
        let respondedAt = Self.sharedResponseDateFormatter.string(from: Date())
        let senderNpub = identityNpub.nilIfEmpty
        let responseRelayURLs = TaskifyRelayURL.normalizedList(
            (item.task.relayURLs ?? []) + sharedInboxRelayURLs
        )
        let envelope = TaskifyShareEnvelope(
            item: .assignmentResponse(SharedTaskAssignmentResponse(
                taskID: sourceTaskID,
                status: responseStatus,
                respondedAt: respondedAt
            )),
            senderNpub: senderNpub
        )
        Task { [identityStore, syncEngine] in
            do {
                guard let identity = try identityStore.load(),
                      let recipientPublicKey = try? Data(hex: item.sender.publicKey) else { return }
                let event = try NIP17GiftWrap.wrap(
                    envelope: envelope,
                    sender: identity,
                    recipientPublicKey: recipientPublicKey
                )
                try await syncEngine.publish(
                    event,
                    relayURLs: responseRelayURLs,
                    outboxScope: Self.sharedInboxOutboxScope,
                    recordID: "\(sourceTaskID):\(item.sender.publicKey)"
                )
            } catch {
                await MainActor.run {
                    self.errorMessage = "Your response is saved, but Taskify could not queue its delivery yet."
                }
            }
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

    private func synchronizeTaskifyEvent(_ eventID: String) {
        guard let event = snapshot.taskifyEvents?.first(where: { $0.id == eventID }),
              let boardID = event.boardID,
              let board = snapshot.boards.first(where: { $0.id == boardID }) else {
            scheduleSave()
            return
        }
        let timestamp = nextNostrTimestamp()
        let pair: TaskifyCalendarEventPair
        do {
            pair = try TaskifyCalendarEventCodec.eventPair(
                event: event,
                board: board,
                createdAt: timestamp
            )
        } catch {
            errorMessage = "Taskify could not prepare this event for Nostr sync."
            scheduleSave()
            return
        }
        _ = snapshot.upsertTaskifyEvent(pair.normalizedEvent)
        scheduleSave()
        Task { [syncEngine] in
            do {
                let boardEvent = try TaskEventCodec.boardEvent(board: board, createdAt: timestamp)
                try await syncEngine.publish(boardEvent, board: board, taskID: "_board")
                try await syncEngine.publish(
                    pair.canonical,
                    board: board,
                    taskID: "event:\(eventID):canonical"
                )
                try await syncEngine.publish(
                    pair.view,
                    board: board,
                    taskID: "event:\(eventID):view"
                )
            } catch {
                await MainActor.run {
                    self.errorMessage = "Taskify could not queue this event for Nostr sync."
                }
            }
        }
    }

    private static func taskifyDateValue(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0
        )
    }

    private static func taskifyISOValue(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    private func synchronizeTaskMove(
        _ taskID: String,
        sourceTask: TaskItem,
        sourceBoard: Board
    ) {
        guard let index = snapshot.tasks.firstIndex(where: { $0.id == taskID }),
              let targetBoard = snapshot.boards.first(where: { $0.id == snapshot.tasks[index].boardID }) else {
            scheduleSave()
            return
        }

        let sourceTombstoneTimestamp = nextNostrTimestamp()
        let sourceDeletionTimestamp = nextNostrTimestamp()
        let targetTimestamp = nextNostrTimestamp()
        snapshot.tasks[index].nostrUpdatedAt = targetTimestamp
        let targetTask = snapshot.tasks[index]
        var sourceTombstone = sourceTask
        sourceTombstone.deleted = true
        sourceTombstone.lastEditedBy = identityPublicKey.nilIfEmpty ?? sourceTombstone.lastEditedBy
        scheduleSave()

        Task { [syncEngine] in
            do {
                let sourceBoardEvent = try TaskEventCodec.boardEvent(
                    board: sourceBoard,
                    createdAt: sourceTombstoneTimestamp
                )
                try await syncEngine.publish(
                    sourceBoardEvent,
                    board: sourceBoard,
                    taskID: "_board"
                )
                let sourceTaskEvent = try TaskEventCodec.taskEvent(
                    task: sourceTombstone,
                    board: sourceBoard,
                    createdAt: sourceTombstoneTimestamp
                )
                try await syncEngine.publish(
                    sourceTaskEvent,
                    board: sourceBoard,
                    taskID: sourceTombstone.id
                )
                let sourceDeletion = try TaskEventCodec.deletionEvent(
                    taskID: sourceTombstone.id,
                    board: sourceBoard,
                    createdAt: sourceDeletionTimestamp
                )
                try await syncEngine.publish(
                    sourceDeletion,
                    board: sourceBoard,
                    taskID: "deletion:\(sourceTombstone.id)"
                )

                let targetBoardEvent = try TaskEventCodec.boardEvent(
                    board: targetBoard,
                    createdAt: targetTimestamp
                )
                try await syncEngine.publish(
                    targetBoardEvent,
                    board: targetBoard,
                    taskID: "_board"
                )
                let targetTaskEvent = try TaskEventCodec.taskEvent(
                    task: targetTask,
                    board: targetBoard,
                    createdAt: targetTimestamp
                )
                try await syncEngine.publish(
                    targetTaskEvent,
                    board: targetBoard,
                    taskID: targetTask.id
                )
            } catch {
                await MainActor.run {
                    self.errorMessage = "Taskify could not queue this task move for Nostr sync."
                }
            }
        }
    }

    private func publishBoard(_ board: Board) {
        scheduleAccountBackupPublish()
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

    private func nextNostrTimestamp(after timestamp: Int) -> Int {
        lastNostrCreatedAt = max(lastNostrCreatedAt, timestamp)
        return nextNostrTimestamp()
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

    private func persistImmediately() async {
        saveTask?.cancel()
        saveTask = nil
        do {
            try await store.save(snapshot)
        } catch {
            errorMessage = "Taskify could not save the latest change."
        }
    }

    private var accountBackupRelayURLs: [String] {
        guard let baseline = accountBackupBaseline else { return [] }
        return baseline.defaultRelayURLs.isEmpty
            ? TaskifyRelayDefaults.urls
            : baseline.defaultRelayURLs
    }

    private var sharedInboxRelayURLs: [String] {
        TaskifyRelayURL.normalizedList(
            TaskifyRelayDefaults.urls
                + accountBackupRelayURLs
                + (snapshot.sharedInboxItems ?? []).flatMap { $0.task.relayURLs ?? [] }
                + (snapshot.sharedContactInboxItems ?? []).flatMap { $0.contact.relayURLs ?? [] }
                + (snapshot.sharedCalendarInviteItems ?? []).flatMap { $0.event.relayURLs ?? [] }
                + (snapshot.sharedTaskRecipients ?? []).flatMap(\.relayURLs)
                + (snapshot.contacts ?? []).flatMap(\.relayURLs)
                + (snapshot.directMessages ?? []).flatMap { $0.relayURLs ?? [] }
        )
    }

    private var contactsSyncRelayURLs: [String] {
        TaskifyRelayURL.normalizedList(
            TaskifyRelayDefaults.urls
                + accountBackupRelayURLs
        )
    }

    private func refreshContactsBeforeMutation() async {
        if isRefreshingContacts, let contactRefreshTask {
            await contactRefreshTask.value
        } else {
            await refreshContactsFromNostr(silent: true)
        }
    }

    private func refreshContactsFromNostr(silent: Bool) async {
        guard !isRefreshingContacts else { return }
        let identity: NostrIdentity
        do {
            guard let storedIdentity = try identityStore.load() else {
                if !silent { contactSyncStatus = "Import a Nostr identity to sync contacts" }
                return
            }
            identity = storedIdentity
        } catch {
            if !silent { contactSyncStatus = "Private contact sync is unavailable" }
            return
        }
        let relays = contactsSyncRelayURLs
        guard !relays.isEmpty else {
            if !silent { contactSyncStatus = "Add a relay to sync contacts" }
            return
        }

        isRefreshingContacts = true
        if !silent { contactSyncStatus = "Syncing private contacts…" }
        defer {
            isRefreshingContacts = false
            lastContactRefreshAt = Date()
        }

        let candidates = await NostrContactFinder.findPrivateListCandidates(
            publicKey: identity.publicKeyHex,
            relayURLs: relays
        )
        guard !Task.isCancelled else { return }
        var decodedList: NIP51ContactList?
        for event in candidates {
            if let list = try? NIP51ContactListContract.decode(event: event, identity: identity) {
                decodedList = list
                break
            }
        }
        if let decodedList {
            lastNostrCreatedAt = max(lastNostrCreatedAt, decodedList.eventCreatedAt)
            if snapshot.replaceContacts(from: decodedList) { scheduleSave() }
        }

        let profileRelays = TaskifyRelayURL.normalizedList(
            relays + (snapshot.contacts ?? []).flatMap(\.relayURLs)
        )
        let profiles = await NostrContactFinder.profiles(
            publicKeys: (snapshot.contacts ?? []).map(\.publicKey),
            relayURLs: profileRelays
        )
        guard !Task.isCancelled else { return }
        if snapshot.applyContactProfiles(profiles) { scheduleSave() }
        if !silent {
            if decodedList != nil || !(snapshot.contacts ?? []).isEmpty {
                let count = snapshot.contacts?.count ?? 0
                contactSyncStatus = "Synced \(count) private contact\(count == 1 ? "" : "s")"
            } else if candidates.isEmpty {
                contactSyncStatus = "No private contacts have been synced yet"
            } else {
                contactSyncStatus = "A contact list was found but could not be decrypted"
            }
        }
    }

    private func publishContacts(identity: NostrIdentity, createdAt: Int) async throws {
        let relays = contactsSyncRelayURLs
        guard !relays.isEmpty else { throw NostrContactDirectoryError.noRelays }
        let event = try NIP51ContactListContract.event(
            contacts: snapshot.contacts ?? [],
            identity: identity,
            createdAt: createdAt,
            extraTags: snapshot.contactsListExtraTags ?? []
        )
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: TaskifyRelayURL.normalizedList(sharedInboxRelayURLs + relays),
            inboxPublicKey: identity.publicKeyHex
        )
        try await syncEngine.publish(
            event,
            relayURLs: relays,
            outboxScope: Self.contactsOutboxScope,
            recordID: NIP51ContactListContract.eventDTag
        )
    }

    private static let sharedResponseDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func parseSharedResponseDate(_ value: String) -> Date? {
        if let date = sharedResponseDateFormatter.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }

    private func scheduleAccountBackupPublish() {
        guard accountBackupBaseline != nil else { return }
        accountBackupPublishPending = true
        accountBackupPublishTask?.cancel()
        accountBackupPublishTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(1.5))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await self?.publishAccountBackupSafely()
        }
    }

    private func publishAccountBackupSafely() async {
        guard accountBackupBaseline != nil else { return }
        let identity: NostrIdentity
        do {
            guard let storedIdentity = try identityStore.load() else { return }
            identity = storedIdentity
        } catch {
            accountBackupMessage = "The native account backup is waiting for access to your identity."
            return
        }

        let lookupRelays = TaskifyRelayURL.normalizedList(
            accountBackupRelayURLs + snapshot.boards.flatMap(\.effectiveRelayURLs)
        )
        let candidates = await NostrAccountBackupFinder.findCandidates(
            publicKey: identity.publicKeyHex,
            relayURLs: lookupRelays
        )
        guard !Task.isCancelled else { return }

        var latestPayload: NostrAppBackupPayload?
        var latestEventCreatedAt = 0
        for event in candidates {
            guard let payload = try? NostrAppBackupContract.decode(
                event: event,
                identity: identity
            ) else { continue }
            latestPayload = payload
            latestEventCreatedAt = event.createdAt
            break
        }
        guard let remotePayload = latestPayload else {
            accountBackupMessage = candidates.isEmpty
                ? "Account backup update is waiting until a backup relay is reachable."
                : "Account backup update paused because the latest remote copy could not be verified."
            return
        }

        let now = Int(Date().timeIntervalSince1970)
        let createdAt = max(
            now,
            max(lastAccountBackupCreatedAt, max(remotePayload.timestamp, latestEventCreatedAt)) + 1
        )
        var updatedPayload = remotePayload.updatingNativeBoards(
            snapshot.boards,
            managedNostrBoardIDs: managedAccountBackupBoardIDs,
            timestamp: createdAt
        )
        updatedPayload.settings[TaskifyMediaServerSettings.pwaSettingsKey] = .string(
            encryptedMediaServerURL
        )
        let relayURLs = updatedPayload.defaultRelayURLs.isEmpty
            ? TaskifyRelayDefaults.urls
            : updatedPayload.defaultRelayURLs
        let auxiliaryRelayURLs = TaskifyRelayURL.normalizedList(
            sharedInboxRelayURLs + relayURLs
        )

        do {
            let event = try NostrAppBackupContract.event(
                payload: updatedPayload,
                identity: identity,
                createdAt: createdAt
            )
            await syncEngine.configure(
                boards: snapshot.boardsForSync,
                auxiliaryRelayURLs: auxiliaryRelayURLs,
                inboxPublicKey: identity.publicKeyHex
            )
            try await syncEngine.publish(
                event,
                relayURLs: relayURLs,
                outboxScope: Self.accountBackupOutboxScope,
                recordID: NostrAppBackupContract.eventDTag
            )
            accountBackupBaseline = updatedPayload
            lastAccountBackupCreatedAt = createdAt
            managedAccountBackupBoardIDs.formUnion(
                snapshot.boards
                    .filter { $0.kind != .bible }
                    .map(\.effectiveNostrBoardID)
            )
            accountBackupMessage = "Native board changes are queued in your encrypted PWA account backup."
            accountBackupPublishPending = false
        } catch {
            accountBackupMessage = "Taskify could not queue the encrypted account backup update."
        }
    }

    private func applyEncryptedMediaServer(from payload: NostrAppBackupPayload) {
        guard case .string(let value)? = payload.settings[TaskifyMediaServerSettings.pwaSettingsKey],
              let normalized = TaskifyMediaServerSettings.save(value) else {
            return
        }
        encryptedMediaServerURL = normalized
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

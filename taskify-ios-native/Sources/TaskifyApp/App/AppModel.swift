import Foundation
import Security
import SwiftUI
import TaskifyCore
import TaskifyWatchShared
import UIKit
import WidgetKit

struct BoardTemplateShareResult: Sendable {
    let board: Board
    let queuedTaskCount: Int
    let failedTaskCount: Int
    let queuedEventCount: Int
    let failedEventCount: Int
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
    case boardUnavailable
    case identityUnavailable
    case invalidRecipient
    case cannotSendToSelf
    case noRelays

    var errorDescription: String? {
        switch self {
        case .contactUnavailable: "That contact is no longer available."
        case .boardUnavailable: "That board is no longer available."
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

/// The account-level relay set, stored per device. Falls back to the built-in defaults until
/// the user edits it.
enum AppRelaySettings {
    private static let key = "taskify.sync.appRelays"

    static var urls: [String] {
        let stored = UserDefaults.standard.stringArray(forKey: key) ?? []
        let normalized = TaskifyRelayURL.normalizedList(stored)
        return normalized.isEmpty ? TaskifyRelayDefaults.urls : normalized
    }

    static func setURLs(_ urls: [String]) {
        UserDefaults.standard.set(TaskifyRelayURL.normalizedList(urls), forKey: key)
    }
}

private final class AppSnapshotLookupCache {
    private struct TaskGroupingKey: Hashable {
        let boardID: String
        let includeCompleted: Bool
        let minute: Int
        let weekStartsOn: WeekdayColumn
    }

    private struct TaskIndex {
        var tasksByID: [String: TaskItem] = [:]
        var activeTaskIDs: Set<String> = []
        var tasksByBoardID: [String: [TaskItem]] = [:]
        var completedTaskCountsByBoardID: [String: Int] = [:]
        var taskCountsByBoardID: [String: Int] = [:]
    }

    private var boardsByID: [String: Board]?
    private var taskIndex: TaskIndex?
    private var groupedTasks: [TaskGroupingKey: [BoardTaskColumnKey: [TaskItem]]] = [:]
    private var taskColumnMinute: Int?
    private var contactsByPublicKey: [String: NostrContact]?
    private var groupsByID: [String: NostrGroupConversation]?
    private var cachedVisibleBoards: [Board]?
    private var cachedAcceptedTaskifyEvents: [TaskifyEvent]?
    private var cachedTaskifyEventIDs: Set<String>?

    func invalidate() {
        boardsByID = nil
        taskIndex = nil
        groupedTasks.removeAll(keepingCapacity: true)
        taskColumnMinute = nil
        contactsByPublicKey = nil
        groupsByID = nil
        cachedVisibleBoards = nil
        cachedAcceptedTaskifyEvents = nil
        cachedTaskifyEventIDs = nil
    }

    /// `TaskifySnapshot.acceptedTaskifyEvents` filters and sorts the whole event array on every
    /// read, and each board column reads it while building its own day/column slice. Holding the
    /// result for the life of a snapshot keeps a horizontal swipe from re-sorting the same array
    /// once per column per render.
    func acceptedTaskifyEvents(snapshot: TaskifySnapshot) -> [TaskifyEvent] {
        if let cachedAcceptedTaskifyEvents { return cachedAcceptedTaskifyEvents }
        let events = snapshot.acceptedTaskifyEvents
        cachedAcceptedTaskifyEvents = events
        return events
    }

    func taskifyEventIDs(snapshot: TaskifySnapshot) -> Set<String> {
        if let cachedTaskifyEventIDs { return cachedTaskifyEventIDs }
        let ids = Set(acceptedTaskifyEvents(snapshot: snapshot).map(\.id))
        cachedTaskifyEventIDs = ids
        return ids
    }

    func board(id: String, snapshot: TaskifySnapshot) -> Board? {
        if boardsByID == nil {
            boardsByID = Dictionary(
                snapshot.boards.map { ($0.id, $0) },
                uniquingKeysWith: { _, newest in newest }
            )
        }
        return boardsByID?[id]
    }

    func task(id: String, snapshot: TaskifySnapshot) -> TaskItem? {
        ensureTaskIndex(snapshot: snapshot)
        return taskIndex?.tasksByID[id]
    }

    func activeTaskIDs(snapshot: TaskifySnapshot) -> Set<String> {
        ensureTaskIndex(snapshot: snapshot)
        return taskIndex?.activeTaskIDs ?? []
    }

    func tasks(
        boardID: String,
        columnID: String,
        includeCompleted: Bool,
        snapshot: TaskifySnapshot,
        weekStartsOn: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskItem] {
        let minute = Int(now.timeIntervalSince1970 / 60)
        if taskColumnMinute != minute {
            groupedTasks.removeAll(keepingCapacity: true)
            taskColumnMinute = minute
        }
        let groupingKey = TaskGroupingKey(
            boardID: boardID,
            includeCompleted: includeCompleted,
            minute: minute,
            weekStartsOn: weekStartsOn
        )
        if groupedTasks[groupingKey] == nil {
            ensureTaskIndex(snapshot: snapshot)
            groupedTasks[groupingKey] = BoardTaskOrganizer.groupedTasks(
                taskIndex?.tasksByBoardID[boardID] ?? [],
                boards: snapshot.boards,
                includedBoardIDs: [boardID],
                includeCompleted: includeCompleted,
                weekStartsOn: weekStartsOn,
                now: now,
                calendar: calendar
            )
        }
        return groupedTasks[groupingKey]?[
            BoardTaskColumnKey(boardID: boardID, columnID: columnID)
        ] ?? []
    }

    func completedTaskCount(boardIDs: Set<String>, snapshot: TaskifySnapshot) -> Int {
        ensureTaskIndex(snapshot: snapshot)
        return boardIDs.reduce(0) {
            $0 + (taskIndex?.completedTaskCountsByBoardID[$1] ?? 0)
        }
    }

    func taskCount(boardID: String, snapshot: TaskifySnapshot) -> Int {
        ensureTaskIndex(snapshot: snapshot)
        return taskIndex?.taskCountsByBoardID[boardID] ?? 0
    }

    func prewarmBoardTasks(
        boardIDs: [String],
        includeCompleted: Bool,
        snapshot: TaskifySnapshot,
        weekStartsOn: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) {
        ensureTaskIndex(snapshot: snapshot)
        for boardID in boardIDs {
            guard let board = board(id: boardID, snapshot: snapshot) else { continue }
            let columnID = board.columns.first?.id
                ?? (board.kind == .week ? WeekdayColumn.containing(now, calendar: calendar).rawValue : "")
            _ = tasks(
                boardID: boardID,
                columnID: columnID,
                includeCompleted: includeCompleted,
                snapshot: snapshot,
                weekStartsOn: weekStartsOn,
                now: now,
                calendar: calendar
            )
        }
    }

    private func ensureTaskIndex(snapshot: TaskifySnapshot) {
        guard taskIndex == nil else { return }
        var index = TaskIndex()
        index.tasksByID.reserveCapacity(snapshot.tasks.count)
        index.activeTaskIDs.reserveCapacity(snapshot.tasks.count)

        for task in snapshot.tasks where !task.isDeleted {
            index.tasksByID[task.id] = task
            index.activeTaskIDs.insert(task.id)
            index.tasksByBoardID[task.boardID, default: []].append(task)
            index.taskCountsByBoardID[task.boardID, default: 0] += 1
            if task.completed {
                index.completedTaskCountsByBoardID[task.boardID, default: 0] += 1
            }
        }
        taskIndex = index
    }

    func contact(publicKey: String, snapshot: TaskifySnapshot) -> NostrContact? {
        if contactsByPublicKey == nil {
            contactsByPublicKey = Dictionary(
                (snapshot.contacts ?? []).map {
                    ($0.publicKey.lowercased(), $0)
                },
                uniquingKeysWith: { _, newest in newest }
            )
        }
        let normalized = publicKey.count == 64
            ? publicKey.lowercased()
            : NostrPublicKey.parse(publicKey)?.hexString
        guard let normalized else { return nil }
        return contactsByPublicKey?[normalized]
    }

    func group(id: String, snapshot: TaskifySnapshot) -> NostrGroupConversation? {
        if groupsByID == nil {
            groupsByID = Dictionary(
                (snapshot.nostrGroupConversations ?? []).map {
                    ($0.groupID, $0)
                },
                uniquingKeysWith: { _, newest in newest }
            )
        }
        return groupsByID?[id.lowercased()]
    }

    func visibleBoards(snapshot: TaskifySnapshot) -> [Board] {
        if let cachedVisibleBoards { return cachedVisibleBoards }
        let boards = snapshot.boards.filter(\.isVisible)
        cachedVisibleBoards = boards
        return boards
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
    private static let nip17PreferencesOutboxScope = "__taskify-nip17-preferences__"
    private(set) var snapshot = TaskifySnapshot.empty {
        didSet {
            snapshotLookupCache.invalidate()
            snapshotRevision &+= 1
            TaskifyPerfMonitor.shared.recordSnapshotWrite()
        }
    }

    /// Bumped on every snapshot write. Views that memoize derived data can use this as an O(1)
    /// "has anything changed?" key instead of diffing the task list.
    private(set) var snapshotRevision = 0
    private(set) var isLoading = true
    private(set) var identityPublicKey = ""
    private(set) var identityNpub = ""
    /// When this process last wrote the store, so a newer file can be recognised as someone
    /// else's write rather than an echo of our own.
    private var lastStoreWriteAt = Date.distantPast
    private(set) var syncStatus = "Starting"
    private(set) var syncDetail = "Preparing secure relay connections"
    private(set) var relayStatuses: [TaskRelayStatus] = []
    private(set) var pendingSyncChangeCount = 0
    private(set) var notificationStatus = "Checking"
    private(set) var dmPushEnabled = TaskifyDMPushSettings.isEnabled
    private(set) var dmPushSelection = TaskifyDMPushSettings.selection
    private(set) var dmPushRelayURL = TaskifyDMPushSettings.relayURL
    private(set) var dmPushServerURL = TaskifyDMPushSettings.serverURL
    private(set) var dmPushStatus = TaskifyDMPushSettings.isEnabled ? "Enabled" : "Off"
    private(set) var backgroundSyncStatus = "Ready"
    private(set) var encryptedMediaServerURL = TaskifyMediaServerSettings.configuredServer
    private(set) var encryptedFileServers = TaskifyMediaServerSettings.servers
    private(set) var fastingRemindersEnabled = FastingRemindersSettings.enabled
    private(set) var fastingRemindersMode = FastingRemindersSettings.mode
    private(set) var fastingRemindersPerMonth = FastingRemindersSettings.perMonth
    private(set) var fastingRemindersWeekday = FastingRemindersSettings.weekday
    private(set) var scriptureMemoryState = AppModel.loadScriptureMemoryState()
    private(set) var scriptureMemoryEnabled = ScriptureMemorySettings.enabled
    private(set) var scriptureMemoryBoardID = ScriptureMemorySettings.boardID
    private(set) var scriptureMemoryFrequency = ScriptureMemorySettings.frequency
    private(set) var scriptureMemorySort = ScriptureMemorySettings.sort
    private(set) var streaksEnabled = TaskStreakSettings.enabled
    private(set) var newTaskPosition = TaskOrderingSettings.position
    private(set) var weekStart = WeekLayoutSettings.start
    private(set) var showFullWeekRecurring = (UserDefaults.standard.object(
        forKey: TaskPresentationSettings.showFullWeekRecurringKey
    ) as? Bool) ?? TaskPresentationSettings.showFullWeekRecurringDefault
    private(set) var chatMessageRetention = ChatHistorySettings.retention
    private(set) var walletConversionEnabled = WalletCurrencySettings.conversionEnabled
    private(set) var walletPrimaryCurrency = WalletCurrencySettings.primaryCurrency
    private(set) var walletDenominationDisplay = WalletCurrencySettings.denominationDisplay
    private(set) var startupTab = StartupViewSettings.tab
    private(set) var startupBoardIDsByWeekday = StartupViewSettings.boardIDsByWeekday
    private(set) var appRelays = AppRelaySettings.urls
    private(set) var nip17InboxRelayURLs: [String] = []
    private(set) var isCheckingAccountBackup = false
    private(set) var isRefreshingContacts = false
    private(set) var contactSyncStatus = "Preparing private contact sync"
    private(set) var accountBackupMessage: String?
    private(set) var taskifyEventRSVPsByEventID: [String: [TaskifyEventRSVPResponse]] = [:]
    private(set) var refreshingTaskifyEventRSVPIDs: Set<String> = []
    private(set) var unavailableTaskifyEventRSVPIDs: Set<String> = []
    var errorMessage: String?
    private(set) var showsFirstRunOnboarding = false

    private var weekCalendar: Calendar {
        var calendar = Calendar.current
        calendar.firstWeekday = weekStart.calendarWeekday
        return calendar
    }

    // Sync/bookkeeping internals — never read by views, so keep them out of observation
    // tracking (they churn constantly during sync).
    @ObservationIgnored private let store: JSONTaskStore
    @ObservationIgnored private let identityStore: KeychainIdentityStore
    @ObservationIgnored private let syncEngine: TaskSyncEngine
    @ObservationIgnored private let notificationCoordinator: TaskNotificationCoordinator
    @ObservationIgnored private let snapshotLookupCache = AppSnapshotLookupCache()
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var syncListenerTask: Task<Void, Never>?
    @ObservationIgnored private var notificationTask: Task<Void, Never>?
    @ObservationIgnored private var accountBackupSearchTask: Task<Void, Never>?
    @ObservationIgnored private var accountBackupPublishTask: Task<Void, Never>?
    @ObservationIgnored private var contactRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var sharedInboxProcessingTask: Task<Void, Never>?
    @ObservationIgnored private var deferredStartupTask: Task<Void, Never>?
    @ObservationIgnored private var didStartDeferredServices = false
    @ObservationIgnored private var pendingSharedInboxEvents: [NostrEvent] = []
    @ObservationIgnored private var accountBackupBaseline: NostrAppBackupPayload?
    @ObservationIgnored private var managedAccountBackupBoardIDs: Set<String> = []
    @ObservationIgnored private var lastAccountBackupCreatedAt = 0
    @ObservationIgnored private var lastAccountBackupCheckAt: Date?
    @ObservationIgnored private var lastNostrCreatedAt = 0
    @ObservationIgnored private var accountBackupPublishPending = false
    @ObservationIgnored private var syncState: TaskSyncState = .connecting
    @ObservationIgnored private var lastContactRefreshAt: Date?
    @ObservationIgnored private var walletPaymentDeliveryHandler: (() -> Void)?
    @ObservationIgnored private var walletDMPushRefreshHandler: ((Bool) async -> Bool)?
    @ObservationIgnored private var isHandlingDMPushWake = false
    @ObservationIgnored private var pendingDMPushCategories: Set<DMPushNotificationCategory> = []
    // Keychain reads are slow syscalls; shared-inbox events arrive in bursts during initial
    // sync and each needs the identity to unwrap its gift wrap, so cache it in memory.
    @ObservationIgnored private var cachedIdentity: NostrIdentity?

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
        sharedInboxProcessingTask?.cancel()
        deferredStartupTask?.cancel()
    }

    var visibleBoards: [Board] {
        snapshotLookupCache.visibleBoards(snapshot: snapshot)
    }
    var boardsForManagement: [Board] {
        snapshot.boards.filter { !$0.hidden && $0.kind != .bible }
    }
    var selectedBoard: Board? {
        let boards = snapshotLookupCache.visibleBoards(snapshot: snapshot)
        return boards.first { $0.id == snapshot.selectedBoardID } ?? boards.first
    }
    var selectedBoardID: String { snapshot.selectedBoardID }
    var sharedInboxItems: [SharedInboxItem] { snapshot.sharedInbox }
    var sharedContactInboxItems: [SharedContactInboxItem] { snapshot.sharedContactInbox }
    var sharedCalendarInviteItems: [SharedCalendarInviteInboxItem] { snapshot.sharedCalendarInvites }
    var sharedBoardInboxItems: [SharedBoardInboxItem] { snapshot.sharedBoardInbox }
    var taskifyEvents: [TaskifyEvent] {
        snapshotLookupCache.acceptedTaskifyEvents(snapshot: snapshot)
    }
    var taskifyEventIDs: Set<String> {
        snapshotLookupCache.taskifyEventIDs(snapshot: snapshot)
    }
    var walletPaymentRequestRelayURLs: [String] { sharedInboxRelayURLs }
    var pendingSharedInboxCount: Int { snapshot.pendingSharedInboxCount }
    var activeTaskIDs: Set<String> {
        snapshotLookupCache.activeTaskIDs(snapshot: snapshot)
    }
    var recentSharedTaskRecipients: [SharedTaskRecipient] { snapshot.recentSharedTaskRecipients }
    var nostrContacts: [NostrContact] { snapshot.contactDirectory }
    var directMessageThreads: [NostrDirectMessageThread] {
        snapshot.activeDirectMessageThreads()
    }
    var storedDirectMessageCount: Int { snapshot.directMessages?.count ?? 0 }
    var groupConversations: [NostrGroupConversation] { snapshot.groupConversations }
    var syncIsOnline: Bool {
        if case .online = syncState { return true }
        return false
    }

    func taskifyEventRSVPs(for eventID: String) -> [TaskifyEventRSVPResponse] {
        taskifyEventRSVPsByEventID[eventID] ?? []
    }

    func isRefreshingTaskifyEventRSVPs(for eventID: String) -> Bool {
        refreshingTaskifyEventRSVPIDs.contains(eventID)
    }

    func taskifyEventRSVPRefreshIsUnavailable(for eventID: String) -> Bool {
        unavailableTaskifyEventRSVPIDs.contains(eventID)
    }

    // MARK: - App relays

    /// The account-level relay set. These are the relays Taskify itself uses: they seed the
    /// relay list of every new board, and they carry direct messages, shared tasks and the
    /// encrypted account backup. Changing them deliberately leaves existing boards alone —
    /// a board keeps whatever relays it was created with or joined on, editable per board.
    var appRelayURLs: [String] { appRelays }

    var appRelaysAreDefault: Bool {
        appRelays == TaskifyRelayDefaults.urls
    }

    enum AppRelayChangeResult: Equatable {
        case changed
        case invalidURL
        case duplicate
        case lastRelay
    }

    func addAppRelay(_ relayURL: String) -> AppRelayChangeResult {
        guard let normalized = TaskifyRelayURL.normalize(relayURL) else { return .invalidURL }
        guard !appRelays.contains(normalized) else { return .duplicate }
        applyAppRelays(appRelays + [normalized])
        return .changed
    }

    /// Refuses to remove the last one — an empty app relay set would leave new boards, direct
    /// messages and account backup with nowhere to publish.
    func removeAppRelay(_ relayURL: String) -> AppRelayChangeResult {
        guard let normalized = TaskifyRelayURL.normalize(relayURL) else { return .invalidURL }
        guard appRelays.count > 1 else { return .lastRelay }
        guard appRelays.contains(normalized) else { return .invalidURL }
        applyAppRelays(appRelays.filter { $0 != normalized })
        return .changed
    }

    func restoreDefaultAppRelays() {
        applyAppRelays(TaskifyRelayDefaults.urls)
    }

    private func applyAppRelays(_ urls: [String]) {
        let normalized = TaskifyRelayURL.normalizedList(urls)
        guard !normalized.isEmpty, normalized != appRelays else { return }
        appRelays = normalized
        AppRelaySettings.setURLs(normalized)
        // Direct messages, shared-task delivery and account backup all resolve their relays
        // through this set, so the engine needs to pick up the new connections now.
        reconfigureSync()
    }

    func registerWalletPaymentReceiver(_ wallet: WalletViewModel) {
        walletPaymentDeliveryHandler = { [weak wallet] in
            wallet?.paymentDeliveryWasQueued()
        }
        walletDMPushRefreshHandler = { [weak wallet] notifyPayments in
            await wallet?.performDMPushRefresh(
                notifyPayments: notifyPayments,
                senderName: { [weak self] publicKey in
                    self?.dmPushSenderName(publicKey: publicKey) ?? "Unknown sender"
                }
            ) ?? false
        }
    }

    func task(withID taskID: String) -> TaskItem? {
        snapshotLookupCache.task(id: taskID, snapshot: snapshot)
    }

    func board(withID boardID: String) -> Board? {
        snapshotLookupCache.board(id: boardID, snapshot: snapshot)
    }

    func directMessages(with peerPublicKey: String) -> [NostrDirectMessage] {
        snapshot.directMessages(with: peerPublicKey)
    }

    private func dmPushSenderName(publicKey: String) -> String {
        if let contact = snapshotLookupCache.contact(publicKey: publicKey, snapshot: snapshot) {
            return contact.displayName
        }
        guard let key = NostrPublicKey.parse(publicKey),
              let npub = NostrPublicKey.npub(from: key) else { return "Unknown sender" }
        return npub.count > 22 ? "\(npub.prefix(12))…\(npub.suffix(6))" : npub
    }

    func directMessageReactions(for message: NostrDirectMessage) -> [NostrDirectMessageReaction] {
        snapshot.directMessageReactions(for: message)
    }

    func directMessageReactionLookup(
        peerPublicKey: String
    ) -> [String: [NostrDirectMessageReaction]] {
        Dictionary(
            grouping: (snapshot.directMessageReactions ?? []).filter {
                !$0.isRemoval && $0.peerPublicKey == peerPublicKey
            },
            by: \.targetEventID
        )
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
        snapshotLookupCache.group(id: id, snapshot: snapshot)
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

        if nip17InboxRelayURLs.isEmpty { await ensureNIP17InboxRelayPreference() }
        let senderRelays = effectiveNIP17InboxRelayURLs
        let relayMap = await groupDeliveryRelays(group: renamedGroup, identity: identity)
        let recipientRelays = relayMap.values.flatMap { $0 }
        let recipientCount = renamedGroup.memberPublicKeys.filter {
            $0 != identity.publicKeyHex
        }.count
        guard relayMap.count == recipientCount,
              !recipientRelays.isEmpty,
              !senderRelays.isEmpty else { return false }

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

        let allRelays = TaskifyRelayURL.normalizedList(senderRelays + recipientRelays)
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: allRelays,
            inboxPublicKey: identity.publicKeyHex,
            inboxRelayURLs: senderRelays
        )
        let selfWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: identity,
            recipientPublicKey: identity.publicKey
        )
        try await syncEngine.publish(
            selfWrap,
            relayURLs: senderRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "group-metadata:\(renamedGroup.groupID):sender"
        )
        return true
    }

    func nostrContact(publicKey: String) -> NostrContact? {
        snapshotLookupCache.contact(publicKey: publicKey, snapshot: snapshot)
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

    func setChatMessageRetention(_ retention: ChatMessageRetention) {
        guard retention != chatMessageRetention else { return }
        ChatHistorySettings.setRetention(retention)
        chatMessageRetention = retention
        if let cutoff = retention.cutoffTimestamp(),
           snapshot.pruneDirectMessageHistory(olderThan: cutoff).changed {
            scheduleSave()
        }
        scheduleAccountBackupPublish()
    }

    func setWalletConversionEnabled(_ enabled: Bool) {
        guard enabled != walletConversionEnabled else { return }
        WalletCurrencySettings.setConversionEnabled(enabled)
        walletConversionEnabled = enabled
        walletPrimaryCurrency = WalletCurrencySettings.primaryCurrency
        scheduleAccountBackupPublish()
    }

    func setWalletPrimaryCurrency(_ currency: WalletPrimaryCurrency) {
        guard walletConversionEnabled, currency != walletPrimaryCurrency else { return }
        WalletCurrencySettings.setPrimaryCurrency(currency)
        walletPrimaryCurrency = WalletCurrencySettings.primaryCurrency
        scheduleAccountBackupPublish()
    }

    func setWalletDenominationDisplay(_ display: WalletDenominationDisplay) {
        guard display != walletDenominationDisplay else { return }
        WalletCurrencySettings.setDenominationDisplay(display)
        walletDenominationDisplay = display
        scheduleAccountBackupPublish()
    }

    func clearDirectMessageHistory() {
        guard snapshot.clearDirectMessageHistory().changed else { return }
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
        snapshotLookupCache.taskCount(boardID: boardID, snapshot: snapshot)
    }

    func completedTaskCount(forBoardID boardID: String) -> Int {
        let scopeIDs: Set<String>
        if let board = board(withID: boardID), board.kind == .compound {
            scopeIDs = Set([boardID] + compoundChildBoards(for: boardID).map(\.id))
        } else {
            scopeIDs = [boardID]
        }
        return snapshotLookupCache.completedTaskCount(boardIDs: scopeIDs, snapshot: snapshot)
    }

    func boardUpcomingGroups(for board: Board, now: Date = Date()) -> [BoardUpcomingGroup] {
        var scopedBoardIDs: Set<String> = [board.id]
        if board.kind == .compound {
            scopedBoardIDs.formUnion(compoundChildBoards(for: board.id).map(\.id))
        }
        return BoardUpcomingOrganizer.groups(
            tasks: snapshot.tasks,
            events: taskifyEvents,
            includedBoardIDs: scopedBoardIDs,
            now: now
        )
    }

    func boardCompletedTasks(for board: Board) -> [TaskItem] {
        var scopedBoardIDs: Set<String> = [board.id]
        if board.kind == .compound {
            scopedBoardIDs.formUnion(compoundChildBoards(for: board.id).map(\.id))
        }
        return BoardCompletedOrganizer.tasks(
            snapshot.tasks,
            includedBoardIDs: scopedBoardIDs
        )
    }

    func tasks(for weekday: WeekdayColumn, includeCompleted: Bool) -> [TaskItem] {
        guard let boardID = selectedBoard?.id else { return [] }
        return snapshotLookupCache.tasks(
            boardID: boardID,
            columnID: weekday.rawValue,
            includeCompleted: includeCompleted,
            snapshot: snapshot,
            weekStartsOn: weekStart,
            calendar: weekCalendar
        )
    }

    func tasks(forColumnID columnID: String, includeCompleted: Bool) -> [TaskItem] {
        guard let boardID = selectedBoard?.id else { return [] }
        return snapshotLookupCache.tasks(
            boardID: boardID,
            columnID: columnID,
            includeCompleted: includeCompleted,
            snapshot: snapshot,
            weekStartsOn: weekStart,
            calendar: weekCalendar
        )
    }

    func tasks(boardID: String, columnID: String, includeCompleted: Bool) -> [TaskItem] {
        snapshotLookupCache.tasks(
            boardID: boardID,
            columnID: columnID,
            includeCompleted: includeCompleted,
            snapshot: snapshot,
            weekStartsOn: weekStart,
            calendar: weekCalendar
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
        let dueDate = WeekDateResolver.date(
            for: weekday,
            inWeekContaining: Date(),
            weekStartsOn: weekStart
        )
        guard let task = snapshot.addTask(
            title: title,
            boardID: boardID,
            columnID: weekday.rawValue,
            dueDate: dueDate,
            authorPublicKey: identityPublicKey.nilIfEmpty,
            newTaskPosition: newTaskPosition,
            weekStartsOn: weekStart,
            calendar: weekCalendar
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
            authorPublicKey: identityPublicKey.nilIfEmpty,
            newTaskPosition: newTaskPosition,
            weekStartsOn: weekStart,
            calendar: weekCalendar
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
            authorPublicKey: identityPublicKey.nilIfEmpty,
            newTaskPosition: newTaskPosition,
            weekStartsOn: weekStart,
            calendar: weekCalendar
        ) else { return }
        synchronizeTask(task.id)
    }

    /// Creates a fully configured task in one local transaction, then publishes only the finished
    /// record. The full editor uses this for a new-task draft so cancelling never leaks an
    /// "Untitled" placeholder to storage or Nostr.
    @discardableResult
    func addDetailedTask(
        id: String,
        title: String,
        note: String,
        boardID: String,
        columnID: String?,
        dueDate: Date?,
        dueDateEnabled: Bool,
        dueTimeEnabled: Bool,
        dueTimeZone: String?,
        urgent: Bool,
        priority: TaskPriority?,
        subtasks: [TaskSubtask],
        recurrence: TaskRecurrence?,
        reminders: [TaskReminder],
        reminderTime: String?,
        images: [String],
        documents: [TaskDocument]
    ) -> TaskItem? {
        guard let created = snapshot.addTask(
            id: id,
            title: title,
            boardID: boardID,
            columnID: columnID,
            dueDate: dueDateEnabled ? dueDate : nil,
            note: note,
            priority: priority,
            authorPublicKey: identityPublicKey.nilIfEmpty,
            newTaskPosition: newTaskPosition,
            weekStartsOn: weekStart,
            calendar: weekCalendar
        ) else { return nil }

        let configured = snapshot.updateTask(
            taskID: created.id,
            title: title,
            note: note,
            dueDate: dueDate,
            dueDateEnabled: dueDateEnabled,
            dueTimeEnabled: dueTimeEnabled,
            dueTimeZone: dueTimeEnabled ? (dueTimeZone ?? TimeZone.current.identifier) : nil,
            priority: priority,
            columnID: columnID,
            subtasks: subtasks,
            recurrence: recurrence,
            reminders: reminders,
            reminderTime: reminderTime,
            editorPublicKey: identityPublicKey.nilIfEmpty,
            calendar: weekCalendar,
            weekStartsOn: weekStart
        ) && snapshot.replaceTaskAttachments(
            taskID: created.id,
            images: images,
            documents: documents,
            editorPublicKey: identityPublicKey.nilIfEmpty
        )
        guard configured, let finalTask = task(withID: created.id) else {
            snapshot.tasks.removeAll { $0.id == created.id }
            return nil
        }

        TaskUrgentAlarmPreferences.setEnabled(urgent, for: finalTask)
        synchronizeTask(finalTask.id)
        if showFullWeekRecurring { ensureFullWeekTaskRecurrences() }
        refreshNotifications(requestPermission: !reminders.isEmpty || urgent)
        return task(withID: finalTask.id)
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
                editorPublicKey: identityPublicKey.nilIfEmpty,
                calendar: weekCalendar
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
            authorPublicKey: identityPublicKey.nilIfEmpty,
            newTaskPosition: newTaskPosition,
            weekStartsOn: weekStart,
            calendar: weekCalendar
        ) else { return }
        synchronizeTask(task.id)
    }

    /// Creates the tasks a dictation session produced, resolving each one onto the same board the
    /// quick-add bar would use. Tasks the model dated land on that date (so a week board files them
    /// under the right weekday); undated ones fall back to today, since every week-board task needs
    /// a column to live in.
    ///
    /// Returns how many were actually created -- the caller reports this back to the user, and a
    /// partial result is possible when a board rejects a task (for example a list board with no
    /// columns).
    @discardableResult
    func addTasksFromVoice(_ tasks: [VoiceFinalTask]) -> Int {
        addTasksFromVoice(tasks, defaultBoardID: selectedBoardID)
    }

    /// Explicit-board counterpart used by the Watch. A stable ID prefix makes delivery
    /// idempotent even if WatchConnectivity retries after the phone created the task but before
    /// its acknowledgement reached the Watch.
    @discardableResult
    func addTasksFromVoice(
        _ tasks: [VoiceFinalTask],
        defaultBoardID: String?,
        taskIDPrefix: String? = nil
    ) -> Int {
        guard let requestedBoard = defaultBoardID.flatMap({ board(withID: $0) }) else { return 0 }
        let board: Board
        switch requestedBoard.kind {
        case .week, .list:
            board = requestedBoard
        case .compound:
            guard let child = snapshot.compoundChildBoards(for: requestedBoard.id).first else { return 0 }
            board = child
        case .bible:
            return 0
        }

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plainISOFormatter = ISO8601DateFormatter()

        var created = 0
        for (taskIndex, voiceTask) in tasks.enumerated() {
            let title = voiceTask.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }

            let stableTaskID = taskIDPrefix.map { "\($0)-\(taskIndex)" }
            if let stableTaskID, task(withID: stableTaskID) != nil {
                created += 1
                continue
            }

            let dueDate = voiceTask.dueISO.flatMap { raw in
                isoFormatter.date(from: raw) ?? plainISOFormatter.date(from: raw)
            }
            let effectiveDate = dueDate ?? Date()

            let columnID: String?
            switch board.kind {
            case .week:
                columnID = WeekdayColumn.containing(effectiveDate).rawValue
            case .list:
                columnID = board.columns.sorted { $0.order < $1.order }.first?.id
            case .compound, .bible:
                columnID = nil
            }

            guard let task = snapshot.addTask(
                id: stableTaskID ?? UUID().uuidString,
                title: title,
                boardID: board.id,
                columnID: columnID,
                dueDate: board.kind == .week ? effectiveDate : dueDate,
                note: voiceTask.notes ?? "",
                priority: voiceTask.priority.flatMap(TaskPriority.init(rawValue:)),
                authorPublicKey: identityPublicKey.nilIfEmpty,
                newTaskPosition: newTaskPosition,
                weekStartsOn: weekStart,
                calendar: weekCalendar
            ) else { continue }

            let subtasks = (voiceTask.subtasks ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            if !subtasks.isEmpty {
                snapshot.updateTask(
                    taskID: task.id,
                    title: task.title,
                    note: task.note,
                    dueDate: task.dueDate,
                    dueDateEnabled: task.dueDate != nil,
                    dueTimeEnabled: task.dueTimeEnabled,
                    dueTimeZone: task.dueTimeZone,
                    priority: task.priority,
                    columnID: task.columnID,
                    subtasks: subtasks.map { TaskSubtask(title: $0) },
                    editorPublicKey: identityPublicKey.nilIfEmpty,
                    calendar: weekCalendar,
                    weekStartsOn: weekStart
                )
            }

            synchronizeTask(task.id)
            created += 1
        }

        if created > 0 {
            refreshNotifications(requestPermission: false)
        }
        return created
    }

    @discardableResult
    func addTaskFromWatch(title: String, boardID: String, commandID: String) -> Bool {
        addTasksFromVoice(
            [VoiceFinalTask(title: title)],
            defaultBoardID: boardID,
            taskIDPrefix: "watch-\(commandID)"
        ) == 1
    }

    @discardableResult
    func addTaskifyEvent(
        title: String,
        details: String,
        location: String,
        startDate: Date,
        endDate: Date,
        isAllDay: Bool,
        boardID requestedBoardID: String,
        columnID requestedColumnID: String? = nil,
        startTimeZoneID: String? = nil,
        reminders: [TaskReminder] = [],
        reminderTime: String? = nil,
        recurrence: TaskRecurrence? = nil,
        participants: [TaskifyEventParticipant] = []
    ) -> Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty,
              let board = snapshot.boards.first(where: {
                  $0.id == requestedBoardID && $0.isVisible && ($0.kind == .week || $0.kind == .list)
              }) else { return false }
        let columnID: String?
        switch board.kind {
        case .week:
            columnID = nil
        case .list:
            let orderedColumns = board.columns.sorted { $0.order < $1.order }
            guard let resolvedColumn = requestedColumnID.flatMap({ requested in
                orderedColumns.first(where: { $0.id == requested })
            }) ?? orderedColumns.first else { return false }
            columnID = resolvedColumn.id
        case .compound, .bible:
            return false
        }
        let eventID = UUID().uuidString
        let order = (snapshot.taskifyEvents ?? [])
            .filter { $0.boardID == board.id }
            .compactMap(\.order)
            .max()
            .map { $0 + 1 } ?? 0
        let resolvedEnd = isAllDay
            ? max(startDate, endDate)
            : (endDate > startDate ? endDate : startDate.addingTimeInterval(60 * 60))
        let resolvedTimeZoneID = startTimeZoneID
            .flatMap { TimeZone(identifier: $0)?.identifier }
            ?? TimeZone.current.identifier
        let normalizedReminders = Self.normalizedTaskifyEventReminders(
            reminders,
            isAllDay: isAllDay
        )
        let normalizedRecurrence = recurrence?.isActive == true ? recurrence : nil
        let event = TaskifyEvent(
            id: eventID,
            boardID: board.id,
            columnID: columnID,
            order: order,
            title: trimmedTitle,
            details: details.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            locations: location.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty.map { [$0] },
            schedule: isAllDay ? .date : .time,
            startDateValue: isAllDay ? Self.taskifyDateValue(startDate) : nil,
            endDateValue: isAllDay ? Self.taskifyDateValue(resolvedEnd) : nil,
            startISO: isAllDay ? nil : Self.taskifyISOValue(startDate),
            endISO: isAllDay ? nil : Self.taskifyISOValue(resolvedEnd),
            startTimeZoneID: isAllDay ? nil : resolvedTimeZoneID,
            endTimeZoneID: isAllDay ? nil : resolvedTimeZoneID,
            reminders: normalizedReminders.isEmpty ? nil : normalizedReminders,
            reminderTime: isAllDay ? Self.normalizedTaskifyEventReminderTime(reminderTime) : nil,
            recurrence: normalizedRecurrence,
            seriesID: normalizedRecurrence == nil ? nil : eventID,
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
        let invitationPlan = TaskifyEventInvitationPlanner.prepare(
            event: event,
            participants: participants,
            previousParticipants: [],
            senderPublicKey: identityPublicKey.nilIfEmpty
        )
        _ = snapshot.upsertTaskifyEvent(invitationPlan.event)
        let seriesChanges = snapshot.rebuildTaskifyEventSeries(
            seedID: eventID,
            editorPublicKey: identityPublicKey.nilIfEmpty
        )
        synchronizeTaskifyEvents([eventID] + seriesChanges.allEventIDs)
        queueTaskifyEventInvitations(
            eventID: eventID,
            recipientPublicKeys: invitationPlan.addedRecipientPublicKeys
        )
        refreshNotifications(requestPermission: !normalizedReminders.isEmpty)
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
        isAllDay: Bool,
        boardID requestedBoardID: String? = nil,
        columnID requestedColumnID: String? = nil,
        startTimeZoneID: String? = nil,
        reminders: [TaskReminder]? = nil,
        reminderTime: String? = nil,
        recurrence: TaskRecurrence? = nil,
        participants: [TaskifyEventParticipant]? = nil
    ) -> Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty,
              let existingEvent = snapshot.taskifyEvents?.first(where: {
                  $0.id == eventID && !$0.isReadOnly && !$0.isDeleted
              }),
              let existingBoardID = existingEvent.boardID else {
            return false
        }
        let targetBoardID = requestedBoardID ?? existingBoardID
        guard let targetBoard = snapshot.boards.first(where: {
            $0.id == targetBoardID && $0.isVisible && ($0.kind == .week || $0.kind == .list)
        }) else { return false }
        let targetColumnID: String?
        switch targetBoard.kind {
        case .week:
            targetColumnID = nil
        case .list:
            let orderedColumns = targetBoard.columns.sorted { $0.order < $1.order }
            guard let resolvedColumn = requestedColumnID.flatMap({ requested in
                orderedColumns.first(where: { $0.id == requested })
            }) ?? orderedColumns.first else { return false }
            targetColumnID = resolvedColumn.id
        case .compound, .bible:
            return false
        }

        let moveResult: TaskifyEventMoveResult?
        if existingBoardID != targetBoardID || existingEvent.columnID != targetColumnID {
            guard let result = snapshot.moveTaskifyEvent(
                eventID: eventID,
                toBoardID: targetBoardID,
                columnID: targetColumnID,
                editorPublicKey: identityPublicKey.nilIfEmpty
            ) else { return false }
            moveResult = result
        } else {
            moveResult = nil
        }

        guard var events = snapshot.taskifyEvents,
              let index = events.firstIndex(where: { $0.id == eventID }) else { return false }
        let previousParticipants = events[index].participants ?? []
        let previousSeriesID = events[index].seriesID
        let wasSeriesSeed = previousSeriesID == eventID
        let resolvedEnd = isAllDay
            ? max(startDate, endDate)
            : (endDate > startDate ? endDate : startDate.addingTimeInterval(60 * 60))
        let resolvedTimeZoneID = startTimeZoneID
            .flatMap { TimeZone(identifier: $0)?.identifier }
            ?? events[index].startTimeZoneID
            ?? TimeZone.current.identifier
        let selectedReminders = reminders ?? events[index].reminders ?? []
        let normalizedReminders = Self.normalizedTaskifyEventReminders(
            selectedReminders,
            isAllDay: isAllDay
        )
        let normalizedRecurrence = recurrence?.isActive == true ? recurrence : nil
        events[index].title = trimmedTitle
        events[index].details = details.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        events[index].locations = location.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty.map { [$0] }
        events[index].schedule = isAllDay ? .date : .time
        events[index].startDateValue = isAllDay ? Self.taskifyDateValue(startDate) : nil
        events[index].endDateValue = isAllDay ? Self.taskifyDateValue(resolvedEnd) : nil
        events[index].startISO = isAllDay ? nil : Self.taskifyISOValue(startDate)
        events[index].endISO = isAllDay ? nil : Self.taskifyISOValue(resolvedEnd)
        events[index].startTimeZoneID = isAllDay ? nil : resolvedTimeZoneID
        events[index].endTimeZoneID = isAllDay ? nil : resolvedTimeZoneID
        events[index].reminders = normalizedReminders.isEmpty ? nil : normalizedReminders
        events[index].reminderTime = isAllDay
            ? Self.normalizedTaskifyEventReminderTime(reminderTime ?? events[index].reminderTime)
            : nil
        events[index].recurrence = normalizedRecurrence
        events[index].seriesID = normalizedRecurrence == nil
            ? nil
            : (previousSeriesID ?? events[index].id)
        events[index].lastEditedBy = identityPublicKey.nilIfEmpty
        events[index].deleted = false
        let invitationPlan = TaskifyEventInvitationPlanner.prepare(
            event: events[index],
            participants: participants ?? previousParticipants,
            previousParticipants: previousParticipants,
            senderPublicKey: identityPublicKey.nilIfEmpty
        )
        events[index] = invitationPlan.event
        snapshot.taskifyEvents = events
        let seriesChanges = wasSeriesSeed || (previousSeriesID == nil && normalizedRecurrence != nil)
            ? snapshot.rebuildTaskifyEventSeries(
                seedID: eventID,
                replacingSeriesID: previousSeriesID,
                editorPublicKey: identityPublicKey.nilIfEmpty
            )
            : TaskifyEventSeriesChanges()
        let synchronizedEventIDs = Array(Set(
            [eventID]
                + seriesChanges.allEventIDs
                + (moveResult?.movedEventIDs ?? [])
        ))
        if let moveResult, moveResult.crossedBoards {
            synchronizeTaskifyEventMove(
                sourceEvents: moveResult.sourceEvents,
                targetEventIDs: synchronizedEventIDs
            )
        } else {
            synchronizeTaskifyEvents(synchronizedEventIDs)
        }
        queueTaskifyEventInvitations(
            eventID: eventID,
            recipientPublicKeys: invitationPlan.addedRecipientPublicKeys
        )
        refreshNotifications(requestPermission: !normalizedReminders.isEmpty)
        return true
    }

    func deleteTaskifyEvent(
        _ eventID: String,
        scope: TaskifyEventDeletionScope = .single
    ) {
        let changes = snapshot.deleteTaskifyEvent(
            eventID: eventID,
            scope: scope,
            editorPublicKey: identityPublicKey.nilIfEmpty
        )
        guard !changes.allEventIDs.isEmpty else { return }
        synchronizeTaskifyEvents(changes.allEventIDs)
        refreshNotifications(requestPermission: false)
    }

    func refreshTaskifyEventRSVPs(eventID: String) async {
        guard !refreshingTaskifyEventRSVPIDs.contains(eventID),
              let event = snapshot.taskifyEvents?.first(where: {
                  $0.id == eventID && !$0.isReadOnly && !$0.isDeleted
              }),
              let boardID = event.boardID,
              let board = snapshot.boards.first(where: { $0.id == boardID }),
              !(event.participants ?? []).isEmpty else { return }
        refreshingTaskifyEventRSVPIDs.insert(eventID)
        unavailableTaskifyEventRSVPIDs.remove(eventID)
        defer { refreshingTaskifyEventRSVPIDs.remove(eventID) }

        let relayURLs = TaskifyRelayURL.normalizedList(
            (event.relayURLs ?? [])
                + board.effectiveRelayURLs
                + appRelays
                + sharedInboxRelayURLs
        )
        let result = await TaskifyEventRSVPResolver.fetch(
            event: event,
            board: board,
            relayURLs: relayURLs
        )
        guard result.reachedRelay else {
            unavailableTaskifyEventRSVPIDs.insert(eventID)
            return
        }
        taskifyEventRSVPsByEventID[eventID] = result.responses
    }

    @discardableResult
    func updateTask(
        taskID: String,
        title: String,
        note: String,
        dueDate: Date?,
        dueDateEnabled: Bool,
        dueTimeEnabled: Bool,
        dueTimeZone: String? = nil,
        urgent: Bool? = nil,
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
            dueTimeZone: dueTimeEnabled ? (dueTimeZone ?? TimeZone.current.identifier) : nil,
            priority: priority,
            columnID: columnID,
            subtasks: subtasks,
            recurrence: recurrence,
            reminders: reminders,
            reminderTime: reminderTime,
            editorPublicKey: identityPublicKey.nilIfEmpty,
            calendar: weekCalendar,
            weekStartsOn: weekStart
        ) else { return false }
        guard snapshot.replaceTaskAttachments(
            taskID: taskID,
            images: images,
            documents: documents,
            editorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return false }
        if let urgent, let updatedTask = task(withID: taskID) {
            TaskUrgentAlarmPreferences.setEnabled(urgent, for: updatedTask)
        }
        synchronizeTask(taskID)
        if showFullWeekRecurring { ensureFullWeekTaskRecurrences() }
        refreshNotifications(requestPermission: !reminders.isEmpty || urgent == true)
        return true
    }

    func isUrgentAlarmEnabled(for taskID: String) -> Bool {
        guard let task = task(withID: taskID) else { return false }
        return TaskUrgentAlarmPreferences.isEnabled(for: task)
    }

    func requestUrgentAlarmAuthorization() async -> Bool {
        await notificationCoordinator.requestUrgentAlarmAuthorization()
    }

    /// Shifts a task's due date forward by the given number of days, preserving its due time.
    /// A touch-friendly counterpart to the PWA's "drag onto Upcoming to postpone a week" gesture.
    @discardableResult
    func postponeTask(_ taskID: String, byDays days: Int) -> Bool {
        guard let task = task(withID: taskID),
              task.dueDateEnabled,
              let dueDate = task.dueDate else {
            return false
        }
        var calendar = Calendar.current
        if task.dueTimeEnabled,
           let dueTimeZone = task.dueTimeZone,
           let timeZone = TimeZone(identifier: dueTimeZone) {
            calendar.timeZone = timeZone
        }
        guard let nextDueDate = calendar.date(byAdding: .day, value: days, to: dueDate) else {
            return false
        }
        return updateTask(
            taskID: taskID,
            title: task.title,
            note: task.note,
            dueDate: nextDueDate,
            dueDateEnabled: true,
            dueTimeEnabled: task.dueTimeEnabled,
            dueTimeZone: task.dueTimeZone,
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
            streaksEnabled: streaksEnabled,
            weekStartsOn: weekStart
        ) else { return }
        // Scripture Memory completion must update its review state and retarget the freshly cloned
        // occurrence before either record is published. Publishing the generic clone first left a
        // short-lived duplicate passage on other clients and could cause the PWA to advance the
        // wrong entry when relay delivery happened out of order.
        let reconciledTaskIDs = reconcileScriptureMemory()
        if !reconciledTaskIDs.contains(taskID) {
            synchronizeTask(taskID)
        }
        snapshot.tasks
            .map(\.id)
            .filter { !existingIDs.contains($0) && !reconciledTaskIDs.contains($0) }
            .forEach { synchronizeTask($0) }
        refreshNotifications(requestPermission: false)
    }

    func toggleSubtaskCompletion(taskID: String, subtaskID: String) {
        guard snapshot.toggleSubtaskCompletion(
            taskID: taskID,
            subtaskID: subtaskID,
            editorPublicKey: identityPublicKey.nilIfEmpty
        ) else { return }
        synchronizeTask(taskID)
    }

    /// Bulk counterpart to `toggleCompletion`, for the Boards multi-select action bar. Only marks
    /// *incomplete* tasks done — unlike single-task `toggleCompletion`, a bulk "Complete" action on
    /// a mixed selection shouldn't un-complete tasks that already were, matching the PWA's
    /// `completeSelectedItems` (disabled unless the selection has at least one incomplete task).
    func completeTasks<S: Sequence>(_ taskIDs: S) where S.Element == String {
        for taskID in taskIDs where task(withID: taskID)?.completed == false {
            toggleCompletion(taskID)
        }
    }

    /// Handles the background action exposed by a long-pressed task notification. iOS can launch
    /// the process directly into this path, before the JSON snapshot has finished loading, so wait
    /// briefly for that load rather than completing against the temporary empty workspace. The
    /// immediate save and notification rebuild make the action durable even if iOS suspends the app
    /// again as soon as the response handler returns.
    func completeTaskFromNotification(_ taskID: String) async {
        let loadDeadline = Date().addingTimeInterval(15)
        while isLoading, Date() < loadDeadline, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard !Task.isCancelled,
              !isLoading,
              let task = task(withID: taskID),
              !task.completed,
              !task.isDeleted else { return }

        toggleCompletion(taskID)
        await persistImmediately()
        await refreshNotificationsImmediately()
    }

    /// Bulk counterpart to `deleteTask`.
    func deleteTasks<S: Sequence>(_ taskIDs: S) where S.Element == String {
        for taskID in taskIDs {
            deleteTask(taskID)
        }
    }

    /// Bulk counterpart to `moveTask`, for the Boards multi-select "Move" action.
    func moveTasks<S: Sequence>(_ taskIDs: S, toBoardID boardID: String, columnID: String) where S.Element == String {
        for taskID in taskIDs {
            moveTask(taskID, toBoardID: boardID, columnID: columnID)
        }
    }

    /// Bulk Taskify-event counterpart to `deleteTasks`, matching the PWA selection bar. A bulk
    /// delete removes the selected occurrences only; recurring-series deletion remains an
    /// explicit choice in the individual event editor.
    func deleteTaskifyEvents<S: Sequence>(_ eventIDs: S) where S.Element == String {
        for eventID in eventIDs {
            deleteTaskifyEvent(eventID, scope: .single)
        }
    }

    /// Moves editable Taskify events with the selected tasks. Cross-board moves publish source
    /// tombstones before the new target-board versions, preserving the same replay protection as
    /// an event move performed through its editor.
    func moveTaskifyEvents<S: Sequence>(
        _ eventIDs: S,
        toBoardID boardID: String,
        columnID: String
    ) where S.Element == String {
        let eventsByID = (snapshot.taskifyEvents ?? []).reduce(into: [String: TaskifyEvent]()) {
            $0[$1.id] = $1
        }
        let orderedEventIDs = Array(Set(eventIDs)).sorted { lhsID, rhsID in
            let lhsIsSeed = eventsByID[lhsID].map { $0.recurrence?.isActive == true && $0.seriesID == $0.id } == true
            let rhsIsSeed = eventsByID[rhsID].map { $0.recurrence?.isActive == true && $0.seriesID == $0.id } == true
            if lhsIsSeed != rhsIsSeed { return lhsIsSeed }
            return lhsID < rhsID
        }
        var movedAny = false
        for eventID in orderedEventIDs {
            guard let result = snapshot.moveTaskifyEvent(
                eventID: eventID,
                toBoardID: boardID,
                columnID: columnID,
                editorPublicKey: identityPublicKey.nilIfEmpty
            ) else { continue }
            movedAny = true
            if result.crossedBoards {
                synchronizeTaskifyEventMove(
                    sourceEvents: result.sourceEvents,
                    targetEventIDs: result.movedEventIDs
                )
            } else {
                synchronizeTaskifyEvents(result.movedEventIDs)
            }
        }
        if movedAny {
            refreshNotifications(requestPermission: false)
        }
    }

    func deleteTask(_ taskID: String, scope: TaskDeletionScope = .single) {
        let changes = snapshot.deleteTask(
            taskID: taskID,
            scope: scope,
            editorPublicKey: identityPublicKey.nilIfEmpty
        )
        guard !changes.allTaskIDs.isEmpty else { return }
        changes.updatedTaskIDs.forEach { synchronizeTask($0) }
        changes.deletedTaskIDs.forEach {
            synchronizeTask($0, includeDeletionEvent: true)
        }
        refreshNotifications(requestPermission: false)
        reconcileScriptureMemory()
    }

    /// Deletes every completed task on a board (and, for compound boards, its linked child boards),
    /// mirroring the PWA's "Clear completed" action.
    func clearCompletedTasks(forBoardID boardID: String) {
        guard let board = board(withID: boardID),
              board.kind != .bible,
              !board.clearCompletedDisabled else {
            return
        }
        let scopeIDs: Set<String>
        if board.kind == .compound {
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

    func enableDMPushNotifications(
        selection: DMPushNotificationSelection,
        relayURL rawRelayURL: String,
        serverURL rawServerURL: String
    ) async {
        guard let relayURL = TaskifyRelayURL.normalize(rawRelayURL),
              let serverURL = Self.normalizedDMPushServerURL(rawServerURL) else {
            dmPushStatus = "Enter valid wss:// and https:// addresses"
            return
        }
        let identity: NostrIdentity
        do {
            guard let storedIdentity = try identityStore.load() else {
                dmPushStatus = "A Nostr identity is required"
                return
            }
            identity = storedIdentity
        } catch {
            dmPushStatus = error.localizedDescription
            return
        }

        dmPushStatus = "Registering with Apple…"
        do {
            let deviceToken = try await TaskifyDMPushCoordinator.shared.requestDeviceToken()
            dmPushStatus = "Registering this device…"
            _ = try await DMPushRegistrationClient.register(
                deviceToken: deviceToken,
                environment: Self.dmPushAPNsEnvironment,
                installationID: TaskifyDMPushSettings.installationID,
                baseURL: serverURL,
                identity: identity
            )

            if nip17InboxRelayURLs.isEmpty {
                await ensureNIP17InboxRelayPreference()
            }
            let existingRelays = nip17InboxRelayURLs.isEmpty ? appRelays : nip17InboxRelayURLs
            let relayAlreadyPresent = existingRelays.contains(relayURL)
            if !relayAlreadyPresent {
                do {
                    try await updateNIP17InboxRelayPreference(existingRelays + [relayURL], identity: identity)
                } catch {
                    _ = try? await DMPushRegistrationClient.unregister(
                        installationID: TaskifyDMPushSettings.installationID,
                        baseURL: serverURL,
                        identity: identity
                    )
                    throw error
                }
            }

            TaskifyDMPushSettings.saveEnabled(
                selection: selection,
                relayURL: relayURL,
                serverURL: serverURL.absoluteString,
                deviceToken: deviceToken
            )
            dmPushEnabled = true
            dmPushSelection = selection
            dmPushRelayURL = relayURL
            dmPushServerURL = serverURL.absoluteString
            dmPushStatus = "Enabled for \(selection.title.lowercased())"
        } catch {
            dmPushStatus = error.localizedDescription
        }
    }

    func setDMPushSelection(_ selection: DMPushNotificationSelection) {
        TaskifyDMPushSettings.saveSelection(selection)
        dmPushSelection = selection
        if dmPushEnabled {
            dmPushStatus = "Enabled for \(selection.title.lowercased())"
        }
    }

    func disableDMPushNotifications() async {
        guard dmPushEnabled else { return }
        guard let serverURL = Self.normalizedDMPushServerURL(dmPushServerURL),
              let identity = try? identityStore.load() else {
            dmPushStatus = "The current push registration could not be authenticated"
            return
        }
        dmPushStatus = "Disabling…"
        do {
            let response = try await DMPushRegistrationClient.unregister(
                installationID: TaskifyDMPushSettings.installationID,
                baseURL: serverURL,
                identity: identity
            )
            if response.remainingRegistrations == 0,
               nip17InboxRelayURLs.contains(dmPushRelayURL) {
                var remaining = nip17InboxRelayURLs.filter { $0 != dmPushRelayURL }
                if remaining.isEmpty {
                    remaining = appRelays.filter { $0 != dmPushRelayURL }
                }
                if !remaining.isEmpty {
                    try await updateNIP17InboxRelayPreference(remaining, identity: identity)
                }
            }
            TaskifyDMPushSettings.clearEnabled()
            dmPushEnabled = false
            dmPushStatus = "Off"
        } catch {
            dmPushStatus = error.localizedDescription
        }
    }

    func refreshDMPushRegistration(deviceToken: String) async {
        guard dmPushEnabled,
              let serverURL = Self.normalizedDMPushServerURL(dmPushServerURL),
              let identity = try? identityStore.load() else { return }
        do {
            _ = try await DMPushRegistrationClient.register(
                deviceToken: deviceToken,
                environment: Self.dmPushAPNsEnvironment,
                installationID: TaskifyDMPushSettings.installationID,
                baseURL: serverURL,
                identity: identity
            )
            TaskifyDMPushSettings.saveDeviceToken(deviceToken)
            if nip17InboxRelayURLs.isEmpty {
                await ensureNIP17InboxRelayPreference()
            }
            if !nip17InboxRelayURLs.contains(dmPushRelayURL) {
                let existing = nip17InboxRelayURLs.isEmpty ? appRelays : nip17InboxRelayURLs
                try await updateNIP17InboxRelayPreference(existing + [dmPushRelayURL], identity: identity)
            }
            dmPushStatus = "Enabled for \(dmPushSelection.title.lowercased())"
        } catch {
            dmPushStatus = "Needs attention: \(error.localizedDescription)"
        }
    }

    func handleDMPushWake(notifyMessages: Bool = true) async -> UIBackgroundFetchResult {
        guard dmPushEnabled, !isHandlingDMPushWake else { return .noData }
        isHandlingDMPushWake = true
        pendingDMPushCategories.removeAll()
        defer { isHandlingDMPushWake = false }

        await syncEngine.retryNow()
        for _ in 0..<8 {
            if !pendingDMPushCategories.isEmpty { break }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return .failed }
        }

        let categories = pendingDMPushCategories
        pendingDMPushCategories.removeAll()
        if notifyMessages,
           categories.contains(.message),
           dmPushSelection.allows(.message) {
            await TaskifyDMPushLocalNotifier.shared.notifyNewMessage()
        }
        let paymentReceived = await walletDMPushRefreshHandler?(
            dmPushSelection.allows(.paymentReceived)
        ) ?? false
        return categories.isEmpty && !paymentReceived ? .noData : .newData
    }

    private static var dmPushAPNsEnvironment: String {
#if DEBUG
        "sandbox"
#else
        "production"
#endif
    }

    private static func normalizedDMPushServerURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              components.host != nil else { return nil }
        components.query = nil
        components.fragment = nil
        if components.path == "/" { components.path = "" }
        return components.url
    }

    func selectEncryptedFileServer(_ url: String) {
        guard let normalized = TaskifyMediaServerSettings.selectServer(url) else { return }
        encryptedMediaServerURL = normalized
        scheduleAccountBackupPublish()
    }

    @discardableResult
    func addEncryptedFileServer(url: String, type: TaskifyFileServerType) -> TaskifyMediaServerSettings.AddResult {
        let result = TaskifyMediaServerSettings.addServer(url: url, type: type)
        if case .added = result {
            encryptedFileServers = TaskifyMediaServerSettings.servers
            encryptedMediaServerURL = TaskifyMediaServerSettings.configuredServer
            scheduleAccountBackupPublish()
        }
        return result
    }

    func removeEncryptedFileServer(_ url: String) {
        guard TaskifyMediaServerSettings.removeServer(url) else { return }
        encryptedFileServers = TaskifyMediaServerSettings.servers
        encryptedMediaServerURL = TaskifyMediaServerSettings.configuredServer
        scheduleAccountBackupPublish()
    }

    func resetEncryptedFileServers() {
        TaskifyMediaServerSettings.resetToDefaults()
        encryptedFileServers = TaskifyMediaServerSettings.servers
        encryptedMediaServerURL = TaskifyMediaServerSettings.configuredServer
        scheduleAccountBackupPublish()
    }

    // MARK: - Local backup

    /// A device-local snapshot of every board/task/contact/Bible-tracker/scripture-memory field,
    /// matching the PWA's "Download backup" (`taskify-pwa/src/ui/settings/BackupSection.tsx`): an
    /// additional offline copy independent of the encrypted Nostr account backup, so data survives
    /// even if every relay is unreachable. Deliberately excludes the Nostr identity and wallet
    /// seed -- both already have their own dedicated export flows (Settings' nsec copy, the
    /// wallet's seed-phrase backup), and bundling secrets into a plain-JSON file here would make
    /// this backup far more sensitive to lose track of.
    func localBackupJSON() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(snapshot)
        guard let json = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return json
    }

    /// Wholesale-replaces local app data from an imported local backup file. Unlike merging
    /// remote sync updates, this is a full restore -- callers must confirm with the user first,
    /// since it discards whatever was on the device. Re-runs the same post-load bookkeeping
    /// `load()` does after reading the store from disk (notification scheduling, Bible/fasting
    /// reminder reconciliation, sync reconfiguration for the restored boards' relays, Taskify-event
    /// recurrence window, contacts) so the restored state is fully wired up, not just held in
    /// memory. Identity/keys are untouched -- this only ever replaces task/board/contact data.
    func restoreLocalBackup(_ restored: TaskifySnapshot) async {
        snapshot = restored
        await persistImmediately()
        applyStartupBoardPreference()
        refreshNotifications(requestPermission: false)
        reconcileFastingReminders()
        reconcileScriptureMemory()
        reconfigureSync()
        maintainTaskifyEventRecurrenceWindow()
        refreshContacts()
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

    /// Re-reads the store when something outside the app has written to it -- currently the
    /// widget's complete-task button, which edits the shared file directly.
    ///
    /// Without this the app keeps its in-memory snapshot across a backgrounding, so a task
    /// completed from the widget reappears when the app comes forward, and the app's next save
    /// writes that stale state back over the widget's. The file's modification date is the signal:
    /// anything newer than our own last write came from elsewhere.
    func reloadIfChangedExternally() {
        guard !isLoading else { return }
        guard let modified = try? FileManager.default.attributesOfItem(
            atPath: JSONTaskStore.defaultURL.path
        )[.modificationDate] as? Date else { return }
        guard modified > lastStoreWriteAt.addingTimeInterval(0.5) else { return }

        Task { @MainActor in
            guard let reloaded = try? await store.load() else { return }
            guard reloaded != snapshot else { return }
            snapshot = reloaded
            lastStoreWriteAt = Date()
            refreshNotifications(requestPermission: false)
        }
    }

    func refreshSyncIfNeeded() {
        guard !isLoading else { return }
        switch syncState {
        case .offline, .stopped:
            retrySync()
        case .connecting, .online:
            Task { [syncEngine] in
                await syncEngine.refreshAfterForeground()
            }
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

    /// Joins the shared board (idempotent — a board already joined by nostrBoardID just gets
    /// reselected) and marks the inbox item accepted.
    @discardableResult
    func acceptSharedBoardInboxItem(_ itemID: String) -> Bool {
        guard let item = snapshot.sharedBoardInboxItems?.first(where: { $0.id == itemID }),
              item.status == .pending else { return false }
        let relays = item.board.relayURLs?.isEmpty == false ? item.board.relayURLs! : appRelays
        guard snapshot.joinWeekBoard(
            nostrBoardID: item.board.boardID,
            name: item.board.boardName ?? "Shared Board",
            relayURLs: relays
        ) != nil else { return false }
        guard snapshot.setSharedBoardInboxStatus(itemID: itemID, status: .accepted) != nil else {
            return false
        }
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
        return true
    }

    func dismissSharedBoardInboxItem(_ itemID: String) {
        guard snapshot.setSharedBoardInboxStatus(itemID: itemID, status: .deleted) != nil else { return }
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

    private func queueTaskifyEventInvitations(
        eventID: String,
        recipientPublicKeys: [String]
    ) {
        guard !recipientPublicKeys.isEmpty,
              let event = snapshot.taskifyEvents?.first(where: { $0.id == eventID }) else { return }
        let targets = recipientPublicKeys.compactMap { value -> (
            recipient: Data,
            delivery: SharedCalendarEventDelivery,
            fallbackRelays: [String]
        )? in
            guard let recipient = NostrPublicKey.parse(value),
                  recipient.hexString != identityPublicKey,
                  let delivery = TaskifyEventInvitationPlanner.delivery(
                      event: event,
                      recipientPublicKey: recipient.hexString
                  ) else { return nil }
            let participantRelay = event.participants?
                .first(where: { $0.publicKey == recipient.hexString })?
                .relayURL
                .map { [$0] } ?? []
            let contactRelays = snapshot.contact(publicKeyValue: recipient.hexString)?.relayURLs ?? []
            let fallbackRelays = TaskifyRelayURL.normalizedList(
                participantRelay + contactRelays + (event.relayURLs ?? []) + sharedInboxRelayURLs
            )
            guard !fallbackRelays.isEmpty else { return nil }
            return (recipient, delivery, fallbackRelays)
        }
        guard !targets.isEmpty else { return }

        Task { [weak self] in
            guard let self,
                  let identity = try? self.identityStore.load() else { return }
            var failed = false
            for target in targets {
                do {
                    guard let deliveryPlan = await self.nip17DeliveryPlan(
                        recipientPublicKey: target.recipient.hexString,
                        discoveryRelayURLs: target.fallbackRelays,
                        identity: identity
                    ) else {
                        failed = true
                        continue
                    }
                    let envelope = TaskifyShareEnvelope(
                        item: .calendarEvent(target.delivery),
                        senderNpub: identity.npub
                    )
                    try await self.publishNIP17Envelope(
                        envelope,
                        recipientPublicKey: target.recipient,
                        deliveryPlan: deliveryPlan,
                        identity: identity,
                        recordIDBase: "calendar-invite:\(eventID):\(target.recipient.hexString)"
                    )
                } catch {
                    failed = true
                }
            }
            if failed {
                self.errorMessage = "The event was saved, but Taskify could not queue every invitation yet."
            }
        }
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
        guard let deliveryPlan = await nip17DeliveryPlan(
            recipientPublicKey: recipientHex,
            discoveryRelayURLs: fallbackRelays,
            identity: identity
        ) else { throw SharedTaskSendError.noRelays }

        let delivery = SharedTaskDelivery(
            task: task,
            relayURLs: deliveryPlan.recipientRelayURLs,
            assignmentRecipientPublicKey: assignment ? recipientHex : nil
        )
        let envelope = TaskifyShareEnvelope(
            item: .task(delivery),
            senderNpub: identity.npub
        )

        snapshot.upsertSharedTaskRecipient(SharedTaskRecipient(
            publicKey: recipientHex,
            npub: recipientNpub,
            relayURLs: deliveryPlan.recipientRelayURLs
        ))
        scheduleSave()
        try await publishNIP17Envelope(
            envelope,
            recipientPublicKey: recipientPublicKey,
            deliveryPlan: deliveryPlan,
            identity: identity,
            recordIDBase: assignment
                ? "assignment:\(task.id):\(recipientHex)"
                : nil
        )

        if assignment,
           snapshot.markTaskAssigned(
               taskID: task.id,
               recipientPublicKey: recipientHex,
               recipientRelayURL: deliveryPlan.recipientRelayURLs.first,
               editorPublicKey: identity.publicKeyHex
           ) != nil {
            scheduleSave()
            synchronizeTask(task.id)
        }
        return SharedTaskSendResult(
            recipientNpub: recipientNpub,
            relayCount: deliveryPlan.recipientRelayURLs.count,
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
        guard let deliveryPlan = await nip17DeliveryPlan(
            recipientPublicKey: recipientPublicKey.hexString,
            discoveryRelayURLs: fallbackRelays,
            identity: identity
        ) else { throw StructuredShareSendError.noRelays }

        var delivery = SharedContactDelivery(contact: contact)
        let contactRelays = TaskifyRelayURL.normalizedList(
            (delivery.relayURLs ?? []) + deliveryPlan.recipientRelayURLs
        )
        delivery.relayURLs = contactRelays.isEmpty ? nil : contactRelays
        let envelope = TaskifyShareEnvelope(
            item: .contact(delivery),
            senderNpub: identity.npub
        )
        try await publishNIP17Envelope(
            envelope,
            recipientPublicKey: recipientPublicKey,
            deliveryPlan: deliveryPlan,
            identity: identity
        )
    }

    /// Shares a board over an encrypted DM, matching the PWA's board-share envelope. Takes the
    /// resolved board identity/relays directly (rather than a local board id) so it works for a
    /// template snapshot too — a template board never joins `snapshot.boards`.
    func sendSharedBoard(
        boardID: String,
        boardName: String,
        relayURLs: [String],
        to recipientValue: String
    ) async throws {
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
            knownRecipientRelays + relayURLs + sharedInboxRelayURLs
        )
        guard !fallbackRelays.isEmpty else { throw StructuredShareSendError.noRelays }
        guard let deliveryPlan = await nip17DeliveryPlan(
            recipientPublicKey: recipientPublicKey.hexString,
            discoveryRelayURLs: fallbackRelays,
            identity: identity
        ) else { throw StructuredShareSendError.noRelays }

        let delivery = SharedBoardDelivery(
            boardID: boardID,
            boardName: boardName,
            relayURLs: TaskifyRelayURL.normalizedList(
                relayURLs + deliveryPlan.recipientRelayURLs
            )
        )
        let envelope = TaskifyShareEnvelope(
            item: .board(delivery),
            senderNpub: identity.npub
        )
        try await publishNIP17Envelope(
            envelope,
            recipientPublicKey: recipientPublicKey,
            deliveryPlan: deliveryPlan,
            identity: identity
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
        guard let deliveryPlan = await nip17DeliveryPlan(
            recipientPublicKey: recipientHex,
            discoveryRelayURLs: fallbackRelays,
            identity: identity
        ) else { throw NostrDirectMessageError.noRelays }

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
            createdAt: currentDirectMessageTimestamp(),
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
            relayURLs: deliveryPlan.recipientRelayURLs
        ) else { throw NostrDirectMessageError.invalidRecipient }

        if snapshot.ingestDirectMessage(localMessage) { scheduleSave() }
        let allDeliveryRelays = TaskifyRelayURL.normalizedList(
            deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs
        )
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: allDeliveryRelays,
            inboxPublicKey: identity.publicKeyHex,
            inboxRelayURLs: deliveryPlan.senderRelayURLs
        )
        try await syncEngine.publish(
            recipientWrap,
            relayURLs: deliveryPlan.recipientRelayURLs,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):recipient"
        )
        try await syncEngine.publish(
            senderWrap,
            relayURLs: deliveryPlan.senderRelayURLs,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):sender"
        )
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
        guard let deliveryPlan = await nip17DeliveryPlan(
            recipientPublicKey: recipientHex,
            discoveryRelayURLs: fallbackRelays,
            identity: identity
        ) else { throw NostrDirectMessageError.noRelays }

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
            deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs
        )
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: allDeliveryRelays,
            inboxPublicKey: identity.publicKeyHex,
            inboxRelayURLs: deliveryPlan.senderRelayURLs
        )
        try await syncEngine.publish(
            recipientWrap,
            relayURLs: deliveryPlan.recipientRelayURLs,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):reaction:recipient"
        )
        try await syncEngine.publish(
            senderWrap,
            relayURLs: deliveryPlan.senderRelayURLs,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):reaction:sender"
        )
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
            createdAt: currentDirectMessageTimestamp(),
            kind: kind,
            tags: tags,
            content: content
        )
        let relayMap = await groupDeliveryRelays(group: group, identity: identity)
        let recipientRelays = relayMap.values.flatMap { $0 }
        if nip17InboxRelayURLs.isEmpty { await ensureNIP17InboxRelayPreference() }
        let senderRelays = effectiveNIP17InboxRelayURLs
        let recipientCount = group.memberPublicKeys.filter {
            $0 != identity.publicKeyHex
        }.count
        guard relayMap.count == recipientCount,
              !recipientRelays.isEmpty,
              !senderRelays.isEmpty else { throw NostrDirectMessageError.noRelays }

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
        let allRelays = TaskifyRelayURL.normalizedList(senderRelays + recipientRelays)
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: allRelays,
            inboxPublicKey: identity.publicKeyHex,
            inboxRelayURLs: senderRelays
        )
        try await syncEngine.publish(
            selfWrap,
            relayURLs: senderRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):group:sender"
        )
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
        if nip17InboxRelayURLs.isEmpty { await ensureNIP17InboxRelayPreference() }
        let senderRelays = effectiveNIP17InboxRelayURLs
        let recipientCount = group.memberPublicKeys.filter {
            $0 != identity.publicKeyHex
        }.count
        guard relayMap.count == recipientCount,
              !recipientRelays.isEmpty,
              !senderRelays.isEmpty else { throw NostrDirectMessageError.noRelays }
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
        let allRelays = TaskifyRelayURL.normalizedList(senderRelays + recipientRelays)
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: allRelays,
            inboxPublicKey: identity.publicKeyHex,
            inboxRelayURLs: senderRelays
        )
        try await syncEngine.publish(
            selfWrap,
            relayURLs: senderRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):group-reaction:sender"
        )
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
            let relays = await NIP17InboxRelayResolver.resolve(
                recipientPublicKey: member,
                discoveryRelayURLs: fallback
            )
            guard !relays.isEmpty else { continue }
            result[member] = relays
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
            discoveryRelayURLs: fallback
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
        await refreshNotificationsImmediately()
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
        if let identity = cachedIdentity {
            refreshAccountSync(identity: identity)
            let accountSyncDeadline = Date().addingTimeInterval(6)
            while !Task.isCancelled, isCheckingAccountBackup, Date() < accountSyncDeadline {
                try? await Task.sleep(for: .milliseconds(300))
            }
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
        guard let board = snapshot.createWeekBoard(name: name, relayURLs: appRelays) else {
            return false
        }
        scheduleSave()
        reconfigureSync()
        publishBoard(board)
        return true
    }

    @discardableResult
    func createListBoard(name: String) -> Bool {
        guard let board = snapshot.createListBoard(name: name, relayURLs: appRelays) else {
            return false
        }
        scheduleSave()
        reconfigureSync()
        publishBoard(board)
        return true
    }

    @discardableResult
    func createCompoundBoard(name: String, childBoardIDs: [String]) -> Bool {
        guard let board = snapshot.createCompoundBoard(
            name: name,
            childBoardIDs: childBoardIDs,
            relayURLs: appRelays
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
        // Calling a `mutating` method directly on `snapshot` fires its `didSet` even when the
        // method changes nothing — invalidating every observing view and discarding the lookup
        // cache. Reconcile a copy and write back only when it actually differs.
        var updated = snapshot
        let result = updated.reconcileFastingReminders(
            enabled: fastingRemindersEnabled,
            mode: fastingRemindersMode,
            weekday: fastingRemindersWeekday,
            perMonth: fastingRemindersPerMonth,
            seed: FastingRemindersSettings.seed,
            calendar: weekCalendar
        )
        if updated != snapshot {
            snapshot = updated
        }
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

    private static let scriptureMemorySeriesID = ScriptureMemoryAlgorithm.seriesID
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
        // The PWA removes every task tied to the passage. Do the same here so an older completed
        // occurrence cannot later seed another recurrence after the passage has been removed.
        let taskIDs = snapshot.tasks.compactMap { task in
            task.scriptureMemoryID == entryID && !task.isDeleted ? task.id : nil
        }
        for taskID in taskIDs {
            deleteTask(taskID)
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

    func setScriptureMemorySort(_ sort: ScriptureMemorySort) {
        ScriptureMemorySettings.setSort(sort)
        scriptureMemorySort = sort
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
        let completedAtISO = ISO8601DateFormatter().string(from: Date())
        scriptureMemoryState.entries[index].lastReviewISO = completedAtISO
        scriptureMemoryState.entries[index].scheduledAtISO = nil
        scriptureMemoryState.lastReviewISO = completedAtISO
        persistScriptureMemoryState()
        reconcileScriptureMemory()
    }

    /// Advances completed reviews, repairs tasks created by older native builds, and maintains
    /// the same recurring review series as the PWA. In particular, "Daily" is a real daily
    /// recurrence; spaced-repetition chooses *which passage* appears on each occurrence rather
    /// than delaying the next task beyond the configured frequency.
    @discardableResult
    /// Writes a batch of task edits to `snapshot` as a single observed mutation.
    ///
    /// Empties the batch so a caller can reuse it between passes without re-applying edits.
    private func applyPendingTaskEdits(_ edits: inout [Int: TaskItem]) {
        guard !edits.isEmpty else { return }
        var tasks = snapshot.tasks
        for (index, task) in edits where tasks.indices.contains(index) {
            tasks[index] = task
        }
        snapshot.tasks = tasks
        edits.removeAll(keepingCapacity: true)
    }

    func reconcileScriptureMemory() -> Set<String> {
        guard scriptureMemoryEnabled, !scriptureMemoryState.entries.isEmpty else { return [] }

        let isoFormatter = ISO8601DateFormatter()
        let now = Date()
        let nowISO = isoFormatter.string(from: now)
        let recurrence = ScriptureMemoryAlgorithm.recurrence(for: scriptureMemoryFrequency)
        var updatedTaskIDs: Set<String> = []
        var reviewedTasks: [(entryID: String, dueDate: Date?, completedAt: Date)] = []
        var stateChanged = false

        /// Entry position by id, so the passes below can look one up directly. They previously
        /// scanned the entry array for every task on the board, which is a full O(tasks × entries)
        /// sweep — and this runs once per merged task during a relay replay.
        var entryIndexByID: [String: Int] = [:]
        entryIndexByID.reserveCapacity(scriptureMemoryState.entries.count)
        for (index, entry) in scriptureMemoryState.entries.enumerated() {
            entryIndexByID[entry.id] = index
        }

        /// Task edits are collected and applied in a single write.
        ///
        /// `snapshot.tasks[index] = task` goes through `snapshot`'s observed setter, so each one
        /// copies the whole snapshot, fires `didSet`, wipes the lookup cache and bumps the
        /// revision every view memoizes against. Doing that once per changed task turned a
        /// routine reconcile into dozens of full invalidations.
        var pendingTaskEdits: [Int: TaskItem] = [:]

        // Older native builds left these PWA fields in preservedSyncFields and used a different
        // series id. Promote them into the native model so review history survives local storage
        // and future Nostr publishes.
        for index in snapshot.tasks.indices {
            var task = snapshot.tasks[index]
            guard isScriptureMemoryTask(task) else { continue }
            var taskChanged = false

            if task.scriptureMemoryID == nil,
               let value = scriptureMemoryStringField(task, key: "scriptureMemoryId") {
                task.scriptureMemoryID = value
                taskChanged = true
            }
            if task.scriptureMemoryStage == nil,
               let value = scriptureMemoryIntegerField(task, key: "scriptureMemoryStage") {
                task.scriptureMemoryStage = value
                taskChanged = true
            }
            if task.scriptureMemoryPreviousReviewISO == nil,
               let value = scriptureMemoryStringField(task, key: "scriptureMemoryPrevReviewISO") {
                task.scriptureMemoryPreviousReviewISO = value
                taskChanged = true
            }
            if task.scriptureMemoryScheduledAtISO == nil,
               let value = scriptureMemoryStringField(task, key: "scriptureMemoryScheduledAt") {
                task.scriptureMemoryScheduledAtISO = value
                taskChanged = true
            }
            if let entryID = task.scriptureMemoryID,
               let entryIndex = entryIndexByID[entryID] {
                let entry = scriptureMemoryState.entries[entryIndex]
                if task.scriptureMemoryStage == nil {
                    task.scriptureMemoryStage = entry.stage
                    taskChanged = true
                }
                if task.scriptureMemoryPreviousReviewISO == nil,
                   let lastReviewISO = entry.lastReviewISO {
                    task.scriptureMemoryPreviousReviewISO = lastReviewISO
                    taskChanged = true
                }
                if task.scriptureMemoryScheduledAtISO == nil,
                   let scheduledAtISO = entry.scheduledAtISO {
                    task.scriptureMemoryScheduledAtISO = scheduledAtISO
                    taskChanged = true
                }
            }
            if task.seriesID != Self.scriptureMemorySeriesID {
                task.seriesID = Self.scriptureMemorySeriesID
                taskChanged = true
            }
            if task.recurrence != recurrence {
                task.recurrence = recurrence
                taskChanged = true
            }

            if taskChanged {
                pendingTaskEdits[index] = task
                updatedTaskIDs.insert(task.id)
            }
        }

        applyPendingTaskEdits(&pendingTaskEdits)

        // Apply every newly observed completion exactly once. The stage stored on the task is the
        // pre-review stage used by the PWA, which prevents out-of-order relay events from jumping
        // an entry more than one level.
        for task in snapshot.tasks where task.completed && !task.isDeleted {
            guard let entryID = task.scriptureMemoryID,
                  let completedAt = task.completedAt,
                  let entryIndex = entryIndexByID[entryID] else { continue }
            let entry = scriptureMemoryState.entries[entryIndex]
            if let entryLastReview = entry.lastReviewISO.flatMap({ isoFormatter.date(from: $0) }),
               entryLastReview >= completedAt {
                continue
            }
            let stageBefore = task.scriptureMemoryStage ?? entry.stage
            scriptureMemoryState.entries[entryIndex].stage = min(
                ScriptureMemoryAlgorithm.maxStage,
                max(0, stageBefore + 1)
            )
            scriptureMemoryState.entries[entryIndex].totalReviews += 1
            scriptureMemoryState.entries[entryIndex].lastReviewISO = isoFormatter.string(from: completedAt)
            scriptureMemoryState.entries[entryIndex].scheduledAtISO = nil
            if (scriptureMemoryState.lastReviewISO.flatMap { isoFormatter.date(from: $0) }
                ?? .distantPast) < completedAt {
                scriptureMemoryState.lastReviewISO = isoFormatter.string(from: completedAt)
            }
            reviewedTasks.append((entryID, task.dueDate, completedAt))
            stateChanged = true
        }

        let eligibleBoards = scriptureMemoryEligibleBoards
        let selectedBoard = scriptureMemoryBoardID.flatMap { boardID in
            eligibleBoards.first(where: { $0.id == boardID })
        }
        guard let targetBoard = selectedBoard ?? eligibleBoards.first,
              targetBoard.kind != .list || !targetBoard.columns.isEmpty else {
            if stateChanged { persistScriptureMemoryState() }
            if !updatedTaskIDs.isEmpty {
                scheduleSave()
                updatedTaskIDs.sorted().forEach { synchronizeTask($0) }
            }
            return updatedTaskIDs
        }

        // The PWA automatically chooses the first eligible board if a saved board was removed or
        // Scripture Memory was enabled before any board existed. Persist that fallback instead of
        // merely displaying it in the picker while task creation remains blocked by a nil id.
        if scriptureMemoryBoardID != targetBoard.id {
            ScriptureMemorySettings.setBoardID(targetBoard.id)
            scriptureMemoryBoardID = targetBoard.id
        }

        let calendar = weekCalendar
        for index in snapshot.tasks.indices {
            var task = snapshot.tasks[index]
            guard isScriptureMemoryTask(task) else { continue }
            var taskChanged = false
            if task.boardID != targetBoard.id {
                task.boardID = targetBoard.id
                task.columnID = targetBoard.kind == .week
                    ? task.dueDate.map { WeekdayColumn.containing($0, calendar: calendar).rawValue }
                    : targetBoard.columns.first?.id
                taskChanged = true
            } else if targetBoard.kind == .week,
                      let dueDate = task.dueDate {
                let dueColumnID = WeekdayColumn.containing(dueDate, calendar: calendar).rawValue
                if task.columnID != dueColumnID {
                    task.columnID = dueColumnID
                    taskChanged = true
                }
            } else if targetBoard.kind == .list,
                      !targetBoard.columns.contains(where: { $0.id == task.columnID }),
                      let firstColumnID = targetBoard.columns.first?.id {
                task.columnID = firstColumnID
                taskChanged = true
            }
            if taskChanged {
                pendingTaskEdits[index] = task
                updatedTaskIDs.insert(task.id)
            }
        }

        applyPendingTaskEdits(&pendingTaskEdits)

        // The generic recurrence engine initially clones the passage that was just completed.
        // Retarget that new occurrence to the passage the spaced-repetition algorithm selects,
        // exactly as the PWA's completion path does.
        var retargetedTaskIDs: Set<String> = []
        for review in reviewedTasks.sorted(by: { $0.completedAt < $1.completedAt }) {
            let candidates = snapshot.tasks.indices.filter { index in
                let task = snapshot.tasks[index]
                guard !task.completed,
                      !task.isDeleted,
                      task.scriptureMemoryID == review.entryID,
                      !retargetedTaskIDs.contains(task.id) else { return false }
                guard let reviewDueDate = review.dueDate, let dueDate = task.dueDate else {
                    return task.createdAt >= review.completedAt.addingTimeInterval(-2)
                }
                return dueDate > reviewDueDate
            }
            guard let nextIndex = candidates.min(by: {
                (snapshot.tasks[$0].dueDate ?? .distantFuture) < (snapshot.tasks[$1].dueDate ?? .distantFuture)
            }) else { continue }
            let selectionDate = snapshot.tasks[nextIndex].dueDate ?? now
            guard let selection = ScriptureMemoryAlgorithm.chooseNext(
                entries: scriptureMemoryState.entries,
                baseDays: Double(scriptureMemoryFrequency.days),
                now: selectionDate
            ) else { continue }
            applyScriptureMemorySelection(selection.entry, toTaskAt: nextIndex, scheduledAtISO: nowISO)
            if let entryIndex = entryIndexByID[selection.entry.id] {
                scriptureMemoryState.entries[entryIndex].scheduledAtISO = nowISO
            }
            stateChanged = true
            updatedTaskIDs.insert(snapshot.tasks[nextIndex].id)
            retargetedTaskIDs.insert(snapshot.tasks[nextIndex].id)
        }

        let hasActive = snapshot.tasks.contains {
            isScriptureMemoryTask($0) && !$0.completed && !$0.isDeleted
        }
        if !hasActive,
           let selection = ScriptureMemoryAlgorithm.chooseNext(
               entries: scriptureMemoryState.entries,
               baseDays: Double(scriptureMemoryFrequency.days),
               now: now
           ) {
            let dueDays = selection.stats.dueInDays.isFinite && selection.stats.dueInDays > 0
                ? Int(selection.stats.dueInDays.rounded(.up))
                : 0
            let dueDate = calendar.startOfDay(
                for: calendar.date(byAdding: .day, value: dueDays, to: now) ?? now
            )
            let resolvedColumnID = targetBoard.kind == .week
                ? WeekdayColumn.containing(dueDate, calendar: calendar).rawValue
                : targetBoard.columns.first?.id
            let hiddenUntil: Date?
            if targetBoard.kind == .list {
                hiddenUntil = dueDate > calendar.startOfDay(for: now) ? dueDate : nil
            } else {
                let currentWeek = WeekDateResolver.startOfWeek(
                    containing: now,
                    startingOn: weekStart,
                    calendar: calendar
                )
                let dueWeek = WeekDateResolver.startOfWeek(
                    containing: dueDate,
                    startingOn: weekStart,
                    calendar: calendar
                )
                hiddenUntil = dueWeek > currentWeek ? dueWeek : nil
            }
            let siblingOrders = snapshot.tasks.lazy
                .filter { $0.boardID == targetBoard.id && $0.columnID == resolvedColumnID && !$0.isDeleted }
                .map(\.order)
            let nextOrder = newTaskPosition == .top
                ? (siblingOrders.min() ?? 1) - 1
                : (siblingOrders.max() ?? -1) + 1
            let task = TaskItem(
                boardID: targetBoard.id,
                title: "Review \(ScriptureMemoryAlgorithm.reference(for: selection.entry))",
                dueDate: dueDate,
                dueDateEnabled: true,
                recurrence: recurrence,
                seriesID: Self.scriptureMemorySeriesID,
                scriptureMemoryID: selection.entry.id,
                scriptureMemoryStage: selection.entry.stage,
                scriptureMemoryPreviousReviewISO: selection.entry.lastReviewISO,
                scriptureMemoryScheduledAtISO: nowISO,
                hiddenUntilDate: hiddenUntil,
                createdAt: now,
                order: nextOrder,
                columnID: resolvedColumnID
            )
            snapshot.tasks.append(task)
            if let entryIndex = entryIndexByID[selection.entry.id] {
                scriptureMemoryState.entries[entryIndex].scheduledAtISO = nowISO
            }
            stateChanged = true
            updatedTaskIDs.insert(task.id)
        }

        if stateChanged { persistScriptureMemoryState() }
        if !updatedTaskIDs.isEmpty {
            scheduleSave()
            updatedTaskIDs.sorted().forEach { synchronizeTask($0) }
        }
        return updatedTaskIDs
    }

    private func isScriptureMemoryTask(_ task: TaskItem) -> Bool {
        ScriptureMemoryAlgorithm.isSeriesID(task.seriesID)
            || task.scriptureMemoryID != nil
            || scriptureMemoryStringField(task, key: "scriptureMemoryId") != nil
    }

    private func scriptureMemoryStringField(_ task: TaskItem, key: String) -> String? {
        guard case .string(let value)? = task.preservedSyncFields?[key] else { return nil }
        return value
    }

    private func scriptureMemoryIntegerField(_ task: TaskItem, key: String) -> Int? {
        switch task.preservedSyncFields?[key] {
        case .integer(let value):
            return Int(exactly: value)
        case .number(let value) where value.isFinite && value.rounded() == value:
            return Int(exactly: value)
        default:
            return nil
        }
    }

    private func applyScriptureMemorySelection(
        _ entry: ScriptureMemoryEntry,
        toTaskAt index: Int,
        scheduledAtISO: String
    ) {
        snapshot.tasks[index].title = "Review \(ScriptureMemoryAlgorithm.reference(for: entry))"
        snapshot.tasks[index].scriptureMemoryID = entry.id
        snapshot.tasks[index].scriptureMemoryStage = entry.stage
        snapshot.tasks[index].scriptureMemoryPreviousReviewISO = entry.lastReviewISO
        snapshot.tasks[index].scriptureMemoryScheduledAtISO = scheduledAtISO
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

    func setNewTaskPosition(_ position: NewTaskPosition) {
        TaskOrderingSettings.setPosition(position)
        newTaskPosition = position
    }

    func setWeekStart(_ weekday: WeekdayColumn) {
        guard WeekdayColumn.supportedWeekStarts.contains(weekday),
              weekday != weekStart else { return }
        WeekLayoutSettings.setStart(weekday)
        weekStart = weekday

        var updated = snapshot
        let updatedTaskIDs = updated.rebaseWeekVisibility(
            startingOn: weekday,
            calendar: weekCalendar
        )
        if updated != snapshot {
            snapshot = updated
            scheduleSave()
            updatedTaskIDs.forEach { synchronizeTask($0) }
        }

        reconcileFastingReminders()
        reconcileScriptureMemory()
        if showFullWeekRecurring { ensureFullWeekTaskRecurrences() }
    }

    func setShowFullWeekRecurring(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: TaskPresentationSettings.showFullWeekRecurringKey)
        showFullWeekRecurring = enabled
        if enabled { ensureFullWeekTaskRecurrences() }
    }

    func setStartupTab(_ tab: StartupTab) {
        StartupViewSettings.setTab(tab)
        startupTab = tab
    }

    func startupBoardID(for weekday: WeekdayColumn) -> String? {
        startupBoardIDsByWeekday[weekday.calendarWeekday - 1]
    }

    func setStartupBoardID(_ boardID: String?, for weekday: WeekdayColumn) {
        let weekdayIndex = weekday.calendarWeekday - 1
        if let boardID {
            guard visibleBoards.contains(where: { $0.id == boardID }) else { return }
            startupBoardIDsByWeekday[weekdayIndex] = boardID
        } else {
            startupBoardIDsByWeekday.removeValue(forKey: weekdayIndex)
        }
        StartupViewSettings.setBoardIDsByWeekday(startupBoardIDsByWeekday)
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
        let inboxRelays = effectiveNIP17InboxRelayURLs
        let timestamp = nextNostrTimestamp()
        let boardRelayTargets = board.effectiveRelayURLs
        scheduleSave()
        scheduleAccountBackupPublish()
        Task { [syncEngine] in
            do {
                try await syncEngine.replaceQueuedRelayTargets(
                    boardLocalID: board.id,
                    relayURLs: boardRelayTargets
                )
                await syncEngine.configure(
                    boards: boardsForSync,
                    auxiliaryRelayURLs: auxiliaryRelays,
                    inboxPublicKey: inboxPublicKey,
                    inboxRelayURLs: inboxRelays
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

    struct BoardRepublishResult: Equatable, Sendable {
        let taskCount: Int
        let eventCount: Int
        var publishedRecordCount: Int { 1 + taskCount + (eventCount * 2) }
    }

    struct BoardStaleCleanupResult: Equatable, Sendable {
        let staleEventCount: Int
        let scannedEventCount: Int
        let respondingRelayCount: Int
    }

    /// Forces fresh subscriptions. Native subscriptions intentionally request the full board
    /// history, so unlike the PWA there is no persisted cursor to clear first.
    func resyncBoardHistory(boardID: String) async throws {
        guard snapshot.boards.contains(where: { $0.id == boardID }) else {
            throw CocoaError(.fileNoSuchFile)
        }
        await syncEngine.retryNow()
    }

    /// Rebuilds one coherent board snapshot and enqueues it as a single outbox batch. The relay
    /// pacer can then deliver it without flooding stricter relays.
    @discardableResult
    func republishBoardSnapshot(boardID: String) async throws -> BoardRepublishResult {
        guard let board = snapshot.boards.first(where: { $0.id == boardID }) else {
            throw CocoaError(.fileNoSuchFile)
        }

        let boardTimestamp = nextNostrTimestamp()
        var refreshedTasks: [TaskItem] = []
        var refreshedEvents: [TaskifyEvent] = []
        var requests: [TaskSyncPublishRequest] = [
            TaskSyncPublishRequest(
                event: try TaskEventCodec.boardEvent(board: board, createdAt: boardTimestamp),
                board: board,
                taskID: "_board"
            )
        ]

        for current in snapshot.tasks.filter({ $0.boardID == boardID }) {
            var task = current
            let timestamp = nextNostrTimestamp()
            task.nostrUpdatedAt = timestamp
            refreshedTasks.append(task)
            requests.append(TaskSyncPublishRequest(
                event: try TaskEventCodec.taskEvent(task: task, board: board, createdAt: timestamp),
                board: board,
                taskID: task.id
            ))
        }

        for current in (snapshot.taskifyEvents ?? []).filter({
            $0.boardID == boardID && !$0.isReadOnly
        }) {
            let pair = try TaskifyCalendarEventCodec.eventPair(
                event: current,
                board: board,
                createdAt: nextNostrTimestamp()
            )
            refreshedEvents.append(pair.normalizedEvent)
            requests.append(TaskSyncPublishRequest(
                event: pair.canonical,
                board: board,
                taskID: "event:\(current.id):canonical"
            ))
            requests.append(TaskSyncPublishRequest(
                event: pair.view,
                board: board,
                taskID: "event:\(current.id):view"
            ))
        }

        try await syncEngine.queueForPublish(requests)
        await syncEngine.flushQueuedPublishes()

        let tasksByID = Dictionary(uniqueKeysWithValues: refreshedTasks.map { ($0.id, $0) })
        for index in snapshot.tasks.indices {
            if let refreshed = tasksByID[snapshot.tasks[index].id],
               snapshot.tasks[index].boardID == boardID {
                snapshot.tasks[index] = refreshed
            }
        }
        refreshedEvents.forEach { _ = snapshot.upsertTaskifyEvent($0) }
        if let index = snapshot.boards.firstIndex(where: { $0.id == boardID }) {
            snapshot.boards[index].nostrUpdatedAt = boardTimestamp
        }
        scheduleSave()
        scheduleAccountBackupPublish()
        return BoardRepublishResult(
            taskCount: refreshedTasks.count,
            eventCount: refreshedEvents.count
        )
    }

    @discardableResult
    func regenerateBoardNostrID(boardID: String) async throws -> String {
        guard let index = snapshot.boards.firstIndex(where: { $0.id == boardID }) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let previousID = snapshot.boards[index].effectiveNostrBoardID
        let newID = UUID().uuidString
        snapshot.boards[index].nostrBoardID = newID
        snapshot.boards[index].nostrUpdatedAt = nil

        // Imported compound boards can reference a child by its shared ID rather than local ID.
        // Keep those references attached when this board moves to a fresh relay namespace.
        for boardIndex in snapshot.boards.indices where snapshot.boards[boardIndex].kind == .compound {
            snapshot.boards[boardIndex].children = snapshot.boards[boardIndex].children.map {
                $0 == previousID ? newID : $0
            }
        }
        scheduleSave()
        reconfigureSync()
        scheduleAccountBackupPublish()
        _ = try await republishBoardSnapshot(boardID: boardID)
        snapshot.boards
            .filter { $0.kind == .compound && $0.children.contains(newID) }
            .forEach(publishBoard)
        return newID
    }

    func cleanStaleBoardEvents(boardID: String) async throws -> BoardStaleCleanupResult {
        guard let board = snapshot.boards.first(where: { $0.id == boardID }) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let author = try BoardCrypto.signingPublicKey(
            for: board.effectiveNostrBoardID
        ).hexString
        let boardTag = BoardCrypto.boardTag(for: board.effectiveNostrBoardID)
        let relayResults = await withTaskGroup(of: (Bool, [NostrEvent]).self) { group in
            for relayURL in board.effectiveRelayURLs {
                group.addTask {
                    do {
                        return (true, try await NostrRelayHistoryFetcher.authoredBoardEvents(
                            relayURL: relayURL,
                            kinds: [TaskEventCodec.taskEventKind],
                            authorPublicKey: author,
                            boardTag: boardTag
                        ))
                    } catch {
                        return (false, [])
                    }
                }
            }
            var values: [(Bool, [NostrEvent])] = []
            for await result in group { values.append(result) }
            return values
        }
        let respondingRelayCount = relayResults.filter { $0.0 }.count
        guard respondingRelayCount > 0 else { throw URLError(.cannotConnectToHost) }

        let allEvents = relayResults.flatMap { $0.1 }
        let uniqueEvents = Array(Dictionary(uniqueKeysWithValues: allEvents.map {
            ($0.id, $0)
        }).values)
        let staleIDs = TaskEventCodec.staleReplaceableEventIDs(
            uniqueEvents,
            expectedAuthor: author
        )
        if !staleIDs.isEmpty {
            let requests = try stride(from: 0, to: staleIDs.count, by: 50).map { start in
                let end = min(start + 50, staleIDs.count)
                return TaskSyncPublishRequest(
                    event: try TaskEventCodec.eventDeletionRequest(
                        eventIDs: Array(staleIDs[start..<end]),
                        board: board,
                        createdAt: nextNostrTimestamp()
                    ),
                    board: board,
                    taskID: "cleanup:\(start / 50)"
                )
            }
            try await syncEngine.queueForPublish(requests)
            await syncEngine.flushQueuedPublishes()
        }
        return BoardStaleCleanupResult(
            staleEventCount: staleIDs.count,
            scannedEventCount: uniqueEvents.count,
            respondingRelayCount: respondingRelayCount
        )
    }

    @discardableResult
    func archiveBoard(boardID: String) -> Bool {
        guard snapshot.archiveBoard(boardID: boardID) else { return false }
        sanitizeStartupBoardPreferences()
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
        sanitizeStartupBoardPreferences()
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
    func setBoardIndexCardEnabled(boardID: String, enabled: Bool) -> Bool {
        guard snapshot.setBoardIndexCardEnabled(boardID: boardID, enabled: enabled),
              let board = snapshot.boards.first(where: { $0.id == boardID }) else { return false }
        scheduleSave()
        publishBoard(board)
        return true
    }

    @discardableResult
    func setBoardClearCompletedEnabled(boardID: String, enabled: Bool) -> Bool {
        guard snapshot.setBoardClearCompletedEnabled(boardID: boardID, enabled: enabled),
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
        synchronizeTaskifyEvents(result.movedEventIDs + result.deletedEventIDs)
        if !result.deletedTaskIDs.isEmpty || !result.deletedEventIDs.isEmpty {
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
        let relays = share.relayURLs.isEmpty ? appRelays : share.relayURLs
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

        var queuedEventCount = 0
        var failedEventCount = 0
        let boardEvents = (snapshot.taskifyEvents ?? []).filter {
            $0.boardID == sourceBoard.id && !$0.isReadOnly && !$0.isDeleted
        }
        for event in boardEvents {
            do {
                guard let templateEvent = TaskifyEventTemplateSnapshot.make(
                    event: event,
                    sourceBoard: sourceBoard,
                    templateBoard: templateBoard
                ) else {
                    failedEventCount += 1
                    continue
                }
                let pair = try TaskifyCalendarEventCodec.eventPair(
                    event: templateEvent,
                    board: templateBoard,
                    createdAt: templateCreatedAt
                )
                publishRequests.append(TaskSyncPublishRequest(
                    event: pair.canonical,
                    board: templateBoard,
                    taskID: "event:\(event.id):canonical"
                ))
                publishRequests.append(TaskSyncPublishRequest(
                    event: pair.view,
                    board: templateBoard,
                    taskID: "event:\(event.id):view"
                ))
                queuedEventCount += 1
            } catch {
                failedEventCount += 1
            }
        }

        try await syncEngine.queueForPublish(publishRequests)
        Task { [syncEngine] in
            await syncEngine.flushQueuedPublishes()
        }

        return BoardTemplateShareResult(
            board: templateBoard,
            queuedTaskCount: queuedTaskCount,
            failedTaskCount: failedTaskCount,
            queuedEventCount: queuedEventCount,
            failedEventCount: failedEventCount
        )
    }

    /// The current identity's nsec, for the onboarding "create new login" backup step. Only
    /// meant to be read from that one deliberate, user-initiated screen — everywhere else in the
    /// app only exposes the public npub.
    func currentIdentityNsec() -> String? {
        guard let identity = try? identityStore.load(), !identity.nsec.isEmpty else { return nil }
        return identity.nsec
    }

    func watchSnapshot(now: Date = Date()) -> TaskifyWatchSnapshot {
        snapshot.watchData(now: now, calendar: weekCalendar)
    }

    var watchDataCalendar: Calendar { weekCalendar }

    /// Called only after the user confirms Watch provisioning in Settings. The raw key remains
    /// binary (never converted to an nsec string) and is immediately handed to the encrypted,
    /// reachable-only WatchConnectivity message path.
    func watchProvisioningPayload() throws -> TaskifyWatchProvisioningPayload {
        guard let identity = try identityStore.load() else {
            throw KeychainIdentityError.keychain(errSecItemNotFound)
        }
        return try TaskifyWatchProvisioningPayload(
            privateKey: identity.privateKey,
            publicKeyHex: identity.publicKeyHex,
            publicKeyNpub: identity.npub,
            relayURLs: TaskifyRelayURL.normalizedList(
                appRelays + snapshot.boards.flatMap(\.effectiveRelayURLs)
            ),
            snapshot: watchSnapshot()
        )
    }

    func completeFirstRunOnboarding() {
        OnboardingSettings.setCompleted(true)
        showsFirstRunOnboarding = false
    }

    /// Returns the raw nsec for export. Callers are responsible for gating this behind device
    /// authentication before displaying or copying it — the model performs no auth of its own,
    /// matching how `WalletViewModel.recoveryPhrase()` leaves Face ID/passcode to the view layer.
    func exportIdentityNsec() throws -> String {
        if let cachedIdentity { return cachedIdentity.nsec }
        guard let identity = try identityStore.load() else {
            throw NostrContactDirectoryError.identityUnavailable
        }
        cachedIdentity = identity
        return identity.nsec
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
            refreshAccountSync(identity: imported)
            refreshContacts()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Manual "Sync now" entry point from Settings — loads the identity if it isn't already
    /// cached, then runs the same silent check/merge as the automatic background triggers.
    func checkAccountSyncNow() {
        if let cachedIdentity {
            refreshAccountSync(identity: cachedIdentity)
            return
        }
        do {
            guard let identity = try identityStore.load() else {
                accountBackupMessage = "Import a Nostr identity before checking account sync."
                return
            }
            refreshAccountSync(identity: identity)
        } catch {
            accountBackupMessage = error.localizedDescription
        }
    }

    /// Throttled automatic entry point for the app-active and background-refresh triggers — an
    /// account-sync check is a relay round trip, so this avoids re-running it on every brief
    /// foreground return.
    func refreshAccountSyncIfNeeded() {
        guard !isLoading,
              !isCheckingAccountBackup,
              let identity = cachedIdentity,
              lastAccountBackupCheckAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true else { return }
        refreshAccountSync(identity: identity)
    }

    /// Finds the latest encrypted account-sync event for this identity and merges it in
    /// immediately — no review step. This is meant to be an ongoing background sync between
    /// every client (native or PWA) sharing this account's nsec, not a one-time restore, so a
    /// found payload is always applied silently.
    private func refreshAccountSync(identity: NostrIdentity) {
        accountBackupSearchTask?.cancel()
        isCheckingAccountBackup = true
        lastAccountBackupCheckAt = Date()
        accountBackupMessage = "Checking your linked devices for updates…"
        let relays = TaskifyRelayURL.normalizedList(
            appRelays + snapshot.boards.flatMap(\.effectiveRelayURLs)
        )
        accountBackupSearchTask = Task { [weak self] in
            let candidates = await NostrAccountBackupFinder.findCandidates(
                publicKey: identity.publicKeyHex,
                relayURLs: relays
            )
            guard !Task.isCancelled, let self else { return }
            let decodedPayload: NostrAppBackupPayload? = await Task.detached(priority: .utility) {
                () -> NostrAppBackupPayload? in
                for event in candidates {
                    if let payload = try? NostrAppBackupContract.decode(
                        event: event,
                        identity: identity
                    ) {
                        return payload
                    }
                }
                return nil
            }.value
            guard !Task.isCancelled else { return }
            isCheckingAccountBackup = false
            if let decodedPayload {
                applyAccountSyncPayload(decodedPayload)
            } else if candidates.isEmpty {
                accountBackupMessage = "No linked device found on your configured relays yet."
            } else {
                accountBackupMessage = "A sync update was found, but it could not be decrypted with this identity."
            }
        }
    }

    /// Merges a decoded account-sync payload into the local snapshot and republishes if this
    /// device's own boards have since diverged from it. Safe to call repeatedly with the same
    /// payload — board merging matches by Nostr board ID, so re-applying is a no-op.
    private func applyAccountSyncPayload(_ payload: NostrAppBackupPayload) {
        accountBackupBaseline = payload
        managedAccountBackupBoardIDs = payload.nativeManagedNostrBoardIDs
        lastAccountBackupCreatedAt = max(lastAccountBackupCreatedAt, payload.timestamp)
        applySyncedSettings(from: payload)
        let result = snapshot.mergePWAAccountBackup(payload)
        let imported = result.importedBoardCount
        let updated = result.updatedBoardCount
        accountBackupMessage = imported > 0
            ? "Synced \(imported) new board\(imported == 1 ? "" : "s") from your other device."
            : "Account sync is up to date."
        scheduleSave()
        reconfigureSync()
        let projectedPayload = payload.updatingNativeBoards(
            snapshot.boards,
            managedNostrBoardIDs: managedAccountBackupBoardIDs,
            timestamp: payload.timestamp
        )
        if projectedPayload != payload {
            scheduleAccountBackupPublish()
        }
    }

    private func load() async {
        defer { isLoading = false }
        // Before the first read: if the App Group capability has just been enabled, bring the
        // existing store into the shared container so enabling it doesn't look like data loss.
        // No-ops once migrated, and when the capability isn't in effect.
        TaskifySharedContainer.migrateIfNeeded()
        do {
            let hadExistingIdentity = (try? identityStore.load()) != nil
            OnboardingSettings.determineEligibilityIfNeeded(hadExistingIdentity: hadExistingIdentity)
            showsFirstRunOnboarding = !OnboardingSettings.completed
            let identity = try identityStore.loadOrCreate()
            applyIdentity(identity)
        } catch {
            errorMessage = error.localizedDescription
        }
        do {
            let loadResult = try await store.loadWithRepairStatus()
            snapshot = loadResult.snapshot
            let retentionPruneChanged: Bool
            if let cutoff = chatMessageRetention.cutoffTimestamp() {
                retentionPruneChanged = snapshot.pruneDirectMessageHistory(olderThan: cutoff).changed
            } else {
                retentionPruneChanged = false
            }
            if loadResult.wasRepaired || retentionPruneChanged {
                do {
                    try await store.save(snapshot)
                } catch {
                    errorMessage = "Taskify repaired your local data but could not save the repair."
                }
            }
        } catch {
            errorMessage = "Your native data could not be loaded. A fresh local workspace is being shown."
        }
#if DEBUG
        let fixtureApplied = applyChatUITestFixtureIfRequested()
            || applyBoardUITestFixtureIfRequested()
            || applyPerformanceUITestFixtureIfRequested()
        if fixtureApplied {
            // A UI-test fixture lives only in this process's memory, and the scenePhase-active
            // pass calls reloadIfChangedExternally(), which treats any store file newer than our
            // last write as someone else's update and replaces the snapshot with it — wiping the
            // fixture before the test's first assertion. Persist the fixture and stamp the write
            // so that reload recognises the file as our own.
            try? await store.save(snapshot)
            lastStoreWriteAt = Date()
        }
#endif
        applyStartupBoardPreference()
        refreshNotifications(requestPermission: false)
        reconcileFastingReminders()
        reconcileScriptureMemory()
        maintainTaskifyEventRecurrenceWindow()
        prepareInitialBoardViewCache()
        // Relay replay, contact discovery, and account-backup lookup are deliberately started
        // after SwiftUI commits the first populated board frame. Starting them here let their
        // callbacks compete with the user's first scroll even though the loading indicator had
        // already disappeared.
    }

    /// Called by the root view only after the populated interface has committed its first frame.
    /// A short grace period gives the user's first gesture priority; all work remains automatic.
    func initialContentDidAppear() {
        guard !isLoading, !didStartDeferredServices else { return }
        didStartDeferredServices = true
        deferredStartupTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled, let self else { return }
            if self.showFullWeekRecurring {
                self.ensureFullWeekTaskRecurrences()
            }
            self.startSync()
            await self.ensureNIP17InboxRelayPreference()

            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            self.refreshContacts()
            if let identity = self.cachedIdentity {
                self.refreshAccountSync(identity: identity)
            }
        }
    }

    private func ensureFullWeekTaskRecurrences(now: Date = Date()) {
        var updated = snapshot
        let result = updated.ensureCurrentWeekTaskRecurrences(
            weekStartsOn: weekStart,
            newTaskPosition: newTaskPosition,
            now: now,
            calendar: weekCalendar
        )
        guard updated != snapshot else { return }
        snapshot = updated
        let changedIDs = result.updatedIDs + result.created.map(\.id)
        changedIDs.forEach { synchronizeTask($0) }
        refreshNotifications(requestPermission: false)
    }

    /// Refreshes the current-week recurrence window after a day or week boundary while the app
    /// was suspended. Stable occurrence IDs make this a no-op when the week is already complete.
    func refreshFullWeekRecurrencesIfNeeded(now: Date = Date()) {
        guard showFullWeekRecurring, !isLoading else { return }
        ensureFullWeekTaskRecurrences(now: now)
    }

    private func prepareInitialBoardViewCache(now: Date = Date()) {
        guard startupTab == .boards, let board = selectedBoard else { return }
        let boardIDs: [String]
        switch board.kind {
        case .compound:
            boardIDs = snapshot.compoundChildBoards(for: board.id).map(\.id)
        case .week, .list:
            boardIDs = [board.id]
        case .bible:
            return
        }
        let completedTabEnabled = (UserDefaults.standard.object(
            forKey: TaskPresentationSettings.completedTabKey
        ) as? Bool) ?? TaskPresentationSettings.completedTabDefault
        snapshotLookupCache.prewarmBoardTasks(
            boardIDs: boardIDs,
            includeCompleted: !completedTabEnabled,
            snapshot: snapshot,
            weekStartsOn: weekStart,
            now: now,
            calendar: weekCalendar
        )
        _ = snapshotLookupCache.activeTaskIDs(snapshot: snapshot)
        _ = snapshotLookupCache.completedTaskCount(
            boardIDs: Set(boardIDs),
            snapshot: snapshot
        )
    }

    private func applyStartupBoardPreference(
        date: Date = Date(),
        calendar: Calendar = .current
    ) {
        sanitizeStartupBoardPreferences()
        guard let boardID = StartupBoardSelection.boardID(
            boards: snapshot.boards,
            preferredBoardIDsByWeekday: startupBoardIDsByWeekday,
            date: date,
            calendar: calendar
        ) else { return }
        snapshot.selectBoard(boardID)
    }

    private func sanitizeStartupBoardPreferences() {
        let sanitized = StartupBoardSelection.sanitizedPreferences(
            startupBoardIDsByWeekday,
            boards: snapshot.boards
        )
        guard sanitized != startupBoardIDsByWeekday else { return }
        startupBoardIDsByWeekday = sanitized
        StartupViewSettings.setBoardIDsByWeekday(sanitized)
    }

#if DEBUG
    /// Returns true when the fixture was applied.
    private func applyBoardUITestFixtureIfRequested() -> Bool {
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_BOARD_FIXTURE"] == "1" else {
            return false
        }
        let board = Board.week(name: "UI Test Board")
        snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [],
            selectedBoardID: board.id
        )
        errorMessage = nil
        return true
    }

    /// Returns true when the fixture was applied.
    private func applyPerformanceUITestFixtureIfRequested() -> Bool {
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_PERFORMANCE_FIXTURE"] == "1" else {
            return false
        }

        let board = Board.week(name: "Performance")
        let today = WeekdayColumn.containing(Date())
        let tasks = (0..<140).map { index in
            let weekday = index < 70
                ? today
                : WeekdayColumn.allCases[index % WeekdayColumn.allCases.count]
            let hasDetails = index.isMultiple(of: 4)
            return TaskItem(
                id: "performance-task-\(index)",
                boardID: board.id,
                title: "Performance task \(index + 1)",
                note: hasDetails
                    ? "A realistic task note used to exercise multi-line card layout while scrolling."
                    : "",
                dueDate: hasDetails ? Date().addingTimeInterval(TimeInterval(index * 900)) : nil,
                dueDateEnabled: hasDetails,
                dueTimeEnabled: hasDetails && index.isMultiple(of: 8),
                dueTimeZone: hasDetails ? TimeZone.current.identifier : nil,
                priority: index.isMultiple(of: 7) ? .medium : nil,
                subtasks: index.isMultiple(of: 6)
                    ? [
                        TaskSubtask(title: "First step", completed: true),
                        TaskSubtask(title: "Second step"),
                    ]
                    : nil,
                createdAt: Date().addingTimeInterval(TimeInterval(-index)),
                order: index,
                columnID: weekday.rawValue
            )
        }
        snapshot = TaskifySnapshot(
            boards: [board],
            tasks: tasks,
            selectedBoardID: board.id
        )
        errorMessage = nil
        return true
    }

    /// Returns true when the fixture was applied.
    private func applyChatUITestFixtureIfRequested() -> Bool {
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_FIXTURE"] == "1" else {
            return false
        }
        let peerPublicKey = String(repeating: "1", count: 64)
        let ownPublicKey = identityPublicKey.isEmpty
            ? String(repeating: "2", count: 64)
            : identityPublicKey
        snapshot.contacts = [
            NostrContact(
                publicKeyValue: peerPublicKey,
                petname: "UI Test Contact"
            ),
        ].compactMap { $0 }
        // 300 messages so the thread is several screens deep: short fixtures realize their
        // whole LazyVStack almost immediately, which hides scroll anchoring problems that only
        // show up while rows are still being realized mid-drag.
        let fixtureMessageCount = 300
        snapshot.directMessages = (1...fixtureMessageCount).map { index in
            let content: String
            switch index {
            case 2:
                content = "Searchable early fixture needle"
            case 8, 20, 32:
                content = "Repeatable fixture match \(index)"
            case 296:
                content = "Hi"
            case 297:
                content = "Could we make replies look more like Messages?"
            case 298:
                content = "Yes — the referenced message is separate now."
            case 299:
                content = "And reactions sit above the opposite corner."
            case fixtureMessageCount:
                content = "Newest fixture message"
            default:
                content = "Fixture conversation message \(index)"
            }
            let incoming = index.isMultiple(of: 2)
            return NostrDirectMessage(
                rumorEventID: "ui-message-\(index)",
                wrapEventID: "ui-wrap-\(index)",
                peerPublicKey: peerPublicKey,
                senderPublicKey: incoming ? peerPublicKey : ownPublicKey,
                content: content,
                createdAt: 1_784_647_200 + index,
                isIncoming: incoming,
                replyToEventID: index == 298 ? "ui-message-297" : nil
            )
        }
        snapshot.directMessageReactions = [
            NostrDirectMessageReaction(
                rumorEventID: "ui-reaction-1",
                wrapEventID: "ui-reaction-wrap-1",
                targetEventID: "ui-message-299",
                senderPublicKey: peerPublicKey,
                peerPublicKey: peerPublicKey,
                emoji: "❤️",
                createdAt: 1_784_647_500
            ),
            NostrDirectMessageReaction(
                rumorEventID: "ui-reaction-2",
                wrapEventID: "ui-reaction-wrap-2",
                targetEventID: "ui-message-300",
                senderPublicKey: ownPublicKey,
                peerPublicKey: peerPublicKey,
                emoji: "👍",
                createdAt: 1_784_647_501
            ),
            NostrDirectMessageReaction(
                rumorEventID: "ui-reaction-3",
                wrapEventID: "ui-reaction-wrap-3",
                targetEventID: "ui-message-300",
                senderPublicKey: ownPublicKey,
                peerPublicKey: peerPublicKey,
                emoji: "❤️",
                createdAt: 1_784_647_502
            ),
            NostrDirectMessageReaction(
                rumorEventID: "ui-reaction-4",
                wrapEventID: "ui-reaction-wrap-4",
                targetEventID: "ui-message-296",
                senderPublicKey: ownPublicKey,
                peerPublicKey: peerPublicKey,
                emoji: "❤️",
                createdAt: 1_784_647_503
            ),
        ]
        snapshot.directMessageReadAt = [:]
        snapshot.directMessageArchivedAt = [:]
        snapshot.directMessageDeletedEventIDs = [:]
        errorMessage = nil
        return true
    }
#endif

    private func applyIdentity(_ identity: NostrIdentity) {
        cachedIdentity = identity
        identityPublicKey = identity.publicKeyHex
        identityNpub = identity.npub
        Task { [syncEngine] in
            await syncEngine.setIdentity(identity)
        }
    }

    private func startSync() {
        let updates = syncEngine.updates()
        syncListenerTask?.cancel()
        syncListenerTask = Task { [weak self] in
            for await update in updates {
                guard !Task.isCancelled else { return }
                await self?.handleSyncUpdate(update)
            }
        }
        reconfigureSync()
    }

    private func reconfigureSync() {
        let boards = snapshot.boardsForSync
        let auxiliaryRelays = sharedInboxRelayURLs
        let inboxPublicKey = identityPublicKey.nilIfEmpty
        let inboxRelays = effectiveNIP17InboxRelayURLs
        Task { [syncEngine] in
            await syncEngine.configure(
                boards: boards,
                auxiliaryRelayURLs: auxiliaryRelays,
                inboxPublicKey: inboxPublicKey,
                inboxRelayURLs: inboxRelays
            )
        }
    }

    private func handleSyncUpdate(_ update: TaskSyncUpdate) async {
        switch update {
        // Each of these merges runs against a copy and assigns back only when it reports a real
        // change. Merging straight into `snapshot` fired its `didSet` for every event — and a
        // relay replay is mostly events we already have, so the common case was a full view
        // invalidation and lookup-cache wipe for a merge that did nothing.
        case .board(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            var updated = snapshot
            if updated.mergeRemoteBoard(record.board, eventCreatedAt: record.eventCreatedAt) {
                let isCompound = record.board.kind == .compound
                if isCompound {
                    _ = updated.ensureCompoundChildBoards(parentBoardID: record.board.id)
                }
                snapshot = updated
                if isCompound {
                    // Reads `snapshot.boardsForSync`, so it has to see the merged value.
                    reconfigureSync()
                }
                scheduleSave()
                scheduleAccountBackupPublish()
            }
        case .task(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            var updated = snapshot
            if updated.mergeRemoteTask(record.task, eventCreatedAt: record.eventCreatedAt) {
                snapshot = updated
                if showFullWeekRecurring {
                    ensureFullWeekTaskRecurrences()
                }
                // A completion or recurrence created by the PWA must advance the same Scripture
                // Memory state and choose the same next "Needs review" passage as a local action.
                reconcileScriptureMemory()
                scheduleSave()
                refreshNotifications(requestPermission: false)
            }
        case .calendarEvent(let record):
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
            var updated = snapshot
            if updated.mergeRemoteTaskifyEvent(
                record.event,
                eventCreatedAt: record.eventCreatedAt
            ) {
                snapshot = updated
                scheduleSave()
                maintainTaskifyEventRecurrenceWindow()
                refreshNotifications(requestPermission: false)
            }
        case .batch(let taskRecords, let calendarRecords):
            await applySyncBatch(tasks: taskRecords, calendarEvents: calendarRecords)
        case .sharedInbox(let event):
            enqueueSharedInboxEvents([event])
        case .sharedInboxBatch(let events):
            enqueueSharedInboxEvents(events)
        case .status(let report):
            applySyncReport(report)
        }
    }

    /// Merges a relay's stored-event backlog in one pass. Mutating a local copy and assigning
    /// `snapshot` once means the whole backlog costs a single observation invalidation (and one
    /// save/notification refresh) instead of one per event.
    private struct SyncBatchMergeResult: Sendable {
        let snapshot: TaskifySnapshot
        let tasksChanged: Bool
        let calendarChanged: Bool
    }

    private func applySyncBatch(
        tasks taskRecords: [TaskRelayRecord],
        calendarEvents calendarRecords: [TaskifyCalendarRelayRecord]
    ) async {
        for record in taskRecords {
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
        }
        for record in calendarRecords {
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
        }

        var baseRevision = snapshotRevision
        var baseSnapshot = snapshot
        let taskInputs = taskRecords.map { (task: $0.task, eventCreatedAt: $0.eventCreatedAt) }

        while !Task.isCancelled {
            // Initial relay history can contain hundreds of encrypted records. Merge and
            // recurrence deduplication are pure value work, so keep them off MainActor. If the
            // user edits while that work is running, retry against the new snapshot instead of
            // overwriting the local change.
            let mergeBase = baseSnapshot
            let result = await Task.detached(priority: .utility) {
                var updated = mergeBase
                let tasksChanged = updated.mergeRemoteTasks(taskInputs)
                var calendarChanged = false
                for record in calendarRecords {
                    if updated.mergeRemoteTaskifyEvent(
                        record.event,
                        eventCreatedAt: record.eventCreatedAt
                    ) {
                        calendarChanged = true
                    }
                }
                return SyncBatchMergeResult(
                    snapshot: updated,
                    tasksChanged: tasksChanged,
                    calendarChanged: calendarChanged
                )
            }.value

            guard snapshotRevision == baseRevision else {
                baseRevision = snapshotRevision
                baseSnapshot = snapshot
                continue
            }

            guard result.tasksChanged || result.calendarChanged else { return }
            snapshot = result.snapshot
            if result.tasksChanged, showFullWeekRecurring {
                ensureFullWeekTaskRecurrences()
            }
            if result.tasksChanged {
                reconcileScriptureMemory()
            }
            scheduleSave()
            if result.calendarChanged {
                maintainTaskifyEventRecurrenceWindow()
            }
            refreshNotifications(requestPermission: false)
            return
        }
    }

    private struct SharedInboxApplyEffects {
        var snapshotChanged = false
        var shouldReconfigureSync = false
        var taskIDsToSynchronize: Set<String> = []
        var walletDeliveryQueued = false
        var walletDeliveryFailed = false
    }

    private func enqueueSharedInboxEvents(_ events: [NostrEvent]) {
        guard !events.isEmpty else { return }
        pendingSharedInboxEvents.append(contentsOf: events)
        guard sharedInboxProcessingTask == nil else { return }
        sharedInboxProcessingTask = Task(priority: .utility) { [weak self] in
            await self?.processPendingSharedInboxEvents()
        }
    }

    private func processPendingSharedInboxEvents() async {
        let identity: NostrIdentity
        if let cachedIdentity {
            identity = cachedIdentity
        } else {
            do {
                guard let storedIdentity = try identityStore.load() else { return }
                identity = storedIdentity
            } catch {
                return
            }
            cachedIdentity = identity
        }

        while !pendingSharedInboxEvents.isEmpty, !Task.isCancelled {
            let events = pendingSharedInboxEvents
            pendingSharedInboxEvents.removeAll(keepingCapacity: true)
            let decryptedEvents: [NIP17DecryptedRumor] = await Task.detached(priority: .utility) {
                () -> [NIP17DecryptedRumor] in
                var seenEventIDs: Set<String> = []
                return events.compactMap { event in
                    guard seenEventIDs.insert(event.id).inserted else { return nil }
                    return try? NIP17GiftWrap.unwrapRumor(event, recipient: identity)
                }
            }.value
            guard !Task.isCancelled else { break }

            // Apply a bounded group at a time. This turns a relay replay that previously caused
            // hundreds of observation invalidations into a handful, while yielding between groups
            // so taps and scrolling are never held behind inbox maintenance.
            let chunkSize = 24
            var offset = 0
            while offset < decryptedEvents.count, !Task.isCancelled {
                let end = min(offset + chunkSize, decryptedEvents.count)
                var updatedSnapshot = snapshot
                var effects = SharedInboxApplyEffects()
                let connectedInboxRelays = Set(sharedInboxRelayURLs)
                for decrypted in decryptedEvents[offset..<end] {
                    applySharedInboxRumor(
                        decrypted,
                        identity: identity,
                        connectedInboxRelays: connectedInboxRelays,
                        snapshot: &updatedSnapshot,
                        effects: &effects
                    )
                }
                if effects.snapshotChanged {
                    snapshot = updatedSnapshot
                    scheduleSave()
                }
                if effects.shouldReconfigureSync {
                    reconfigureSync()
                }
                for taskID in effects.taskIDsToSynchronize {
                    synchronizeTask(taskID)
                }
                if effects.walletDeliveryQueued, !isHandlingDMPushWake {
                    walletPaymentDeliveryHandler?()
                }
                if effects.walletDeliveryFailed {
                    errorMessage = "Taskify could not save an incoming Cashu payment."
                }
                offset = end
                await Task.yield()
            }
        }

        sharedInboxProcessingTask = nil
    }

    private func applySharedInboxRumor(
        _ decrypted: NIP17DecryptedRumor,
        identity: NostrIdentity,
        connectedInboxRelays: Set<String>,
        snapshot updatedSnapshot: inout TaskifySnapshot,
        effects: inout SharedInboxApplyEffects
    ) {
        let rumor = decrypted.rumor
        // This only ever succeeds for a payment fulfilling a NUT-18 request *this device*
        // created (see receiveNostrPayment's requestID lookup) — it's for updating that
        // request's received-amount bookkeeping, not general incoming-payment detection. It
        // deliberately doesn't `return`: an unsolicited deposit (a Lightning-address forwarder
        // like solife.me, or anything else that isn't fulfilling a request of ours) needs to
        // keep flowing through to the generic detection below and to become a normal chat
        // message, the same way the PWA still shows every payment inline in the DM thread.
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
                    effects.walletDeliveryQueued = true
                }
            } catch {
                effects.walletDeliveryFailed = true
            }
        }
        if let group = NostrGroupConversation(
            rumor: rumor,
            identityPublicKey: identity.publicKeyHex
        ) {
            let inserted = updatedSnapshot.upsertGroupConversation(group)
            if inserted {
                effects.snapshotChanged = true
            }
            if rumor.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               rumor.tags.contains(where: { $0.count >= 2 && $0[0] == "subject" }) {
                return
            }
            if inserted, rumor.publicKey != identity.publicKeyHex {
                recordDMPushCategory(
                    forIncomingContent: rumor.content
                )
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
                let senderKey = try? Data(hex: message.senderPublicKey)
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
                if updatedSnapshot.ingestSharedInboxItem(item) {
                    effects.snapshotChanged = true
                    let addsRelay = TaskifyRelayURL.normalizedList(delivery.relayURLs ?? [])
                        .contains { !connectedInboxRelays.contains($0) }
                    effects.shouldReconfigureSync = effects.shouldReconfigureSync || addsRelay
                }
            case .contact(let delivery):
                let item = SharedContactInboxItem(
                    wrapEventID: message.wrapEventID,
                    rumorEventID: message.rumorEventID,
                    sender: sharedInboxSender(for: message),
                    contact: delivery,
                    receivedAt: Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                )
                if updatedSnapshot.ingestSharedContactInboxItem(item) {
                    effects.snapshotChanged = true
                    let addsRelay = TaskifyRelayURL.normalizedList(delivery.relayURLs ?? [])
                        .contains { !connectedInboxRelays.contains($0) }
                    effects.shouldReconfigureSync = effects.shouldReconfigureSync || addsRelay
                }
            case .calendarEvent(let delivery):
                let item = SharedCalendarInviteInboxItem(
                    wrapEventID: message.wrapEventID,
                    rumorEventID: message.rumorEventID,
                    sender: sharedInboxSender(for: message),
                    event: delivery,
                    receivedAt: Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                )
                if updatedSnapshot.ingestSharedCalendarInvite(item) {
                    effects.snapshotChanged = true
                    let addsRelay = TaskifyRelayURL.normalizedList(delivery.relayURLs ?? [])
                        .contains { !connectedInboxRelays.contains($0) }
                    effects.shouldReconfigureSync = effects.shouldReconfigureSync || addsRelay
                }
            case .assignmentResponse(let response):
                let respondedAt = response.respondedAt.flatMap(Self.parseSharedResponseDate)
                    ?? Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                if let updatedTask = updatedSnapshot.applyTaskAssignmentResponse(
                    taskID: response.taskID,
                    senderPublicKey: message.senderPublicKey,
                    status: response.status,
                    respondedAt: respondedAt,
                    editorPublicKey: message.senderPublicKey
                ) {
                    effects.snapshotChanged = true
                    effects.taskIDsToSynchronize.insert(updatedTask.id)
                }
            case .board(let delivery):
                let item = SharedBoardInboxItem(
                    wrapEventID: message.wrapEventID,
                    rumorEventID: message.rumorEventID,
                    sender: sharedInboxSender(for: message),
                    board: delivery,
                    receivedAt: Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                )
                if updatedSnapshot.ingestSharedBoardInboxItem(item) {
                    effects.snapshotChanged = true
                    let addsRelay = TaskifyRelayURL.normalizedList(delivery.relayURLs ?? [])
                        .contains { !connectedInboxRelays.contains($0) }
                    effects.shouldReconfigureSync = effects.shouldReconfigureSync || addsRelay
                }
            }
            return
        }

        if let reaction = NostrDirectMessageReaction(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex
        ) {
            if let cutoff = chatMessageRetention.cutoffTimestamp(),
               reaction.createdAt < cutoff {
                return
            }
            if updatedSnapshot.ingestDirectMessageReaction(reaction) {
                effects.snapshotChanged = true
            }
            return
        }

        guard let directMessage = NostrDirectMessage(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex
        ) else { return }
        if let cutoff = chatMessageRetention.cutoffTimestamp(),
           directMessage.createdAt < cutoff {
            return
        }

        // Unlike the NUT-18 payment-request path above, a Lightning-address forwarder (e.g.
        // solife.me) has no request on this device to match a payload against — it just drops a
        // token (or a bare {mint, proofs} payload, no "id") in DMs whenever someone pays the
        // address. Detecting it here, alongside the message itself landing in chat, lets the
        // wallet claim it automatically instead of requiring a tap on the chat bubble's payment
        // card. This is a superset of the strict path above, so a message can safely match both —
        // whichever pipeline runs first claims it; the mint's double-spend protection makes the
        // second attempt a harmless no-op.
        if directMessage.isIncoming,
           let token = CashuPaymentRequestContract.extractReceivableToken(from: directMessage.content) {
            do {
                let inboxURL = try CashuIncomingTokenInboxStore.defaultURL()
                let delivery = CashuIncomingTokenDelivery(
                    eventID: decrypted.wrapEventID,
                    token: token,
                    senderPublicKey: rumor.publicKey,
                    receivedAt: Date(timeIntervalSince1970: TimeInterval(rumor.createdAt))
                )
                if try CashuIncomingTokenInboxStore.enqueue(delivery, at: inboxURL) {
                    effects.walletDeliveryQueued = true
                }
            } catch {
                effects.walletDeliveryFailed = true
            }
        }

        if updatedSnapshot.ingestDirectMessage(directMessage) {
            effects.snapshotChanged = true
            if directMessage.isIncoming {
                recordDMPushCategory(
                    forIncomingContent: directMessage.content
                )
            }
        }
    }

    private func recordDMPushCategory(forIncomingContent content: String) {
        guard isHandlingDMPushWake else { return }
        pendingDMPushCategories.insert(
            DMPushNotificationPolicy.category(forIncomingContent: content)
        )
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
        Task { [weak self] in
            do {
                guard let self,
                      let identity = try self.identityStore.load(),
                      let recipientPublicKey = try? Data(hex: item.sender.publicKey) else { return }
                guard let deliveryPlan = await self.nip17DeliveryPlan(
                    recipientPublicKey: item.sender.publicKey,
                    discoveryRelayURLs: responseRelayURLs,
                    identity: identity
                ) else { throw NostrDirectMessageError.noRelays }
                try await self.publishNIP17Envelope(
                    envelope,
                    recipientPublicKey: recipientPublicKey,
                    deliveryPlan: deliveryPlan,
                    identity: identity,
                    recordIDBase: "assignment-response:\(sourceTaskID):\(item.sender.publicKey)"
                )
            } catch {
                self?.errorMessage = "Your response is saved, but Taskify could not queue its delivery yet."
            }
        }
    }

    private func applySyncReport(_ report: TaskSyncReport) {
        // Status reports arrive frequently during initial sync; skip writes when nothing
        // changed so observation doesn't invalidate views for identical values.
        syncState = report.state
        if relayStatuses != report.relays {
            relayStatuses = report.relays
        }
        if pendingSyncChangeCount != report.queuedChangeCount {
            pendingSyncChangeCount = report.queuedChangeCount
        }

        let onlineCount = report.relays.filter { $0.phase == .online }.count
        let activeCount = report.relays.filter {
            $0.phase == .online || $0.phase == .syncing
        }.count
        let relaySummary = report.relays.isEmpty
            ? "No relays configured"
            : "\(onlineCount) of \(report.relays.count) relays synced"

        let newStatus: String
        let newDetail: String
        switch report.state {
        case .stopped:
            newStatus = "Stopped"
            newDetail = relaySummary
        case .connecting:
            newStatus = report.queuedChangeCount > 0
                ? "Connecting • \(report.queuedChangeCount) queued"
                : "Connecting"
            newDetail = activeCount > 0
                ? "\(activeCount) of \(report.relays.count) relays responding"
                : "Contacting \(report.relays.count) relays"
        case .online:
            newStatus = report.queuedChangeCount > 0
                ? "Syncing \(report.queuedChangeCount) change\(report.queuedChangeCount == 1 ? "" : "s")"
                : "Synced"
            newDetail = relaySummary
        case .offline(let message):
            newStatus = report.queuedChangeCount > 0
                ? "Offline • \(report.queuedChangeCount) queued"
                : "Offline"
            newDetail = message
        }
        if syncStatus != newStatus { syncStatus = newStatus }
        if syncDetail != newDetail { syncDetail = newDetail }
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

    private func synchronizeTaskifyEvents(_ eventIDs: [String]) {
        let requestedIDs = Set(eventIDs)
        guard !requestedIDs.isEmpty else { return }
        let eventsByBoard = Dictionary(grouping: (snapshot.taskifyEvents ?? []).filter {
            requestedIDs.contains($0.id) && $0.boardID != nil
        }) { $0.boardID! }

        var batches: [(board: Board, pairs: [TaskifyCalendarEventPair], boardTimestamp: Int)] = []
        do {
            for (boardID, events) in eventsByBoard {
                guard let board = snapshot.boards.first(where: { $0.id == boardID }) else { continue }
                let boardTimestamp = nextNostrTimestamp()
                var pairs: [TaskifyCalendarEventPair] = []
                for event in events {
                    let pair = try TaskifyCalendarEventCodec.eventPair(
                        event: event,
                        board: board,
                        createdAt: nextNostrTimestamp()
                    )
                    _ = snapshot.upsertTaskifyEvent(pair.normalizedEvent)
                    pairs.append(pair)
                }
                batches.append((board, pairs, boardTimestamp))
            }
        } catch {
            errorMessage = "Taskify could not prepare these events for Nostr sync."
            scheduleSave()
            return
        }
        scheduleSave()
        Task { [syncEngine] in
            do {
                for batch in batches {
                    let boardEvent = try TaskEventCodec.boardEvent(
                        board: batch.board,
                        createdAt: batch.boardTimestamp
                    )
                    try await syncEngine.publish(boardEvent, board: batch.board, taskID: "_board")
                    for pair in batch.pairs {
                        try await syncEngine.publish(
                            pair.canonical,
                            board: batch.board,
                            taskID: "event:\(pair.normalizedEvent.id):canonical"
                        )
                        try await syncEngine.publish(
                            pair.view,
                            board: batch.board,
                            taskID: "event:\(pair.normalizedEvent.id):view"
                        )
                    }
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = "Taskify could not queue these events for Nostr sync."
                }
            }
        }
    }

    /// Publishes tombstones to every source board before publishing newer versions to the target
    /// board. The target timestamps are deliberately allocated last so relay replay and clients
    /// that merge Taskify events globally by ID always prefer the moved event over its tombstone.
    private func synchronizeTaskifyEventMove(
        sourceEvents: [TaskifyEvent],
        targetEventIDs: [String]
    ) {
        typealias Batch = (
            board: Board,
            pairs: [TaskifyCalendarEventPair],
            boardTimestamp: Int
        )
        let requestedTargetIDs = Set(targetEventIDs)
        guard !sourceEvents.isEmpty, !requestedTargetIDs.isEmpty else {
            synchronizeTaskifyEvents(targetEventIDs)
            return
        }

        var sourceBatches: [Batch] = []
        var targetBatches: [Batch] = []
        do {
            let sourceByBoard = Dictionary(grouping: sourceEvents.compactMap {
                event -> TaskifyEvent? in
                guard event.boardID != nil else { return nil }
                var tombstone = event
                tombstone.deleted = true
                tombstone.lastEditedBy = identityPublicKey.nilIfEmpty ?? tombstone.lastEditedBy
                return tombstone
            }) { $0.boardID! }
            for (boardID, events) in sourceByBoard {
                guard let board = snapshot.boards.first(where: { $0.id == boardID }) else { continue }
                let boardTimestamp = nextNostrTimestamp()
                let pairs = try events.map {
                    try TaskifyCalendarEventCodec.eventPair(
                        event: $0,
                        board: board,
                        createdAt: nextNostrTimestamp()
                    )
                }
                sourceBatches.append((board, pairs, boardTimestamp))
            }

            let targetByBoard = Dictionary(grouping: (snapshot.taskifyEvents ?? []).filter {
                requestedTargetIDs.contains($0.id) && $0.boardID != nil
            }) { $0.boardID! }
            for (boardID, events) in targetByBoard {
                guard let board = snapshot.boards.first(where: { $0.id == boardID }) else { continue }
                let boardTimestamp = nextNostrTimestamp()
                var pairs: [TaskifyCalendarEventPair] = []
                for event in events {
                    let pair = try TaskifyCalendarEventCodec.eventPair(
                        event: event,
                        board: board,
                        createdAt: nextNostrTimestamp()
                    )
                    _ = snapshot.upsertTaskifyEvent(pair.normalizedEvent)
                    pairs.append(pair)
                }
                targetBatches.append((board, pairs, boardTimestamp))
            }
        } catch {
            errorMessage = "Taskify could not prepare this event move for Nostr sync."
            scheduleSave()
            return
        }

        scheduleSave()
        let batches = sourceBatches + targetBatches
        Task { [syncEngine] in
            do {
                for batch in batches {
                    let boardEvent = try TaskEventCodec.boardEvent(
                        board: batch.board,
                        createdAt: batch.boardTimestamp
                    )
                    try await syncEngine.publish(boardEvent, board: batch.board, taskID: "_board")
                    for pair in batch.pairs {
                        try await syncEngine.publish(
                            pair.canonical,
                            board: batch.board,
                            taskID: "event:\(pair.normalizedEvent.id):canonical"
                        )
                        try await syncEngine.publish(
                            pair.view,
                            board: batch.board,
                            taskID: "event:\(pair.normalizedEvent.id):view"
                        )
                    }
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = "Taskify could not queue this event move for Nostr sync."
                }
            }
        }
    }

    private func maintainTaskifyEventRecurrenceWindow(now: Date = Date()) {
        // Same `didSet` trap as `reconcileFastingReminders`: mutate a copy, write back only
        // when the recurrence window actually moved.
        var updated = snapshot
        let changes = updated.ensureTaskifyEventRecurrenceWindow(now: now)
        if updated != snapshot {
            snapshot = updated
        }
        guard !changes.allEventIDs.isEmpty else { return }
        synchronizeTaskifyEvents(changes.allEventIDs)
        refreshNotifications(requestPermission: false)
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

    /// Direct messages are chronological conversation events, not last-write-wins state. The
    /// app-wide Nostr clock may be ahead of wall time after processing remote board/task events;
    /// using it here can make a later reply from another device sort before the message it
    /// answers. Use the actual send time and let the stable message ordering preserve events
    /// that share Nostr's one-second timestamp resolution.
    private func currentDirectMessageTimestamp() -> Int {
        Int(Date().timeIntervalSince1970)
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [store, weak self] in
            // Debounce before snapshotting: initial sync calls this once per merged event,
            // and encoding the full snapshot each time is wasted work. Sleeping first (and
            // reading `snapshot` only after) collapses a burst into one save of the final state.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self else { return }
            let snapshotToSave = self.snapshot
            do {
                try await store.save(snapshotToSave)
                await MainActor.run {
                    self.lastStoreWriteAt = Date()
                    WidgetCenter.shared.reloadAllTimelines()
                }
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
            lastStoreWriteAt = Date()
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            errorMessage = "Taskify could not save the latest change."
        }
    }

    private var accountBackupRelayURLs: [String] {
        guard let baseline = accountBackupBaseline else { return [] }
        return baseline.defaultRelayURLs.isEmpty
            ? appRelays
            : baseline.defaultRelayURLs
    }

    private var nip17DiscoveryRelayURLs: [String] {
        TaskifyRelayURL.normalizedList(
            appRelays + snapshot.boards.flatMap(\.effectiveRelayURLs)
        )
    }

    /// Only the account's verified or successfully queued kind-10050 relay set may receive its
    /// `#p` subscription. Startup briefly runs without a DM subscription while that list is
    /// discovered or bootstrapped instead of leaking the account's inbox interest to fallbacks.
    private var effectiveNIP17InboxRelayURLs: [String] {
        nip17InboxRelayURLs
    }

    /// Existing Taskify users predate the native kind-10050 publisher. Preserve their configured
    /// relay choice, but only bootstrap a preference when the account has no signed list already;
    /// never overwrite another NIP-17 client's valid preference during startup.
    private func ensureNIP17InboxRelayPreference() async {
        guard let identity = cachedIdentity else { return }
        let advertised = await NIP17InboxRelayResolver.resolveAdvertised(
            recipientPublicKey: identity.publicKeyHex,
            discoveryRelayURLs: nip17DiscoveryRelayURLs
        )
        if !advertised.isEmpty {
            guard advertised != nip17InboxRelayURLs else { return }
            nip17InboxRelayURLs = advertised
            reconfigureSync()
            return
        }

        do {
            try await updateNIP17InboxRelayPreference(appRelays, identity: identity)
        } catch {
            #if DEBUG
            print("Taskify could not publish its NIP-17 inbox preference: \(error.localizedDescription)")
            #endif
        }
    }

    /// Single mutation point for inbox preferences, including the DM-push toggle. APNs device
    /// registration remains an authenticated HTTPS concern; only standard relay URLs are
    /// published to Nostr.
    func updateNIP17InboxRelayPreference(_ relayURLs: [String]) async throws {
        guard let identity = try identityStore.load() else {
            throw NostrDirectMessageError.identityUnavailable
        }
        try await updateNIP17InboxRelayPreference(relayURLs, identity: identity)
    }

    private func updateNIP17InboxRelayPreference(
        _ relayURLs: [String],
        identity: NostrIdentity
    ) async throws {
        let inboxRelays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !inboxRelays.isEmpty else { throw NostrDirectMessageError.noRelays }
        let publicationRelays = TaskifyRelayURL.normalizedList(
            nip17DiscoveryRelayURLs + nip17InboxRelayURLs + inboxRelays
        )
        let event = try NIP17InboxRelayPreference.event(
            identity: identity,
            relayURLs: inboxRelays,
            createdAt: nextNostrTimestamp()
        )
        try await syncEngine.publish(
            event,
            relayURLs: publicationRelays,
            outboxScope: Self.nip17PreferencesOutboxScope,
            recordID: "kind-10050"
        )
        nip17InboxRelayURLs = inboxRelays
        reconfigureSync()
    }

    private func nip17DeliveryPlan(
        recipientPublicKey: String,
        discoveryRelayURLs: [String],
        identity: NostrIdentity
    ) async -> NIP17DeliveryPlan? {
        guard recipientPublicKey.lowercased() != identity.publicKeyHex else { return nil }
        async let recipientRelays = NIP17InboxRelayResolver.resolve(
            recipientPublicKey: recipientPublicKey,
            discoveryRelayURLs: discoveryRelayURLs
        )
        if nip17InboxRelayURLs.isEmpty {
            await ensureNIP17InboxRelayPreference()
        }
        return NIP17RelayRouting.deliveryPlan(
            recipientInboxRelayURLs: await recipientRelays,
            senderInboxRelayURLs: effectiveNIP17InboxRelayURLs
        )
    }

    @discardableResult
    private func publishNIP17Envelope(
        _ envelope: TaskifyShareEnvelope,
        recipientPublicKey: Data,
        deliveryPlan: NIP17DeliveryPlan,
        identity: NostrIdentity,
        recordIDBase: String? = nil
    ) async throws -> NIP17GiftWrapPair {
        let pair = try NIP17GiftWrap.wrapPair(
            envelope: envelope,
            sender: identity,
            recipientPublicKey: recipientPublicKey,
            createdAt: nextNostrTimestamp()
        )
        let base = recordIDBase ?? pair.rumor.id
        let allDeliveryRelays = TaskifyRelayURL.normalizedList(
            deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs
        )
        await syncEngine.configure(
            boards: snapshot.boardsForSync,
            auxiliaryRelayURLs: allDeliveryRelays,
            inboxPublicKey: identity.publicKeyHex,
            inboxRelayURLs: deliveryPlan.senderRelayURLs
        )
        try await syncEngine.publish(
            pair.senderWrap,
            relayURLs: deliveryPlan.senderRelayURLs,
            outboxScope: Self.sharedInboxOutboxScope,
            recordID: "\(base):sender"
        )
        try await syncEngine.publish(
            pair.recipientWrap,
            relayURLs: deliveryPlan.recipientRelayURLs,
            outboxScope: Self.sharedInboxOutboxScope,
            recordID: "\(base):recipient"
        )
        return pair
    }

    /// Relays used for everything that is not board sync: the shared inbox, direct messages,
    /// shared tasks and invites. Rooted on the app relay set, plus whatever relays the people
    /// and shares involved have told us to use.
    private var sharedInboxRelayURLs: [String] {
        TaskifyRelayURL.normalizedList(
            appRelays
                + nip17InboxRelayURLs
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
            appRelays
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
        let decodedList: NIP51ContactList? = await Task.detached(priority: .utility) {
            () -> NIP51ContactList? in
            for event in candidates {
                if let list = try? NIP51ContactListContract.decode(
                    event: event,
                    identity: identity
                ) {
                    return list
                }
            }
            return nil
        }.value
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
            inboxPublicKey: identity.publicKeyHex,
            inboxRelayURLs: effectiveNIP17InboxRelayURLs
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
        updatedPayload.settings[TaskifyMediaServerSettings.selectedServerPWAKey] = .string(
            encryptedMediaServerURL
        )
        updatedPayload.settings[TaskifyMediaServerSettings.serverListPWAKey] = .string(
            TaskifyFileServerList.serialize(encryptedFileServers)
        )
        updatedPayload.settings[ChatHistorySettings.pwaSettingsKey] = .string(
            chatMessageRetention.rawValue
        )
        updatedPayload.settings[WalletCurrencySettings.conversionEnabledPWAKey] = .boolean(
            walletConversionEnabled
        )
        updatedPayload.settings[WalletCurrencySettings.primaryCurrencyPWAKey] = .string(
            walletPrimaryCurrency.rawValue
        )
        updatedPayload.settings[WalletCurrencySettings.denominationDisplayPWAKey] = .string(
            walletDenominationDisplay.rawValue
        )
        let relayURLs = updatedPayload.defaultRelayURLs.isEmpty
            ? appRelays
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
                inboxPublicKey: identity.publicKeyHex,
                inboxRelayURLs: effectiveNIP17InboxRelayURLs
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
            accountBackupMessage = "Native board changes are queued in your encrypted account sync."
            accountBackupPublishPending = false
        } catch {
            accountBackupMessage = "Taskify could not queue the encrypted account backup update."
        }
    }

    private func applySyncedSettings(from payload: NostrAppBackupPayload) {
        // Applied before the selected-server value below, since selectServer only accepts a URL
        // that's already present in the list.
        if case .string(let value)? = payload.settings[TaskifyMediaServerSettings.serverListPWAKey] {
            encryptedFileServers = TaskifyMediaServerSettings.applyServerList(value)
        }
        if case .string(let value)? = payload.settings[TaskifyMediaServerSettings.selectedServerPWAKey],
           let normalized = TaskifyMediaServerSettings.selectServer(value) {
            encryptedMediaServerURL = normalized
        } else {
            encryptedMediaServerURL = TaskifyMediaServerSettings.configuredServer
        }
        if case .string(let value)? = payload.settings[ChatHistorySettings.pwaSettingsKey],
           let retention = ChatMessageRetention(rawValue: value) {
            ChatHistorySettings.setRetention(retention)
            chatMessageRetention = retention
            if let cutoff = retention.cutoffTimestamp(),
               snapshot.pruneDirectMessageHistory(olderThan: cutoff).changed {
                scheduleSave()
            }
        }
        if case .boolean(let enabled)? = payload.settings[WalletCurrencySettings.conversionEnabledPWAKey] {
            WalletCurrencySettings.setConversionEnabled(enabled)
            walletConversionEnabled = enabled
        }
        if case .string(let value)? = payload.settings[WalletCurrencySettings.primaryCurrencyPWAKey],
           let currency = WalletPrimaryCurrency(rawValue: value) {
            WalletCurrencySettings.setPrimaryCurrency(currency)
        }
        walletPrimaryCurrency = WalletCurrencySettings.primaryCurrency
        if case .string(let value)? = payload.settings[WalletCurrencySettings.denominationDisplayPWAKey],
           let display = WalletDenominationDisplay(rawValue: value) {
            WalletCurrencySettings.setDenominationDisplay(display)
            walletDenominationDisplay = display
        }
    }

    private func refreshNotifications(requestPermission: Bool) {
        notificationTask?.cancel()
        notificationTask = Task { [notificationCoordinator, weak self] in
            // Debounce: this is called once per merged task during initial sync, and a
            // full UNUserNotificationCenter reschedule per event is expensive. The sleep
            // lets the cancel-and-respawn above collapse a burst into one reschedule.
            // Permission requests skip the delay so the system prompt isn't lagged.
            if !requestPermission {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
            }
            // Read the snapshot *after* the debounce, the same way `scheduleSave` does. Reading
            // it up front meant every merged event paid for `acceptedTaskifyEvents` — a filter
            // and sort of the whole event array — on the main actor, only for the surrounding
            // task to be cancelled a moment later and the result thrown away. Going through the
            // model's accessor also shares the lookup cache's copy instead of rebuilding it.
            guard let self else { return }
            let tasks = self.snapshot.tasks
            let events = self.taskifyEvents
            let status = await notificationCoordinator.reschedule(
                tasks: tasks,
                events: events,
                requestPermission: requestPermission
            )
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self.notificationStatus = status
            }
        }
    }

    private func refreshNotificationsImmediately() async {
        notificationTask?.cancel()
        notificationTask = nil
        notificationStatus = await notificationCoordinator.reschedule(
            tasks: snapshot.tasks,
            events: taskifyEvents,
            requestPermission: false
        )
    }

    private static func normalizedTaskifyEventReminders(
        _ reminders: [TaskReminder],
        isAllDay: Bool
    ) -> [TaskReminder] {
        var seenMinutes = Set<Int>()
        return reminders.compactMap { reminder in
            guard let minutes = reminder.minutesBefore,
                  seenMinutes.insert(minutes).inserted else { return nil }
            return TaskReminder(minutesBefore: minutes, dateOnly: isAllDay)
        }.sorted { ($0.minutesBefore ?? 0) < ($1.minutesBefore ?? 0) }
    }

    private static func normalizedTaskifyEventReminderTime(_ value: String?) -> String {
        let parts = (value ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) }.map { min(max($0, 0), 23) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) }.map { min(max($0, 0), 59) } ?? 0
        return String(format: "%02d:%02d", hour, minute)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

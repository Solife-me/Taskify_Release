import Foundation
import Security
import SwiftUI
import TaskifyCore
import TaskifyWatchShared
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
    private struct TaskColumnKey: Hashable {
        let boardID: String
        let columnID: String
        let includeCompleted: Bool
        let minute: Int
    }

    private var boardsByID: [String: Board]?
    private var tasksByID: [String: TaskItem]?
    private var taskIDs: Set<String>?
    private var tasksByColumn: [TaskColumnKey: [TaskItem]] = [:]
    private var taskColumnMinute: Int?
    private var contactsByPublicKey: [String: NostrContact]?
    private var groupsByID: [String: NostrGroupConversation]?
    private var cachedVisibleBoards: [Board]?

    func invalidate() {
        boardsByID = nil
        tasksByID = nil
        taskIDs = nil
        tasksByColumn.removeAll(keepingCapacity: true)
        taskColumnMinute = nil
        contactsByPublicKey = nil
        groupsByID = nil
        cachedVisibleBoards = nil
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
        if tasksByID == nil {
            tasksByID = Dictionary(
                snapshot.tasks
                    .filter { !$0.isDeleted }
                    .map { ($0.id, $0) },
                uniquingKeysWith: { _, newest in newest }
            )
        }
        return tasksByID?[id]
    }

    func activeTaskIDs(snapshot: TaskifySnapshot) -> Set<String> {
        if let taskIDs { return taskIDs }
        let values = Set(snapshot.tasks.lazy.filter { !$0.isDeleted }.map(\.id))
        taskIDs = values
        return values
    }

    func tasks(
        boardID: String,
        columnID: String,
        includeCompleted: Bool,
        snapshot: TaskifySnapshot,
        now: Date = Date()
    ) -> [TaskItem] {
        let minute = Int(now.timeIntervalSince1970 / 60)
        if taskColumnMinute != minute {
            tasksByColumn.removeAll(keepingCapacity: true)
            taskColumnMinute = minute
        }
        let key = TaskColumnKey(
            boardID: boardID,
            columnID: columnID,
            includeCompleted: includeCompleted,
            minute: minute
        )
        if let cached = tasksByColumn[key] { return cached }
        let values = snapshot.tasks(
            boardID: boardID,
            columnID: columnID,
            includeCompleted: includeCompleted,
            now: now
        )
        tasksByColumn[key] = values
        return values
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
    private(set) var snapshot = TaskifySnapshot.empty {
        didSet {
            snapshotLookupCache.invalidate()
            snapshotRevision &+= 1
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
    private(set) var chatMessageRetention = ChatHistorySettings.retention
    private(set) var walletConversionEnabled = WalletCurrencySettings.conversionEnabled
    private(set) var walletPrimaryCurrency = WalletCurrencySettings.primaryCurrency
    private(set) var walletDenominationDisplay = WalletCurrencySettings.denominationDisplay
    private(set) var startupTab = StartupViewSettings.tab
    private(set) var startupBoardIDsByWeekday = StartupViewSettings.boardIDsByWeekday
    private(set) var appRelays = AppRelaySettings.urls
    private(set) var isCheckingAccountBackup = false
    private(set) var isRefreshingContacts = false
    private(set) var contactSyncStatus = "Preparing private contact sync"
    private(set) var accountBackupMessage: String?
    private(set) var taskifyEventRSVPsByEventID: [String: [TaskifyEventRSVPResponse]] = [:]
    private(set) var refreshingTaskifyEventRSVPIDs: Set<String> = []
    private(set) var unavailableTaskifyEventRSVPIDs: Set<String> = []
    var pendingAccountBackup: NostrAppBackupPayload?
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
    @ObservationIgnored private var pendingSharedInboxEvents: [NostrEvent] = []
    @ObservationIgnored private var accountBackupBaseline: NostrAppBackupPayload?
    @ObservationIgnored private var managedAccountBackupBoardIDs: Set<String> = []
    @ObservationIgnored private var lastAccountBackupCreatedAt = 0
    @ObservationIgnored private var lastNostrCreatedAt = 0
    @ObservationIgnored private var accountBackupPublishPending = false
    @ObservationIgnored private var syncState: TaskSyncState = .connecting
    @ObservationIgnored private var lastContactRefreshAt: Date?
    @ObservationIgnored private var walletPaymentDeliveryHandler: (() -> Void)?
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
    var taskifyEvents: [TaskifyEvent] { snapshot.acceptedTaskifyEvents }
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
        snapshot.tasks.filter { $0.boardID == boardID && !$0.isDeleted }.count
    }

    func completedTaskCount(forBoardID boardID: String) -> Int {
        let scopeIDs: Set<String>
        if let board = board(withID: boardID), board.kind == .compound {
            scopeIDs = Set(compoundChildBoards(for: boardID).map(\.id))
        } else {
            scopeIDs = [boardID]
        }
        return snapshot.tasks.lazy.filter {
            !$0.isDeleted && $0.completed && scopeIDs.contains($0.boardID)
        }.count
    }

    func tasks(for weekday: WeekdayColumn, includeCompleted: Bool) -> [TaskItem] {
        guard let boardID = selectedBoard?.id else { return [] }
        return snapshotLookupCache.tasks(
            boardID: boardID,
            columnID: weekday.rawValue,
            includeCompleted: includeCompleted,
            snapshot: snapshot
        )
    }

    func tasks(forColumnID columnID: String, includeCompleted: Bool) -> [TaskItem] {
        guard let boardID = selectedBoard?.id else { return [] }
        return snapshotLookupCache.tasks(
            boardID: boardID,
            columnID: columnID,
            includeCompleted: includeCompleted,
            snapshot: snapshot
        )
    }

    func tasks(boardID: String, columnID: String, includeCompleted: Bool) -> [TaskItem] {
        snapshotLookupCache.tasks(
            boardID: boardID,
            columnID: columnID,
            includeCompleted: includeCompleted,
            snapshot: snapshot
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
            newTaskPosition: newTaskPosition
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
            newTaskPosition: newTaskPosition
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
            newTaskPosition: newTaskPosition
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
            newTaskPosition: newTaskPosition
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
                newTaskPosition: newTaskPosition
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
                    editorPublicKey: identityPublicKey.nilIfEmpty
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
        synchronizeTask(taskID)
        snapshot.tasks
            .map(\.id)
            .filter { !existingIDs.contains($0) }
            .forEach { synchronizeTask($0) }
        refreshNotifications(requestPermission: false)
        reconcileScriptureMemory()
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
        let isOnline = syncIsOnline
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

        Task { [identityStore, syncEngine, weak self] in
            guard let identity = try? identityStore.load() else { return }
            var failed = false
            for target in targets {
                do {
                    let deliveryRelays = isOnline
                        ? await NIP17InboxRelayResolver.resolve(
                            recipientPublicKey: target.recipient.hexString,
                            fallbackRelayURLs: target.fallbackRelays
                        )
                        : target.fallbackRelays
                    guard !deliveryRelays.isEmpty else {
                        failed = true
                        continue
                    }
                    let envelope = TaskifyShareEnvelope(
                        item: .calendarEvent(target.delivery),
                        senderNpub: identity.npub
                    )
                    let wrap = try NIP17GiftWrap.wrap(
                        envelope: envelope,
                        sender: identity,
                        recipientPublicKey: target.recipient
                    )
                    try await syncEngine.publish(
                        wrap,
                        relayURLs: deliveryRelays,
                        outboxScope: Self.sharedInboxOutboxScope,
                        recordID: "calendar-invite:\(eventID):\(target.recipient.hexString)"
                    )
                } catch {
                    failed = true
                }
            }
            if failed {
                await MainActor.run {
                    self?.errorMessage = "The event was saved, but Taskify could not queue every invitation yet."
                }
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
        let deliveryRelays = syncIsOnline
            ? await NIP17InboxRelayResolver.resolve(
                recipientPublicKey: recipientPublicKey.hexString,
                fallbackRelayURLs: fallbackRelays
            )
            : fallbackRelays
        guard !deliveryRelays.isEmpty else { throw StructuredShareSendError.noRelays }

        let delivery = SharedBoardDelivery(
            boardID: boardID,
            boardName: boardName,
            relayURLs: TaskifyRelayURL.normalizedList(relayURLs + deliveryRelays)
        )
        let envelope = TaskifyShareEnvelope(
            item: .board(delivery),
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
            recordID: "board-share:\(event.id)"
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

        let calendar = weekCalendar
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
            let nowWeekStart = WeekDateResolver.startOfWeek(
                containing: now,
                startingOn: weekStart,
                calendar: calendar
            )
            let dueWeekStart = WeekDateResolver.startOfWeek(
                containing: dueDate,
                startingOn: weekStart,
                calendar: calendar
            )
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
        applyPWASettings(from: payload)
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
                let review = NostrAppBackupReview(
                    payload: decodedPayload,
                    currentBoards: snapshot.boards
                )
                if automaticallyActivateWhenAlreadyConnected,
                   review.importableBoardCount == 0 {
                    accountBackupBaseline = decodedPayload
                    managedAccountBackupBoardIDs = decodedPayload.nativeManagedNostrBoardIDs
                    applyPWASettings(from: decodedPayload)
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
        // Before the first read: if the App Group capability has just been enabled, bring the
        // existing store into the shared container so enabling it doesn't look like data loss.
        // No-ops once migrated, and when the capability isn't in effect.
        TaskifySharedContainer.migrateIfNeeded()
        var loadedIdentity: NostrIdentity?
        do {
            let hadExistingIdentity = (try? identityStore.load()) != nil
            OnboardingSettings.determineEligibilityIfNeeded(hadExistingIdentity: hadExistingIdentity)
            showsFirstRunOnboarding = !OnboardingSettings.completed
            let identity = try identityStore.loadOrCreate()
            loadedIdentity = identity
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
        applyChatUITestFixtureIfRequested()
        applyBoardUITestFixtureIfRequested()
        applyPerformanceUITestFixtureIfRequested()
#endif
        applyStartupBoardPreference()
        refreshNotifications(requestPermission: false)
        reconcileFastingReminders()
        reconcileScriptureMemory()
        startSync()
        maintainTaskifyEventRecurrenceWindow()
        refreshContacts()
        if let loadedIdentity {
            findPWAAccountBackup(
                identity: loadedIdentity,
                automaticallyActivateWhenAlreadyConnected: true
            )
        }
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
    private func applyBoardUITestFixtureIfRequested() {
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_BOARD_FIXTURE"] == "1" else {
            return
        }
        let board = Board.week(name: "UI Test Board")
        snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [],
            selectedBoardID: board.id
        )
        errorMessage = nil
    }

    private func applyPerformanceUITestFixtureIfRequested() {
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_PERFORMANCE_FIXTURE"] == "1" else {
            return
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
    }

    private func applyChatUITestFixtureIfRequested() {
        guard ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_FIXTURE"] == "1" else {
            return
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
        snapshot.directMessages = (1...40).map { index in
            let content: String
            switch index {
            case 2:
                content = "Searchable early fixture needle"
            case 8, 20, 32:
                content = "Repeatable fixture match \(index)"
            case 40:
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
                isIncoming: incoming
            )
        }
        snapshot.directMessageReadAt = [:]
        snapshot.directMessageArchivedAt = [:]
        snapshot.directMessageDeletedEventIDs = [:]
        errorMessage = nil
    }
#endif

    private func applyIdentity(_ identity: NostrIdentity) {
        cachedIdentity = identity
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
            applySyncBatch(tasks: taskRecords, calendarEvents: calendarRecords)
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
    private func applySyncBatch(
        tasks taskRecords: [TaskRelayRecord],
        calendarEvents calendarRecords: [TaskifyCalendarRelayRecord]
    ) {
        for record in taskRecords {
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
        }
        for record in calendarRecords {
            lastNostrCreatedAt = max(lastNostrCreatedAt, record.eventCreatedAt)
        }

        var updated = snapshot
        let tasksChanged = updated.mergeRemoteTasks(
            taskRecords.map { (task: $0.task, eventCreatedAt: $0.eventCreatedAt) }
        )
        var calendarChanged = false
        for record in calendarRecords {
            if updated.mergeRemoteTaskifyEvent(record.event, eventCreatedAt: record.eventCreatedAt) {
                calendarChanged = true
            }
        }
        guard tasksChanged || calendarChanged else { return }
        snapshot = updated
        scheduleSave()
        if calendarChanged {
            maintainTaskifyEventRecurrenceWindow()
        }
        if tasksChanged || calendarChanged {
            refreshNotifications(requestPermission: false)
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
                if effects.walletDeliveryQueued {
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
            if updatedSnapshot.upsertGroupConversation(group) {
                effects.snapshotChanged = true
            }
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

    /// Relays used for everything that is not board sync: the shared inbox, direct messages,
    /// shared tasks and invites. Rooted on the app relay set, plus whatever relays the people
    /// and shares involved have told us to use.
    private var sharedInboxRelayURLs: [String] {
        TaskifyRelayURL.normalizedList(
            appRelays
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

    private func applyPWASettings(from payload: NostrAppBackupPayload) {
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
        let tasks = snapshot.tasks
        let events = snapshot.acceptedTaskifyEvents
        notificationTask?.cancel()
        notificationTask = Task { [notificationCoordinator] in
            // Debounce: this is called once per merged task during initial sync, and a
            // full UNUserNotificationCenter reschedule per event is expensive. The sleep
            // lets the cancel-and-respawn above collapse a burst into one reschedule.
            // Permission requests skip the delay so the system prompt isn't lagged.
            if !requestPermission {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
            }
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
            events: snapshot.acceptedTaskifyEvents,
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

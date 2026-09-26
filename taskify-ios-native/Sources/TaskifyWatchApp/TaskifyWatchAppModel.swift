import Foundation
import Observation
import OSLog
import Security
import TaskifyWatchShared
import WatchConnectivity
import WidgetKit

enum TaskifyWatchKeychainError: LocalizedError {
    case passcodeRequired
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .passcodeRequired:
            "Set a passcode on this Apple Watch before enabling independent sync."
        case .keychain(let status):
            "The Nostr identity could not be stored securely (\(status))."
        }
    }
}

enum TaskifyWatchDictationError: LocalizedError {
    case phoneUnavailable
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .phoneUnavailable:
            "Connect this Watch to the internet or open Taskify on your iPhone."
        case .invalidResponse:
            "Taskify couldn't interpret that. Try saying it another way."
        }
    }
}

private struct TaskifyWatchDirectMutation {
    let event: TaskifyWatchNostrEvent
    let task: TaskifyWatchTask?
    let relayURLs: [String]
    let boardNostrID: String
}

private struct TaskifyWatchBoardRelayPayload: Decodable {
    let name: String?
    let kind: String?
    let columns: [TaskifyWatchBoardColumn]?
}

struct TaskifyWatchChatWakeResult: Equatable {
    let receivedData: Bool
    let shouldNotify: Bool
    let failed: Bool
}

/// Stores the Nostr private key only in the Watch's system Keychain. This protection class does
/// not sync, is not backed up, is unavailable while locked, and is destroyed if the Watch
/// passcode is removed.
struct TaskifyWatchIdentityStore {
    private let service = "solife.me.Taskify.Native.watchkitapp"
    private let account = "nostr-identity-private-key-v1"

    func save(_ privateKey: Data) throws {
        guard privateKey.count == 32 else {
            throw TaskifyWatchTransfer.TransferError.invalidPrivateKey
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: privateKey,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw map(updateStatus)
        }

        var item = query
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw map(addStatus) }
    }

    func containsIdentity() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    func load() throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, data.count == 32 else {
            throw map(status)
        }
        return data
    }

    private func map(_ status: OSStatus) -> TaskifyWatchKeychainError {
        if status == errSecAuthFailed || status == errSecInteractionNotAllowed {
            return .passcodeRequired
        }
        return .keychain(status)
    }
}

@Observable
@MainActor
final class TaskifyWatchAppModel: NSObject {
    private(set) var snapshot = TaskifyWatchSnapshot() {
        didSet {
            if snapshot.tasks != oldValue.tasks || snapshot.boards != oldValue.boards { cachedTaskIndex = nil }
        }
    }
    private(set) var isProvisioned = false
    private(set) var statusMessage = "Open Taskify on your iPhone to authorize this Watch."
    private(set) var pendingCompletionIDs: Set<String> = [] {
        didSet { if pendingCompletionIDs != oldValue { cachedTaskIndex = nil } }
    }
    private(set) var activeQuickAddBoardID: String?
    private(set) var chatSnapshot = TaskifyWatchChatSnapshot() {
        didSet { if chatSnapshot != oldValue { cachedChatIndex = nil } }
    }
    private(set) var avatarRefreshRevision = 0
    private(set) var viewClock = Date()
    @ObservationIgnored private var cachedChatIndex: TaskifyWatchChatIndex?
    @ObservationIgnored private var cachedTaskIndex: TaskifyWatchTaskIndex?
    private(set) var chatStatusMessage = "Chat is ready"
    private(set) var isRefreshingChat = false

    @ObservationIgnored private let identityStore = TaskifyWatchIdentityStore()
    @ObservationIgnored private let cacheURL: URL
    @ObservationIgnored private let commandCacheURL: URL
    @ObservationIgnored private let profileCacheURL: URL
    @ObservationIgnored private let chatContextCacheURL: URL
    @ObservationIgnored private let chatCoordinator: TaskifyWatchChatCoordinator
    @ObservationIgnored private let independentClient = TaskifyWatchIndependentClient()
    @ObservationIgnored private var pendingCommands: [TaskifyWatchCommand] = []
    @ObservationIgnored private var immediateCommandIDs: Set<String> = []
    @ObservationIgnored private var directSyncCommandIDs: Set<String> = []
    @ObservationIgnored private var chatOutboxRetryTask: Task<Void, Never>?
    @ObservationIgnored private var chatRefreshWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var chatAccountRevision = 0
    @ObservationIgnored private var preparedChatAccountRevision: Int?
    private static let chatSyncLogger = Logger(subsystem: "solife.me.Taskify.Native.watchkitapp", category: "ChatBackgroundSync")
    @ObservationIgnored private var independentProfile: TaskifyWatchIndependentProfile? {
        didSet { cachedChatIndex = nil }
    }
    @ObservationIgnored private var chatContext: TaskifyWatchChatProvisioningContext?
    @ObservationIgnored private var requestedInitialSetupNavigation = false
    @ObservationIgnored private var latestPhoneSnapshotGeneratedAt = Date.distantPast
    @ObservationIgnored private var phoneSnapshotApplicationRevision = 0
    /// Highest read-through already sent to the iPhone per conversation. The phone answers a
    /// read update with a fresh snapshot, and applying that reply re-renders this model, so
    /// without this guard an unchanged position would re-send forever.
    @ObservationIgnored private var lastSentChatReadThrough: [String: Int] = [:]
    /// On-demand chat directory sync bookkeeping. Display metadata (contact names, avatars,
    /// group titles, tombstones) arrives only when the Watch asks for it, so a pending flag
    /// retries once reachability returns and a timestamp bounds repeat requests.
    @ObservationIgnored private var needsChatDirectorySync = false
    @ObservationIgnored private var lastChatDirectoryRequestAt: Date?

    private static let chatDirectoryRequestInterval: TimeInterval = 12 * 60 * 60

    override init() {
        let supportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        cacheURL = supportURL.appendingPathComponent("taskify-watch-snapshot-v1.json")
        commandCacheURL = supportURL.appendingPathComponent("taskify-watch-commands-v1.json")
        profileCacheURL = supportURL.appendingPathComponent("taskify-watch-independent-profile-v1.json")
        chatContextCacheURL = supportURL.appendingPathComponent("taskify-watch-chat-context-v1.json")
        chatCoordinator = TaskifyWatchChatCoordinator(
            fileURL: supportURL.appendingPathComponent("taskify-watch-chat-v1.json")
        )
        super.init()
        isProvisioned = identityStore.containsIdentity()
        loadIndependentProfile()
        loadChatContext()
        loadCachedSnapshot()
        loadPendingCommands()
        activateConnectivity()
        if let chatContext {
            let revision = chatAccountRevision
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let configured = try await self.chatCoordinator.configure(chatContext)
                    guard revision == self.chatAccountRevision else { return }
                    self.chatSnapshot = configured
                } catch {
                    guard revision == self.chatAccountRevision else { return }
                    self.chatSnapshot = await self.chatCoordinator.snapshot()
                }
                // Cold background launches only restore the cache. Inbox enrollment and
                // outbox retries run from foreground refresh, not alongside a push wake.
            }
        } else {
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.chatSnapshot = await self.chatCoordinator.snapshot()
            }
        }
        if isProvisioned {
            statusMessage = independentProfile == nil
                ? "Open Taskify on iPhone once to upgrade independent sync."
                : "Independent sync ready"
        }
    }

    var todayTasks: [TaskifyWatchTask] {
        _ = viewClock
        return currentTaskIndex.dayLists().today
    }

    var upcomingTasks: [TaskifyWatchTask] {
        _ = viewClock
        return currentTaskIndex.dayLists().upcoming
    }

    func tasks(for boardID: String) -> [TaskifyWatchTask] {
        currentTaskIndex.tasksByBoard[boardID] ?? []
    }

    func openTaskCount(for boardID: String) -> Int {
        currentTaskIndex.openCounts[boardID] ?? 0
    }

    var quickAddBoardID: String? {
        activeQuickAddBoardID ?? snapshot.selectedBoardID ?? snapshot.boards.first?.id
    }

    var chatThreads: [TaskifyWatchChatThread] { currentChatIndex.threads }
    var chatUnreadCount: Int { currentChatIndex.unreadCount }

    var leftChatGroups: [TaskifyWatchGroupConversation] {
        chatSnapshot.groups.filter(\.isLeft).sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    var chatIdentityPublicKey: String? { independentProfile?.publicKeyHex.lowercased() }

    var isChatConfigured: Bool { chatContext != nil }

    func restoreProtectedStateAfterUnlock() {
        // A push can cold-launch the process while protected files/Keychain are unavailable.
        // Re-read them on activation instead of keeping the empty launch-time placeholders.
        guard identityStore.containsIdentity() else { return }
        isProvisioned = true
        if independentProfile == nil { loadIndependentProfile() }
        if chatContext == nil { loadChatContext() }
    }

    func chatMessages(conversationID: String) -> [TaskifyWatchChatMessage] {
        _ = viewClock
        return currentChatIndex.messages(conversationID: conversationID)
    }

    func chatContact(publicKey: String) -> TaskifyWatchContact? {
        currentChatIndex.contacts[publicKey.lowercased()]
    }

    func chatGroupAvatarMembers(
        memberPublicKeys: [String],
        recentSenderPublicKeys: [String]
    ) -> [TaskifyWatchGroupAvatarMember] {
        currentChatIndex.groupAvatarMembers(
            memberPublicKeys: memberPublicKeys,
            recentSenderPublicKeys: recentSenderPublicKeys
        )
    }

    private var currentChatIndex: TaskifyWatchChatIndex {
        // Read observed input even on cache hits so SwiftUI keeps tracking updates.
        _ = chatSnapshot
        if let cachedChatIndex { return cachedChatIndex }
        let index = TaskifyWatchChatIndex(snapshot: chatSnapshot, identity: chatIdentityPublicKey ?? "")
        cachedChatIndex = index
        return index
    }

    private var currentTaskIndex: TaskifyWatchTaskIndex {
        _ = snapshot
        _ = pendingCompletionIDs
        if let cachedTaskIndex { return cachedTaskIndex }
        let index = TaskifyWatchTaskIndex(snapshot: snapshot, pendingCompletions: pendingCompletionIDs)
        cachedTaskIndex = index
        return index
    }

    func refreshViewClock() { viewClock = Date() }

    var nextViewClockDelay: TimeInterval {
        let now = Date()
        let midnight = Calendar.current.date(byAdding: .day, value: 1,
                                             to: Calendar.current.startOfDay(for: now)) ?? now.addingTimeInterval(60)
        let expiry = chatSnapshot.outbox.map(\.expiresAt).filter { $0 > now }.min() ?? midnight
        return max(0.1, min(60, min(midnight, expiry).timeIntervalSince(now)))
    }

    func beginAvatarRefresh() async {
        await TaskifyWatchAvatarLoader.shared.beginSession()
        avatarRefreshRevision += 1
    }

    @discardableResult
    func refreshChat(backgroundDeadline: ContinuousClock.Instant? = nil) async -> Bool {
        guard isProvisioned else {
            Self.chatSyncLogger.info("Chat refresh deferred: provisioning or protected state unavailable")
            return false
        }
        if isRefreshingChat {
            // A notification must not wait on an unbounded foreground sync. The existing
            // refresh owns the cache; scheduled/foreground refresh will catch up afterward.
            if backgroundDeadline != nil {
                Self.chatSyncLogger.info("Background refresh deferred: sync already running")
                return true
            }
            await withCheckedContinuation { continuation in
                chatRefreshWaiters.append(continuation)
            }
            return true
        }
        guard let chatContext else { return false }
        guard let privateKey = try? identityStore.load() else {
            Self.chatSyncLogger.info("Chat refresh deferred: protected key unavailable")
            return false
        }
        let revision = chatAccountRevision
        isRefreshingChat = true
        var succeeded = false
        do {
            _ = try await chatCoordinator.configure(chatContext)
            let refreshed = try await chatCoordinator.refreshInbox(
                privateKey: privateKey, backgroundDeadline: backgroundDeadline
            )
            if revision == chatAccountRevision {
                chatSnapshot = refreshed
                succeeded = true
                chatStatusMessage = "Chat up to date"
                // Message content comes from the Watch's own relay pulls; display metadata does
                // not. If a pulled conversation has no summary and no contact, only the phone's
                // directory can name it.
                if backgroundDeadline == nil, chatDirectorySyncNeeded(refreshed) {
                    requestChatDirectoryFromPhone()
                }
            }
        } catch {
            // Never log an error description: server responses can contain account metadata.
            let nsError = error as NSError
            let category = error is CancellationError ? "cancelled"
                : nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut ? "timeout"
                : nsError.domain == NSCocoaErrorDomain ? "storage"
                : "transport-or-processing"
            Self.chatSyncLogger.error("Chat refresh failed: \(category, privacy: .public)")
            if revision == chatAccountRevision {
                chatSnapshot = await chatCoordinator.snapshot()
                chatStatusMessage = "Showing saved messages"
            }
        }
        isRefreshingChat = false
        let waiters = chatRefreshWaiters
        chatRefreshWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if backgroundDeadline == nil { scheduleChatOutboxRetry() }
        return succeeded
    }

    /// Pulls and decrypts a privacy-preserving push wakeup. The caller can use the return value
    /// to schedule a generic local notification; no sender, group, or message metadata needs to
    /// pass through APNs.
    func handleChatPushWake() async -> TaskifyWatchChatWakeResult {
        Self.chatSyncLogger.info("Background chat refresh started")
        guard !isRefreshingChat else {
            Self.chatSyncLogger.info("Background refresh deferred: sync already running")
            return TaskifyWatchChatWakeResult(receivedData: false, shouldNotify: false, failed: false)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(18))
        let revision = chatAccountRevision
        // The UI snapshot is restored asynchronously on cold launch. Compare with the durable
        // store so already-cached messages are not mistaken for new arrivals.
        let before = await chatCoordinator.snapshot()
        let existingRumorIDs = Set(before.messages.map(\.rumorID))
        let succeeded = await refreshChat(backgroundDeadline: deadline)
        let after = await chatCoordinator.snapshot()
        guard revision == chatAccountRevision else {
            return TaskifyWatchChatWakeResult(receivedData: false, shouldNotify: false, failed: true)
        }
        let identity = chatIdentityPublicKey ?? ""
        let groups = after.groups.reduce(into: [String: TaskifyWatchGroupConversation]()) {
            $0[$1.groupID] = $1
        }
        let newMessages = after.messages.filter {
            !existingRumorIDs.contains($0.rumorID) && $0.senderPublicKey != identity
        }
        let shouldNotify = newMessages.contains { message in
            if let group = groups[message.conversationID] {
                return !group.isMuted && !group.isLeft
            }
            return true
        }
        let receivedData = after.cursor != before.cursor || !newMessages.isEmpty
        Self.chatSyncLogger.info("Background chat refresh finished: changed=\(receivedData), succeeded=\(succeeded)")
        return TaskifyWatchChatWakeResult(receivedData: receivedData, shouldNotify: shouldNotify, failed: !succeeded)
    }

    @discardableResult
    func sendChat(
        _ text: String,
        memberPublicKeys: [String],
        subject: String? = nil,
        replyToRumorID: String? = nil,
        reactionToRumorID: String? = nil
    ) async -> Bool {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let revision = chatAccountRevision
        guard !content.isEmpty else { return false }
        guard let chatContext else {
            chatStatusMessage = TaskifyWatchChatCoordinatorError.notConfigured.localizedDescription
            return false
        }
        let privateKey: Data
        do {
            privateKey = try identityStore.load()
        } catch {
            chatStatusMessage = error.localizedDescription
            return false
        }
        do {
            let previousOutboxIDs = Set(chatSnapshot.outbox.map(\.rumorID))
            // `chatContext` is restored synchronously, while actor configuration happens in a
            // launch task. Ensuring it here prevents an immediate post-launch send from racing
            // that task and incorrectly reporting that Watch chat is not configured.
            _ = try await chatCoordinator.configure(chatContext)
            let queued = try await chatCoordinator.send(
                content: content,
                memberPublicKeys: memberPublicKeys,
                subject: subject,
                replyToRumorID: replyToRumorID,
                reactionToRumorID: reactionToRumorID,
                privateKey: privateKey
            )
            guard revision == chatAccountRevision else { return false }
            chatSnapshot = queued
            let newEntry = chatSnapshot.outbox.first {
                !previousOutboxIDs.contains($0.rumorID)
            }
            // Never describe a locally persisted bubble as sent until at least one relay has
            // acknowledged every real recipient copy. Durable retry is still success from the
            // composer's perspective, but its status remains explicit while delivery is pending.
            chatStatusMessage = newEntry?.areRecipientCopiesDelivered == true
                ? "Message sent"
                : "Message queued — retrying"
            scheduleChatOutboxRetry()
            return true
        } catch {
            guard revision == chatAccountRevision else { return false }
            chatSnapshot = await chatCoordinator.snapshot()
            chatStatusMessage = error.localizedDescription
            scheduleChatOutboxRetry()
            return false
        }
    }

    /// Keeps durable sends moving while the app remains active. watchOS may suspend this task in
    /// the background, but the encrypted outbox survives and foreground refresh resumes it.
    private func scheduleChatOutboxRetry(minimumDelayMilliseconds: Int64 = 0) {
        chatOutboxRetryTask?.cancel()
        let now = Date()
        let nextAttempt = chatSnapshot.outbox
            .filter { $0.expiresAt > now }
            .flatMap { entry -> [Date] in
                let eligibleWraps = entry.areRecipientCopiesDelivered
                    ? entry.wraps
                    : entry.wraps.filter { $0.recipientPublicKey != entry.senderPublicKey }
                return eligibleWraps
                    .filter { !$0.isFullyReplicated }
                    .map(\.nextAttemptAt)
            }
            .min()
        guard let nextAttempt else { return }
        let delayMilliseconds = Int64(
            max(
                Double(minimumDelayMilliseconds),
                min(15 * 60 * 1_000, nextAttempt.timeIntervalSinceNow * 1_000)
            )
        )
        chatOutboxRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(delayMilliseconds))
            guard !Task.isCancelled, let self, let chatContext = self.chatContext else { return }
            let revision = self.chatAccountRevision
            do {
                let privateKey = try self.identityStore.load()
                do {
                    _ = try await self.chatCoordinator.configure(chatContext)
                    let delivered = try await self.chatCoordinator.retryOutbox(
                        privateKey: privateKey
                    )
                    guard !Task.isCancelled, revision == self.chatAccountRevision else { return }
                    self.chatSnapshot = delivered
                    self.chatStatusMessage = self.chatSnapshot.outbox.contains {
                        !$0.areRecipientCopiesDelivered && $0.expiresAt > Date()
                    } ? "Message queued — retrying" : "Message sent"
                } catch {
                    guard !Task.isCancelled, revision == self.chatAccountRevision else { return }
                    self.chatSnapshot = await self.chatCoordinator.snapshot()
                    self.chatStatusMessage = "Message queued — retrying"
                    // Configuration/storage errors may leave an already-due entry unchanged.
                    // Keep immediate first sends without spinning on that same failed entry.
                    self.scheduleChatOutboxRetry(minimumDelayMilliseconds: 5_000)
                    return
                }
                self.scheduleChatOutboxRetry()
            } catch {
                guard !Task.isCancelled, revision == self.chatAccountRevision else { return }
                // The identity key is only readable while the Watch is unlocked. This chain
                // previously died here (a wrist-down, passcode-locked watch) and left the
                // outbox stranded until the next foreground refresh; re-arm so delivery
                // resumes shortly after unlock.
                self.chatOutboxRetryTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(60))
                    guard !Task.isCancelled, self?.chatAccountRevision == revision else { return }
                    self?.scheduleChatOutboxRetry()
                }
            }
        }
    }

    func markChatRead(_ conversationID: String) {
        let normalized = conversationID.lowercased()
        let identity = chatIdentityPublicKey ?? ""
        let localTimestamp = chatSnapshot.messages.lazy
            .filter({
                $0.conversationID == normalized && $0.senderPublicKey != identity
            })
            .map(\.createdAt)
            .max()
        let projectedTimestamp = chatSnapshot.threadSummaries?
            .first { $0.conversationID == normalized }?
            .latestActivityAt
        guard let timestamp = [localTimestamp, projectedTimestamp].compactMap({ $0 }).max() else {
            return
        }
        // An already-read thread with no displayed unread count has nothing to mark. Touching
        // the store again would bump its generatedAt, re-trigger this method through the
        // conversation view's onChange, and restart read-sync with the phone.
        let alreadyRead = (chatSnapshot.readAt[normalized] ?? 0) >= timestamp
        let summaryUnread = chatSnapshot.threadSummaries?
            .first { $0.conversationID == normalized }?
            .unreadCount ?? 0
        guard !alreadyRead || summaryUnread > 0 else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.chatSnapshot = (try? await self.chatCoordinator.markRead(
                conversationID: normalized,
                through: timestamp
            )) ?? self.chatSnapshot
            self.syncChatReadWithPhone(conversationID: normalized, through: timestamp)
        }
    }

    private func syncChatReadWithPhone(conversationID: String, through timestamp: Int) {
        let normalized = conversationID.lowercased()
        // One message per advancement. Re-marking an unchanged position re-rendered the thread
        // and re-sent the same read forever, so only a strictly newer position is transmitted.
        if let sent = lastSentChatReadThrough[normalized], timestamp <= sent {
            return
        }
        lastSentChatReadThrough[normalized] = timestamp
        guard WCSession.isSupported(),
              let update = TaskifyWatchTransfer.chatReadUpdate(
                conversationID: conversationID,
                through: timestamp
              ) else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        if session.isReachable {
            session.sendMessage(update) { [weak self] reply in
                Task { @MainActor in self?.apply(applicationContext: reply) }
            } errorHandler: { _ in
                session.transferUserInfo(update)
            }
        } else {
            let alreadyQueued = session.outstandingUserInfoTransfers.contains { transfer in
                guard let queued = TaskifyWatchTransfer.chatReadUpdate(from: transfer.userInfo) else {
                    return false
                }
                return queued.conversationID == conversationID && queued.timestamp >= timestamp
            }
            if !alreadyQueued { session.transferUserInfo(update) }
        }
    }

    /// True when the cache holds conversations the Watch cannot render usefully on its own: no
    /// summaries at all while messages exist, or a message whose conversation has no summary
    /// and whose sender is not a known contact.
    private func chatDirectorySyncNeeded(_ snapshot: TaskifyWatchChatSnapshot) -> Bool {
        if (snapshot.threadSummaries ?? []).isEmpty, !snapshot.messages.isEmpty { return true }
        let summaries = Set((snapshot.threadSummaries ?? []).map(\.id))
        let contacts = Set(snapshot.contacts.map(\.publicKey))
        return snapshot.messages.contains { message in
            !summaries.contains(message.conversationID)
                && !contacts.contains(message.senderPublicKey)
        }
    }

    /// Asks the paired iPhone for the chat directory: the contact list, thread display
    /// metadata, relay routing, and phone-side tombstones, in one bounded transfer. This is the
    /// only WatchConnectivity chat traffic besides read badges — the Watch's own relay pulls
    /// carry message content, and the reply's empty task payload is deliberately ignored.
    func requestChatDirectoryFromPhone() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        // `isPaired`/`isWatchAppInstalled` are iPhone-side properties; a watchOS session is
        // paired by definition once it reports activated.
        guard session.activationState == .activated else { return }
        guard session.isReachable else {
            needsChatDirectorySync = true
            return
        }
        // A pending flag (unreachable request, failed request, or an unknown conversation seen
        // during a relay pull) retries immediately; otherwise requests are bounded to one per
        // interval so routine activations stay silent.
        if !needsChatDirectorySync,
           let last = lastChatDirectoryRequestAt,
           Date().timeIntervalSince(last) < Self.chatDirectoryRequestInterval {
            return
        }
        lastChatDirectoryRequestAt = Date()
        needsChatDirectorySync = false
        session.sendMessage(TaskifyWatchTransfer.chatDirectoryRequest) { [weak self] reply in
            Task { @MainActor in self?.applyChatDirectoryReply(reply) }
        } errorHandler: { [weak self] _ in
            Task { @MainActor in self?.needsChatDirectorySync = true }
        }
    }

    func setGroupMuted(_ groupID: String, muted: Bool) {
        guard var group = chatSnapshot.groups.first(where: { $0.groupID == groupID }) else { return }
        group.isMuted = muted
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.chatSnapshot = (try? await self.chatCoordinator.setGroup(group)) ?? self.chatSnapshot
        }
    }

    func setGroupLeft(_ groupID: String, left: Bool) {
        guard var group = chatSnapshot.groups.first(where: { $0.groupID == groupID }) else { return }
        group.isLeft = left
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.chatSnapshot = (try? await self.chatCoordinator.setGroup(group)) ?? self.chatSnapshot
        }
    }

    func renameGroup(_ groupID: String, name: String) {
        guard var group = chatSnapshot.groups.first(where: { $0.groupID == groupID }) else { return }
        group.name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        group.nameUpdatedAt = Int(Date().timeIntervalSince1970)
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.chatSnapshot = (try? await self.chatCoordinator.setGroup(group)) ?? self.chatSnapshot
        }
    }

    func blockChatSender(_ publicKey: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.chatSnapshot = (try? await self.chatCoordinator.block(publicKey: publicKey))
                ?? self.chatSnapshot
            await TaskifyWatchPhotoLoader.shared.clear()
            TaskifyWatchMarkdownCache.shared.clear()
        }
    }

    func deleteChatConversation(_ conversationID: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.chatSnapshot = (try? await self.chatCoordinator.deleteConversation(conversationID))
                ?? self.chatSnapshot
            await TaskifyWatchPhotoLoader.shared.clear()
            TaskifyWatchMarkdownCache.shared.clear()
        }
    }

    func clearChatData() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.chatSnapshot = (try? await self.chatCoordinator.clearMessages())
                ?? self.chatSnapshot
            await TaskifyWatchPhotoLoader.shared.clear()
            TaskifyWatchMarkdownCache.shared.clear()
            await TaskifyWatchAvatarLoader.shared.clear()
        }
    }

    func retryChatMessage(_ rumorID: String) {
        guard let chatContext, let privateKey = try? identityStore.load() else { return }
        let revision = chatAccountRevision
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.chatCoordinator.configure(chatContext)
                let retried = try await self.chatCoordinator.retryMessage(
                    rumorID: rumorID,
                    privateKey: privateKey
                )
                guard revision == self.chatAccountRevision else { return }
                self.chatSnapshot = retried
                self.chatStatusMessage = retried.outbox.first {
                    $0.rumorID == rumorID.lowercased()
                }?.areRecipientCopiesDelivered == true
                    ? "Message sent"
                    : "Message queued — retrying"
                self.scheduleChatOutboxRetry()
            } catch {
                guard revision == self.chatAccountRevision else { return }
                self.chatSnapshot = await self.chatCoordinator.snapshot()
                self.chatStatusMessage = "Message retry failed"
            }
        }
    }

    func registerWatchPushToken(_ deviceToken: Data) async {
        guard let chatContext, let privateKey = try? identityStore.load() else { return }
        let revision = chatAccountRevision
        do {
            // APNs can return the token before the launch-time coordinator task finishes. Ensure
            // the gateway is configured here so that race cannot silently lose registration until
            // the next app launch.
            _ = try await chatCoordinator.configure(chatContext)
            let registration = try await chatCoordinator.registerWatch(
                deviceToken: deviceToken,
                installationID: watchInstallationID,
                environment: Self.watchAPNsEnvironment,
                privateKey: privateKey
            )
            guard revision == chatAccountRevision else { return }
            self.chatContext = registration.context
            try persistChatContext()
            chatSnapshot = registration.snapshot
            chatStatusMessage = "Watch notifications ready"
        } catch {
            guard revision == chatAccountRevision else { return }
            chatStatusMessage = "Watch notifications need attention"
        }
    }

    private static var watchAPNsEnvironment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    private var watchInstallationID: String {
        let key = "taskify.watch.chat.installation-id.v1"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let value = UUID().uuidString
        UserDefaults.standard.set(value, forKey: key)
        return value
    }

    func boardName(for boardID: String?) -> String {
        guard let boardID,
              let board = snapshot.boards.first(where: { $0.id == boardID }) else {
            return "No board available"
        }
        return board.name
    }

    func setActiveQuickAddBoardID(_ boardID: String?) {
        activeQuickAddBoardID = boardID
    }

    func requestInitialSetupNavigation() {
        guard !isProvisioned,
              !requestedInitialSetupNavigation,
              WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }

        requestedInitialSetupNavigation = true
        statusMessage = "Open Taskify on your iPhone. Watch authorization will open automatically."
        let request = TaskifyWatchTransfer.setupNavigationRequest
        if session.isReachable {
            session.sendMessage(request) { _ in
                // The iPhone accepted the navigation request. Provisioning still requires the
                // explicit confirmation button on the phone.
            } errorHandler: { [weak self] _ in
                Task { @MainActor in
                    self?.queueInitialSetupNavigation(request, using: session)
                }
            }
        } else {
            queueInitialSetupNavigation(request, using: session)
        }
    }

    private func queueInitialSetupNavigation(
        _ request: [String: Any],
        using session: WCSession
    ) {
        let alreadyQueued = session.outstandingUserInfoTransfers.contains {
            TaskifyWatchTransfer.isSetupNavigationRequest($0.userInfo)
        }
        guard !alreadyQueued else { return }
        session.transferUserInfo(request)
    }

    func taskWithPendingEdits(_ task: TaskifyWatchTask) -> TaskifyWatchTask {
        pendingCommands.reduce(task) { result, command in
            guard command.taskID == task.id else { return result }
            if let edit = command.edit { return result.applying(edit) }
            if let subtaskID = command.subtaskID, let completed = command.subtaskCompleted {
                return result.settingSubtaskCompletion(subtaskID, completed: completed)
            }
            return result
        }
    }

    @discardableResult
    func editTask(_ taskID: String, edit: TaskifyWatchTaskEdit) -> Bool {
        guard snapshot.tasks.contains(where: { $0.id == taskID }),
              !edit.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let command = TaskifyWatchCommand(kind: .editTask, taskID: taskID, edit: edit)
        pendingCommands.append(command)
        // Reassign the observed snapshot so queued edits immediately refresh detail views.
        replaceSnapshot(tasks: snapshot.tasks.map { $0.id == taskID ? $0.applying(edit) : $0 }, generatedAt: Date())
        persistPendingCommands()
        deliver(command)
        return true
    }

    func setSubtaskCompletion(taskID: String, subtaskID: String, completed: Bool) {
        guard let task = snapshot.tasks.first(where: { $0.id == taskID }),
              task.subtasks.contains(where: { $0.id == subtaskID }),
              !pendingCompletionIDs.contains(taskID) else { return }
        let command = TaskifyWatchCommand(
            kind: .setSubtaskCompletion, taskID: taskID,
            subtaskID: subtaskID, subtaskCompleted: completed
        )
        pendingCommands.append(command)
        persistPendingCommands()
        replaceSnapshot(tasks: snapshot.tasks.map {
            $0.id == taskID ? $0.settingSubtaskCompletion(subtaskID, completed: completed) : $0
        }, generatedAt: Date())
        deliver(command)
    }

    func completeTask(_ taskID: String) {
        guard snapshot.tasks.contains(where: { $0.id == taskID }),
              !pendingCompletionIDs.contains(taskID) else { return }
        let command = TaskifyWatchCommand(kind: .completeTask, taskID: taskID)
        pendingCommands.append(command)
        pendingCompletionIDs.insert(taskID)
        persistPendingCommands()
        persistWidgetSnapshot()
        deliver(command)
        beginDirectSync(command)
    }

    @discardableResult
    func addTask(_ input: String, boardID requestedBoardID: String?, usingTaskifyVoice: Bool) -> Bool {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let boardID = requestedBoardID ?? quickAddBoardID else {
            statusMessage = "Choose a board before adding a task."
            return false
        }
        let command = TaskifyWatchCommand(
            kind: usingTaskifyVoice ? .processVoiceTranscript : .createTask,
            title: usingTaskifyVoice ? nil : value,
            boardID: boardID,
            transcript: usingTaskifyVoice ? value : nil
        )
        pendingCommands.append(command)
        persistPendingCommands()
        statusMessage = usingTaskifyVoice ? "Sending to Taskify Voice…" : "Adding task…"
        deliver(command)
        beginDirectSync(command)
        return true
    }

    func previewVoiceTasks(
        transcript input: String,
        boardID: String
    ) async throws -> TaskifyWatchVoicePreview {
        let transcript = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else {
            throw TaskifyWatchDictationError.invalidResponse
        }
        if let profile = independentProfile,
           !profile.publicKeyNpub.isEmpty,
           let privateKey = try? identityStore.load() {
            do {
                return try await independentClient.interpretVoice(
                    transcript: transcript,
                    boardID: boardID,
                    boards: voiceBoardContexts(),
                    profile: profile,
                    privateKey: privateKey
                )
            } catch {
                // A reachable iPhone remains a seamless fallback while the Watch service or its
                // network route is temporarily unavailable.
            }
        }
        guard WCSession.isSupported(),
              WCSession.default.activationState == .activated,
              WCSession.default.isReachable else {
            throw TaskifyWatchDictationError.phoneUnavailable
        }
        let request = TaskifyWatchVoicePreviewRequest(
            transcript: transcript,
            boardID: boardID
        )
        let data = try TaskifyWatchTransfer.encode(request)
        return try await withCheckedThrowingContinuation { continuation in
            WCSession.default.sendMessageData(data) { replyData in
                do {
                    let preview = try TaskifyWatchTransfer.decodeVoicePreview(replyData)
                    guard preview.requestID == request.id else {
                        throw TaskifyWatchDictationError.invalidResponse
                    }
                    continuation.resume(returning: preview)
                } catch {
                    continuation.resume(throwing: TaskifyWatchDictationError.invalidResponse)
                }
            } errorHandler: { _ in
                continuation.resume(throwing: TaskifyWatchDictationError.phoneUnavailable)
            }
        }
    }

    /// Board/list context for the independent voice finalizer: week and list
    /// boards with their columns, so the model can route spoken tasks to a named
    /// board ("add this to my Errands board"). Kind strings match the Worker's
    /// wire format ("week"/"lists").
    private func voiceBoardContexts() -> [TaskifyWatchVoiceBoardContext] {
        snapshot.boards.compactMap { board -> TaskifyWatchVoiceBoardContext? in
            guard let kind = board.kind, kind == "week" || kind == "lists" else { return nil }
            return TaskifyWatchVoiceBoardContext(
                id: board.id,
                name: board.name,
                kind: kind,
                columns: kind == "lists"
                    ? (board.columns ?? [])
                        .sorted { $0.order < $1.order }
                        .map { TaskifyWatchVoiceBoardContext.Column(id: $0.id, name: $0.name) }
                    : nil
            )
        }
    }

    @discardableResult
    func addVoiceTasks(_ tasks: [TaskifyWatchVoiceDraft], boardID: String) -> Bool {
        guard !tasks.isEmpty else { return false }
        let command = TaskifyWatchCommand(
            kind: .createVoiceTasks,
            boardID: boardID,
            voiceTasks: tasks
        )
        pendingCommands.append(command)
        persistPendingCommands()
        statusMessage = tasks.count == 1 ? "Adding task…" : "Adding \(tasks.count) tasks…"
        deliver(command)
        beginDirectSync(command)
        return true
    }

    /// Refreshes encrypted Taskify task records through the Watch HTTPS transport. This works
    /// over the Watch's own Wi-Fi/cellular route and does not require a reachable iPhone.
    func refreshLatestData(forceComplicationReload: Bool = false) async {
        // Inbox catch-up must not wait behind phone reachability and task-board downloads.
        async let chatRefresh: Void = refreshForegroundChat()
        // Apply the phone projection first, then let the relay's latest replaceable events win.
        // Running these concurrently can allow a delayed phone reply to overwrite a newer edit
        // fetched directly from a web client.
        await requestLatestSnapshotFromPhone()
        await refreshFromRelays()
        await chatRefresh
        if forceComplicationReload {
            reloadComplicationTimelines()
        }
    }

    private func refreshForegroundChat() async {
        await refreshChat()
        guard !Task.isCancelled, isProvisioned,
              preparedChatAccountRevision != chatAccountRevision,
              let chatContext, let privateKey = try? identityStore.load() else { return }
        let revision = chatAccountRevision
        do {
            _ = try await chatCoordinator.configure(chatContext)
            let prepared = try await chatCoordinator.prepareIndependentInbox(privateKey: privateKey)
            guard revision == chatAccountRevision else { return }
            self.chatContext = prepared
            try persistChatContext()
            preparedChatAccountRevision = revision
        } catch {
            // Keep the cached inbox usable and retry enrollment on a later foreground refresh.
        }
    }

    func refreshFromRelays() async {
        guard isProvisioned,
              !snapshot.boards.isEmpty,
              let profile = independentProfile,
              !directSyncCommandIDs.contains("_refresh"),
              let privateKey = try? identityStore.load() else { return }
        directSyncCommandIDs.insert("_refresh")
        defer { directSyncCommandIDs.remove("_refresh") }

        do {
            let events = try await independentClient.fetchTasks(
                boards: snapshot.boards,
                gatewayBaseURL: chatContext?.pushRelayHTTPSURL,
                profile: profile,
                privateKey: privateKey
            )
            await mergeRelayEvents(events)
            statusMessage = pendingCommands.isEmpty ? "Independent sync up to date" : "Watch changes waiting for iPhone"
        } catch {
            // Cached tasks and the phone transport remain fully usable when the independent
            // service or every configured relay is temporarily unavailable.
            if pendingCommands.isEmpty {
                statusMessage = "Showing saved tasks — relay refresh will retry."
            }
        }
    }

    private func beginDirectSync(_ command: TaskifyWatchCommand) {
        if WCSession.isSupported(),
           WCSession.default.activationState == .activated,
           WCSession.default.isReachable {
            return
        }
        guard independentProfile != nil,
              directSyncCommandIDs.insert(command.id).inserted else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.directSyncCommandIDs.remove(command.id) }
            await self.publishDirectly(command)
        }
    }

    private func publishDirectly(_ command: TaskifyWatchCommand) async {
        guard let profile = independentProfile,
              let privateKey = try? identityStore.load(),
              let mutations = try? directMutations(for: command),
              !mutations.isEmpty else { return }

        var published: [TaskifyWatchDirectMutation] = []
        for original in mutations {
            do {
                let event = try await TaskifyWatchNostrCrypto.prepareBoardEvent(original.event,
                    boardID: original.boardNostrID, relayURLs: original.relayURLs)
                let mutation = TaskifyWatchDirectMutation(event: event, task: original.task,
                    relayURLs: original.relayURLs, boardNostrID: original.boardNostrID)
                try await independentClient.publish(
                    mutation.event,
                    relayURLs: mutation.relayURLs,
                    boardID: mutation.boardNostrID,
                    gatewayBaseURL: chatContext?.pushRelayHTTPSURL,
                    profile: profile,
                    privateKey: privateKey
                )
                published.append(mutation)
            } catch {
                // Keep the idempotent command in the durable phone queue. A later direct retry or
                // iPhone reconciliation can safely publish the same stable task identifier.
            }
        }
        guard !published.isEmpty else { return }
        applyDirectMutations(published)
        if published.count == mutations.count {
            statusMessage = command.kind == .completeTask
                ? "Completed directly from Watch"
                : (published.count == 1 ? "Task synced directly" : "Tasks synced directly")
        } else {
            statusMessage = "Some Watch changes synced; the rest are safely queued."
        }
    }

    private func directMutations(
        for command: TaskifyWatchCommand
    ) throws -> [TaskifyWatchDirectMutation] {
        guard let profile = independentProfile else { return [] }
        switch command.kind {
        case .editTask, .setSubtaskCompletion:
            // Editing is reconciled on iPhone to preserve scheduling and recurrence semantics.
            return []
        case .completeTask:
            guard let taskID = command.taskID,
                  let task = snapshot.tasks.first(where: { $0.id == taskID }),
                  let board = snapshot.boards.first(where: { $0.id == task.boardID }),
                  let boardNostrID = task.nostrBoardID ?? board.nostrBoardID,
                  let originalPayload = task.syncPayload else { return [] }
            let createdAt = max(Int(Date().timeIntervalSince1970), (task.nostrUpdatedAt ?? 0) + 1)
            let completedAt = taskifyISODate(Date())
            let payload = try updatingPayload(originalPayload, values: [
                "completedAt": completedAt,
                "completedBy": profile.publicKeyHex,
                "lastEditedBy": profile.publicKeyHex,
            ])
            let event = try TaskifyWatchNostrCrypto.taskEvent(
                taskID: task.id,
                boardID: boardNostrID,
                columnTag: board.kind == "week" ? "day" : (task.columnID ?? board.defaultColumnID ?? ""),
                status: "done",
                payload: payload,
                createdAt: createdAt
            )
            return [TaskifyWatchDirectMutation(
                event: event,
                task: nil,
                relayURLs: normalizedRelays(task.relayURLs ?? board.relayURLs ?? profile.relayURLs),
                boardNostrID: boardNostrID
            )]

        case .createTask:
            guard let title = command.title else { return [] }
            return try directCreationMutations(
                command: command,
                drafts: [TaskifyWatchVoiceDraft(title: title)]
            )

        case .createVoiceTasks:
            return try directCreationMutations(command: command, drafts: command.voiceTasks ?? [])

        case .processVoiceTranscript:
            // This legacy command is interpreted by the iPhone. Current Watch UI converts
            // dictation into createVoiceTasks through the independent voice endpoint first.
            return []
        }
    }

    private func directCreationMutations(
        command: TaskifyWatchCommand,
        drafts: [TaskifyWatchVoiceDraft]
    ) throws -> [TaskifyWatchDirectMutation] {
        guard let boardID = command.boardID,
              let defaultBoard = snapshot.boards.first(where: { $0.id == boardID }),
              let profile = independentProfile else { return [] }

        return try drafts.enumerated().compactMap { index, draft -> TaskifyWatchDirectMutation? in
            let board = draft.destinationBoard(in: snapshot.boards, fallback: defaultBoard)
            guard let boardNostrID = board.nostrBoardID else { return nil }
            let relays = normalizedRelays(board.relayURLs ?? profile.relayURLs)
            guard !relays.isEmpty else { return nil }
            let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            let stableTaskID = "watch-\(command.id)-\(index)"
            if snapshot.tasks.contains(where: { $0.id == stableTaskID }) { return nil }

            let created = Date()
            let preview = draft.taskPreview(board: board, now: created)
            let dueDate = preview.dueDate
            let hasExplicitTime = preview.dueTimeEnabled
            let columnID = preview.columnID
            let order = (snapshot.tasks
                .filter { $0.boardID == board.id && $0.columnID == columnID }
                .map(\.order)
                .min() ?? 0) - 1
            let payload = try newTaskPayload(
                id: stableTaskID,
                draft: draft,
                dueDate: dueDate,
                hasExplicitTime: hasExplicitTime,
                profile: profile,
                createdAt: created
            )
            let eventCreatedAt = Int(created.timeIntervalSince1970)
            let event = try TaskifyWatchNostrCrypto.taskEvent(
                taskID: stableTaskID,
                boardID: boardNostrID,
                columnTag: board.kind == "week" ? "day" : (columnID ?? ""),
                status: "open",
                payload: payload,
                createdAt: eventCreatedAt
            )
            let task = TaskifyWatchTask(
                id: stableTaskID,
                title: title,
                boardID: board.id,
                boardName: board.name,
                columnName: preview.columnName,
                dueDate: dueDate,
                dueTimeEnabled: hasExplicitTime,
                priority: draft.priority,
                order: order,
                columnID: columnID,
                nostrBoardID: boardNostrID,
                relayURLs: relays,
                syncPayload: payload,
                nostrUpdatedAt: eventCreatedAt
            )
            return TaskifyWatchDirectMutation(
                event: event,
                task: task,
                relayURLs: relays,
                boardNostrID: boardNostrID
            )
        }
    }

    private func newTaskPayload(
        id: String,
        draft: TaskifyWatchVoiceDraft,
        dueDate: Date?,
        hasExplicitTime: Bool,
        profile: TaskifyWatchIndependentProfile,
        createdAt: Date
    ) throws -> Data {
        var payload: [String: Any] = [
            "title": draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            "createdAt": Int64(createdAt.timeIntervalSince1970 * 1_000),
            "createdBy": profile.publicKeyHex,
            "lastEditedBy": profile.publicKeyHex,
            "dueDateEnabled": dueDate != nil,
            "dueTimeEnabled": hasExplicitTime,
        ]
        if let dueDate { payload["dueISO"] = taskifyISODate(dueDate) }
        if hasExplicitTime { payload["dueTimeZone"] = TimeZone.current.identifier }
        if let note = draft.notes, !note.isEmpty { payload["note"] = note }
        if let priority = draft.priority { payload["priority"] = priority }
        let subtasks = (draft.subtasks ?? []).enumerated().compactMap { index, raw -> [String: Any]? in
            let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            return ["id": "\(id)-subtask-\(index)", "title": title, "completed": false]
        }
        if !subtasks.isEmpty { payload["subtasks"] = subtasks }
        if let recurrenceObject = try Self.voiceRecurrencePayload(draft.recurrence) {
            payload["recurrence"] = recurrenceObject
        }
        if dueDate != nil {
            let reminders = Self.voiceReminderPayload(
                minutes: draft.reminderMinutesBeforeDue,
                dateOnly: !hasExplicitTime
            )
            if !reminders.isEmpty { payload["reminders"] = reminders }
            if !hasExplicitTime, let reminderTime = draft.reminderTime {
                payload["reminderTime"] = reminderTime
            }
        }
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    /// Encodes the shared recurrence wire type into the task event payload's
    /// `recurrence` object, matching the shape `TaskEventCodec` and the PWA both
    /// decode ({type, days/n/unit/day/interval}).
    private static func voiceRecurrencePayload(_ recurrence: VoiceRecurrence?) throws -> [String: Any]? {
        guard let recurrence else { return nil }
        let data = try JSONEncoder().encode(recurrence)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Maps Worker reminder offsets (minutes before due) onto the app's reminder
    /// preset strings ("5m", "15m", "1h", "custom-N"...), deduplicating while
    /// preserving the order the user spoke them.
    private static func voiceReminderPayload(minutes: [Int]?, dateOnly: Bool) -> [String] {
        guard let minutes else { return [] }
        var seen = Set<String>()
        var reminders: [String] = []
        for value in minutes where value >= 0 {
            let rawValue: String
            if value == 0 {
                rawValue = dateOnly ? "0d" : "0h"
            } else {
                switch value {
                case 5: rawValue = "5m"
                case 15: rawValue = "15m"
                case 30: rawValue = "30m"
                case 60: rawValue = "1h"
                case 1_440: rawValue = "1d"
                case 10_080: rawValue = "1w"
                default: rawValue = "custom-\(value)"
                }
            }
            if seen.insert(rawValue).inserted {
                reminders.append(rawValue)
            }
        }
        return reminders
    }

    private func updatingPayload(_ data: Data, values: [String: Any]) throws -> Data {
        guard var payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
        for (key, value) in values { payload[key] = value }
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private func applyDirectMutations(_ mutations: [TaskifyWatchDirectMutation]) {
        let createdTasks = mutations.compactMap(\.task)
        guard !createdTasks.isEmpty else { return }
        var tasks = snapshot.tasks
        for task in createdTasks where !tasks.contains(where: { $0.id == task.id }) {
            tasks.append(task)
        }
        replaceSnapshot(tasks: tasks, generatedAt: Date())
    }

    private func mergeRelayEvents(_ events: [TaskifyWatchNostrEvent]) async {
        var boards = snapshot.boards
        let boardPairs: [(String, TaskifyWatchBoard)] = boards.compactMap { board in
            guard let boardID = board.nostrBoardID,
                  let author = try? TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID) else {
                return nil
            }
            return (author, board)
        }
        var boardByAuthor = Dictionary(boardPairs, uniquingKeysWith: { first, _ in first })

        let latestBoardEvents = events
            .filter { $0.kind == TaskifyWatchNostrCrypto.boardEventKind }
            .reduce(into: [String: TaskifyWatchNostrEvent]()) { latest, event in
                let author = event.publicKey.lowercased()
                guard boardByAuthor[author] != nil else { return }
                if let current = latest[author],
                   current.createdAt > event.createdAt
                    || (current.createdAt == event.createdAt && current.id <= event.id) {
                    return
                }
                latest[author] = event
            }
        for (author, event) in latestBoardEvents {
            guard let current = boardByAuthor[author],
                  event.createdAt > (current.nostrUpdatedAt ?? 0),
                  let updated = Self.decodeRelayBoard(event, existing: current),
                  let index = boards.firstIndex(where: { $0.id == current.id }) else { continue }
            boards[index] = updated
            boardByAuthor[author] = updated
        }

        var latestByTaskID: [String: (TaskifyWatchNostrEvent, TaskifyWatchBoard)] = [:]
        for event in events where event.kind == TaskifyWatchNostrCrypto.taskEventKind {
            guard let taskID = event.firstTagValue(named: "d"),
                  let board = boardByAuthor[event.publicKey.lowercased()] else { continue }
            if let current = latestByTaskID[taskID],
               current.0.createdAt > event.createdAt
                || (current.0.createdAt == event.createdAt && current.0.id <= event.id) {
                continue
            }
            latestByTaskID[taskID] = (event, board)
        }

        var tasks = snapshot.tasks
        var taskIndexByID = Dictionary(
            tasks.indices.map { (tasks[$0].id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var removedTaskIDs = Set<String>()

        // A fresh fetch carries an event for every task on the relay, so the decode below runs
        // one decryption per unique task. Do that CPU work off the main actor and apply the
        // results here; everything it touches is a Sendable value.
        let decodeInputs: [(String, TaskifyWatchNostrEvent, TaskifyWatchBoard, TaskifyWatchTask?)] = latestByTaskID
            .compactMap { taskID, pair in
                guard let existingIndex = taskIndexByID[taskID] else {
                    return (taskID, pair.0, pair.1, nil)
                }
                if (tasks[existingIndex].nostrUpdatedAt ?? 0) > pair.0.createdAt { return nil }
                return (taskID, pair.0, pair.1, tasks[existingIndex])
            }
        let decodedTasks = await Task.detached(priority: .userInitiated) { [decodeInputs] () -> [String: TaskifyWatchTask] in
            var decoded: [String: TaskifyWatchTask] = [:]
            decoded.reserveCapacity(decodeInputs.count)
            for (taskID, event, board, existing) in decodeInputs {
                let status = event.firstTagValue(named: "status")
                if status == "done" || status == "deleted" { continue }
                guard let task = Self.decodeRelayTask(event, board: board, existing: existing) else {
                    continue
                }
                decoded[taskID] = task
            }
            return decoded
        }.value

        for (taskID, decoded) in decodedTasks {
            if let index = taskIndexByID[taskID] {
                tasks[index] = decoded
            } else {
                taskIndexByID[taskID] = tasks.count
                tasks.append(decoded)
            }
        }
        for (taskID, pair) in latestByTaskID {
            let status = pair.0.firstTagValue(named: "status")
            guard status == "done" || status == "deleted" else { continue }
            // Mirror the staleness gate the upsert path uses: a tombstone older than the stored
            // task does not remove it.
            if let existingIndex = taskIndexByID[taskID],
               (tasks[existingIndex].nostrUpdatedAt ?? 0) <= pair.0.createdAt {
                removedTaskIDs.insert(taskID)
            }
        }
        if !removedTaskIDs.isEmpty {
            tasks.removeAll { removedTaskIDs.contains($0.id) }
        }
        replaceSnapshot(tasks: tasks, boards: boards, generatedAt: Date())
    }

    private nonisolated static func decodeRelayBoard(
        _ event: TaskifyWatchNostrEvent,
        existing board: TaskifyWatchBoard
    ) -> TaskifyWatchBoard? {
        guard let boardID = board.nostrBoardID,
              let plaintext = try? TaskifyWatchNostrCrypto.decryptBoardPayload(
                event,
                boardID: boardID
              ),
              let payload = try? JSONDecoder().decode(
                TaskifyWatchBoardRelayPayload.self,
                from: plaintext
              ) else { return nil }
        let payloadName = payload.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let taggedName = event.firstTagValue(named: "name")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let name = payloadName?.isEmpty == false
            ? payloadName!
            : (taggedName?.isEmpty == false ? taggedName! : board.name)
        let kind = payload.kind
            ?? event.firstTagValue(named: "k")
            ?? board.kind
        let columns = (payload.columns ?? board.columns)?.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.id < $1.id
        }
        let defaultColumnID = kind == "week"
            ? taskifyWeekdayID(for: Date())
            : columns?.first?.id ?? board.defaultColumnID
        return TaskifyWatchBoard(
            id: board.id,
            name: name,
            openTaskCount: board.openTaskCount,
            kind: kind,
            nostrBoardID: board.nostrBoardID,
            relayURLs: board.relayURLs,
            defaultColumnID: defaultColumnID,
            columns: columns,
            nostrUpdatedAt: event.createdAt
        )
    }

    private nonisolated static func decodeRelayTask(
        _ event: TaskifyWatchNostrEvent,
        board: TaskifyWatchBoard,
        existing: TaskifyWatchTask?
    ) -> TaskifyWatchTask? {
        guard let boardNostrID = board.nostrBoardID,
              let payload = try? TaskifyWatchNostrCrypto.decryptTaskPayload(event, boardID: boardNostrID),
              let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let title = (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty,
              let taskID = event.firstTagValue(named: "d") else { return nil }
        let dueDate = (object["dueISO"] as? String).flatMap(taskifyParseISODate)
        let columnID = board.kind == "week"
            ? taskifyWeekdayID(for: dueDate ?? Date())
            : event.firstTagValue(named: "col")
        let number = object["priority"] as? NSNumber
        return TaskifyWatchTask(
            id: taskID,
            title: title,
            boardID: board.id,
            boardName: board.name,
            columnName: board.kind == "week"
                ? taskifyWeekdayName(for: dueDate ?? Date())
                : board.columns?.first(where: { $0.id == columnID })?.name ?? existing?.columnName,
            dueDate: (object["dueDateEnabled"] as? Bool) == false ? nil : dueDate,
            dueTimeEnabled: object["dueTimeEnabled"] as? Bool ?? false,
            priority: number?.intValue,
            order: existing?.order ?? 0,
            columnID: columnID,
            nostrBoardID: boardNostrID,
            relayURLs: board.relayURLs,
            syncPayload: payload,
            nostrUpdatedAt: event.createdAt
        )
    }

    private func replaceSnapshot(
        tasks: [TaskifyWatchTask],
        boards sourceBoards: [TaskifyWatchBoard]? = nil,
        generatedAt: Date
    ) {
        // One counting pass instead of a full task scan per board.
        var openCounts: [String: Int] = [:]
        for task in tasks {
            openCounts[task.boardID, default: 0] += 1
        }
        let boards = (sourceBoards ?? snapshot.boards).map { board in
            TaskifyWatchBoard(
                id: board.id,
                name: board.name,
                openTaskCount: openCounts[board.id] ?? 0,
                kind: board.kind,
                nostrBoardID: board.nostrBoardID,
                relayURLs: board.relayURLs,
                defaultColumnID: board.defaultColumnID,
                columns: board.columns,
                nostrUpdatedAt: board.nostrUpdatedAt
            )
        }
        snapshot = TaskifyWatchSnapshot(
            tasks: tasks,
            boards: boards,
            selectedBoardID: snapshot.selectedBoardID,
            generatedAt: generatedAt,
            acknowledgedCommandIDs: snapshot.acknowledgedCommandIDs,
            chatProjection: snapshot.chatProjection,
            accent: snapshot.accent
        )
        persistSnapshot()
    }

    private func normalizedRelays(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            let normalized = value.trimmingCharacters(in: CharacterSet(charactersIn: " /"))
            guard normalized.hasPrefix("wss://"), seen.insert(normalized).inserted else { return nil }
            return normalized
        }
    }

    private func taskifyISODate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    private nonisolated static func taskifyParseISODate(_ value: String) -> Date? {
        VoiceTaskDate.parse(value)
    }

    private nonisolated static func taskifyWeekdayID(for date: Date) -> String {
        switch Calendar.current.component(.weekday, from: date) {
        case 1: "sunday"
        case 2: "monday"
        case 3: "tuesday"
        case 4: "wednesday"
        case 5: "thursday"
        case 6: "friday"
        default: "saturday"
        }
    }

    private nonisolated static func taskifyWeekdayName(for date: Date) -> String {
        switch Calendar.current.component(.weekday, from: date) {
        case 1: "Sun"
        case 2: "Mon"
        case 3: "Tue"
        case 4: "Wed"
        case 5: "Thu"
        case 6: "Fri"
        default: "Sat"
        }
    }

    private func activateConnectivity() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        apply(applicationContext: session.receivedApplicationContext)
    }

    /// Pulls the current projection while both apps are reachable instead of relying solely on
    /// application-context delivery. This is especially important after the Watch app has been
    /// suspended: WatchConnectivity may wake it with an older cached context before delivering
    /// the replacement context.
    private func requestLatestSnapshotFromPhone() async {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        await withCheckedContinuation { continuation in
            session.sendMessage(TaskifyWatchTransfer.snapshotRequest) { [weak self] reply in
                Task { @MainActor in
                    self?.apply(applicationContext: reply)
                    continuation.resume()
                }
            } errorHandler: { _ in
                // Independent relay refresh and the queued application context remain available.
                continuation.resume()
            }
        }
    }

    private func retryPendingCommands() {
        for command in pendingCommands {
            deliver(command)
            beginDirectSync(command)
        }
    }

    private func deliver(_ command: TaskifyWatchCommand) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated,
              let data = try? TaskifyWatchTransfer.encode(command) else { return }

        if session.isReachable, immediateCommandIDs.insert(command.id).inserted {
            session.sendMessageData(data) { [weak self] replyData in
                Task { @MainActor in
                    guard let self else { return }
                    self.immediateCommandIDs.remove(command.id)
                    guard let receipt = try? TaskifyWatchTransfer.decodeCommandReceipt(replyData),
                          receipt.commandID == command.id else {
                        self.queueBackgroundDelivery(command, data: data)
                        self.beginDirectSync(command)
                        return
                    }
                    self.apply(snapshot: receipt.snapshot)
                    self.finish(commandID: command.id)
                }
            } errorHandler: { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.immediateCommandIDs.remove(command.id)
                    self.queueBackgroundDelivery(command, data: data)
                    self.beginDirectSync(command)
                }
            }
        } else if !session.isReachable {
            queueBackgroundDelivery(command, data: data)
        }
    }

    private func queueBackgroundDelivery(_ command: TaskifyWatchCommand, data: Data) {
        let session = WCSession.default
        let alreadyQueued = session.outstandingUserInfoTransfers.contains { transfer in
            guard let queuedData = transfer.userInfo[TaskifyWatchTransfer.commandDataKey] as? Data,
                  let queued = try? TaskifyWatchTransfer.decodeCommand(queuedData) else { return false }
            return queued.id == command.id
        }
        guard !alreadyQueued else { return }
        session.transferUserInfo([TaskifyWatchTransfer.commandDataKey: data])
        switch command.kind {
        case .editTask, .setSubtaskCompletion:
            statusMessage = "Edit saved — it will sync when the iPhone is available."
        case .completeTask:
            statusMessage = "Completion saved — it will sync when the iPhone is available."
        case .createTask:
            statusMessage = "Task saved — it will be added when the iPhone is available."
        case .createVoiceTasks:
            statusMessage = "Dictated tasks saved — they will be added when the iPhone is available."
        case .processVoiceTranscript:
            statusMessage = "Voice request saved — the iPhone will process it when available."
        }
    }

    private func finish(commandID: String) {
        let completedKind = pendingCommands.first(where: { $0.id == commandID })?.kind
        pendingCommands.removeAll { $0.id == commandID }
        refreshPendingCompletionIDs()
        persistPendingCommands()
        if pendingCommands.isEmpty {
            statusMessage = (completedKind == .editTask || completedKind == .setSubtaskCompletion) ? "Task updated" : (completedKind == .completeTask ? "Tasks are up to date" : "Task added")
        } else {
            statusMessage = "Waiting to sync Watch changes"
        }
    }

    private func acceptProvisioning(_ data: Data) throws -> Data {
        let payload = try TaskifyWatchTransfer.decodeProvisioningPayload(data)
        let previousPublicKey = independentProfile?.publicKeyHex.lowercased()
        let isAccountReplacement = previousPublicKey != nil
            && previousPublicKey != payload.publicKeyHex.lowercased()
        // Reject a malformed/mismatched envelope before it can replace the device-only key.
        _ = try TaskifyWatchNostrCrypto.requestAuthentication(
            privateKey: payload.privateKey,
            publicKeyHex: payload.publicKeyHex,
            body: Data(),
            timestamp: 0
        )
        chatAccountRevision += 1
        let provisioningRevision = chatAccountRevision
        if isAccountReplacement {
            chatOutboxRetryTask?.cancel()
            chatOutboxRetryTask = nil
            latestPhoneSnapshotGeneratedAt = .distantPast
            phoneSnapshotApplicationRevision += 1
            if payload.chatContext == nil {
                chatContext = nil
                if FileManager.default.fileExists(atPath: chatContextCacheURL.path) {
                    try FileManager.default.removeItem(at: chatContextCacheURL)
                }
            }
        }
        // The only durable write of private material is this Keychain call. The decoded envelope
        // goes out of scope immediately after the receipt is produced.
        try identityStore.save(payload.privateKey)
        let npub = payload.publicKeyNpub?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        independentProfile = TaskifyWatchIndependentProfile(
            publicKeyHex: payload.publicKeyHex,
            publicKeyNpub: npub,
            relayURLs: payload.relayURLs
        )
        try persistIndependentProfile()
        if let provisionedChatContext = payload.chatContext {
            chatContext = provisionedChatContext
            try persistChatContext()
            if isAccountReplacement {
                chatSnapshot = TaskifyWatchChatSnapshot()
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    if isAccountReplacement {
                        self.chatSnapshot = try await self.chatCoordinator.clear()
                        await TaskifyWatchPhotoLoader.shared.clear()
                        TaskifyWatchMarkdownCache.shared.clear()
                        await TaskifyWatchAvatarLoader.shared.clear()
                    }
                    guard provisioningRevision == self.chatAccountRevision else { return }
                    let configured = try await self.chatCoordinator.configure(
                        provisionedChatContext
                    )
                    guard provisioningRevision == self.chatAccountRevision else { return }
                    self.chatSnapshot = configured
                    let privateKey = try self.identityStore.load()
                    let prepared = try await self.chatCoordinator.prepareIndependentInbox(
                        privateKey: privateKey
                    )
                    guard provisioningRevision == self.chatAccountRevision else { return }
                    self.chatContext = prepared
                    try self.persistChatContext()
                    await self.refreshChat()
                    // The provisioning payload carries a projection, but a tight payload trims
                    // it (contacts drop first); one throttled directory request converges the
                    // directory without waiting for the next natural trigger.
                    self.requestChatDirectoryFromPhone()
                } catch {
                    guard provisioningRevision == self.chatAccountRevision else { return }
                    self.chatSnapshot = await self.chatCoordinator.snapshot()
                    self.chatStatusMessage = "Open Taskify on iPhone to finish chat setup"
                }
            }
        } else if isAccountReplacement {
            chatSnapshot = TaskifyWatchChatSnapshot()
            lastSentChatReadThrough.removeAll()
            Task { @MainActor [weak self] in
                guard let self else { return }
                let cleared = (try? await self.chatCoordinator.clear())
                    ?? TaskifyWatchChatSnapshot()
                guard provisioningRevision == self.chatAccountRevision else { return }
                self.chatSnapshot = cleared
                await TaskifyWatchPhotoLoader.shared.clear()
                TaskifyWatchMarkdownCache.shared.clear()
                await TaskifyWatchAvatarLoader.shared.clear()
                self.chatStatusMessage = "Open Taskify on iPhone to finish chat setup"
            }
        }
        isProvisioned = true
        sessionSetupTransfers().forEach { $0.cancel() }
        apply(snapshot: payload.snapshot)
        statusMessage = npub.isEmpty ? "Secure account stored" : "Independent sync ready"
        return try TaskifyWatchTransfer.encode(
            TaskifyWatchProvisioningReceipt(publicKeyHex: payload.publicKeyHex)
        )
    }

    private func apply(applicationContext: [String: Any]) {
        guard let data = applicationContext[TaskifyWatchTransfer.snapshotDataKey] as? Data,
              let received = try? TaskifyWatchTransfer.decodeConnectivitySnapshot(data) else { return }
        apply(snapshot: received)
    }

    private func apply(snapshot received: TaskifyWatchSnapshot) {
        // `generatedAt` is a cache timestamp, not a cross-device causal revision. A relay refresh
        // performed on Watch can legitimately have a later wall-clock time than an authoritative
        // iPhone snapshot that arrives afterward. Rejecting that phone state leaves the Watch
        // permanently stale until an even newer phone mutation occurs. Compare only against the
        // last phone projection instead, which still prevents delayed WatchConnectivity payloads
        // from rolling back a newer phone projection.
        guard received.generatedAt >= latestPhoneSnapshotGeneratedAt else { return }
        latestPhoneSnapshotGeneratedAt = received.generatedAt
        phoneSnapshotApplicationRevision += 1
        let applicationRevision = phoneSnapshotApplicationRevision
        snapshot = received
        if let projection = received.chatProjection {
            applyChatProjection(projection, applicationRevision: applicationRevision)
        }
        let acknowledged = Set(received.acknowledgedCommandIDs ?? [])
        if !acknowledged.isEmpty {
            let acknowledgedKinds = Set(
                pendingCommands.lazy
                    .filter { acknowledged.contains($0.id) }
                    .map(\.kind)
            )
            pendingCommands.removeAll { acknowledged.contains($0.id) }
            refreshPendingCompletionIDs()
            persistPendingCommands()
            if pendingCommands.isEmpty {
                statusMessage = acknowledgedKinds.contains(.createTask) ||
                    acknowledgedKinds.contains(.createVoiceTasks) ||
                    acknowledgedKinds.contains(.processVoiceTranscript)
                    ? "Task added"
                    : "Tasks are up to date"
            }
        }
        persistSnapshot()
    }

    /// Applies a phone chat projection through the store's merge path. Ongoing snapshots no
    /// longer carry projections; this now serves the on-demand chat directory reply (contacts,
    /// display metadata, routing, and phone-side tombstones).
    private func applyChatProjection(
        _ projection: TaskifyWatchChatProjection,
        applicationRevision: Int
    ) {
        guard projection.accountPublicKey == nil
            || projection.accountPublicKey == chatIdentityPublicKey else { return }
        let accountRevision = chatAccountRevision
        let savedContext = chatContext
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                if let savedContext {
                    _ = try await self.chatCoordinator.configure(savedContext)
                }
                let applied = try await self.chatCoordinator.applyProjection(projection)
                guard accountRevision == self.chatAccountRevision,
                      applicationRevision == self.phoneSnapshotApplicationRevision else { return }
                self.chatSnapshot = applied.snapshot
                if let updatedContext = applied.context,
                   updatedContext != self.chatContext {
                    self.chatContext = updatedContext
                    try self.persistChatContext()
                }
            } catch {
                // Retain the last durable Watch state; a later directory sync retries.
            }
        }
    }

    /// Applies a chat directory reply. The reply's snapshot carries tasks intentionally empty,
    /// so only its projection is consumed — applying the whole payload would blank the Watch's
    /// cached task list until the next task sync.
    private func applyChatDirectoryReply(_ reply: [String: Any]) {
        guard let data = reply[TaskifyWatchTransfer.snapshotDataKey] as? Data,
              let received = try? TaskifyWatchTransfer.decodeConnectivitySnapshot(data),
              let projection = received.chatProjection else { return }
        applyChatProjection(projection, applicationRevision: phoneSnapshotApplicationRevision)
    }

    private func loadIndependentProfile() {
        guard let data = try? Data(contentsOf: profileCacheURL),
              let profile = try? JSONDecoder().decode(TaskifyWatchIndependentProfile.self, from: data),
              profile.publicKeyHex.count == 64 else { return }
        independentProfile = profile
    }

    private func persistIndependentProfile() throws {
        guard let independentProfile else { return }
        try FileManager.default.createDirectory(
            at: profileCacheURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(independentProfile).write(
            to: profileCacheURL,
            options: [.atomic, .completeFileProtection]
        )
    }

    private func loadChatContext() {
        guard let data = try? Data(contentsOf: chatContextCacheURL),
              let context = try? JSONDecoder().decode(
                TaskifyWatchChatProvisioningContext.self,
                from: data
              ),
              context.pushRelayHTTPSURL.scheme?.lowercased() == "https" else { return }
        chatContext = context
    }

    private func persistChatContext() throws {
        guard let chatContext else { return }
        try FileManager.default.createDirectory(
            at: chatContextCacheURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(chatContext).write(
            to: chatContextCacheURL,
            options: [.atomic, .completeFileProtection]
        )
    }

    private func loadCachedSnapshot() {
        guard let data = try? Data(contentsOf: cacheURL),
              let cached = try? TaskifyWatchTransfer.decodeSnapshot(data) else { return }
        snapshot = cached
        persistWidgetSnapshot()
    }

    private func loadPendingCommands() {
        guard let data = try? Data(contentsOf: commandCacheURL),
              let cached = try? JSONDecoder().decode([TaskifyWatchCommand].self, from: data) else { return }
        let oldestRetainedDate = Date().addingTimeInterval(-30 * 24 * 60 * 60)
        pendingCommands = cached.filter { $0.createdAt >= oldestRetainedDate }
        refreshPendingCompletionIDs()
        persistPendingCommands()
    }

    private func refreshPendingCompletionIDs() {
        pendingCompletionIDs = Set(pendingCommands.compactMap { command in
            command.kind == .completeTask ? command.taskID : nil
        })
        persistWidgetSnapshot()
    }

    private func persistPendingCommands() {
        do {
            try FileManager.default.createDirectory(
                at: commandCacheURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try JSONEncoder().encode(pendingCommands).write(
                to: commandCacheURL,
                options: [.atomic, .completeFileProtection]
            )
        } catch {
            statusMessage = "A Watch change could not be saved for later delivery."
        }
    }

    @ObservationIgnored private var snapshotPersistTask: Task<Void, Never>?
    @ObservationIgnored private var hasPendingSnapshotWrite = false

    /// Coalesces the full-snapshot cache write. Relay refreshes and phone projections can
    /// land several snapshots in quick succession, and the encode is CPU work on the whole task
    /// list; writing once per burst keeps the main actor free. The widget snapshot is saved
    /// inline instead of at the end of the debounced task: watchOS suspends the app soon after
    /// the wrist drops, a suspended task never reaches the end of the debounce window, and
    /// WidgetKit would keep rendering the last snapshot it saw. A cache write lost to
    /// suspension still self-heals via the next relay refresh or phone projection, and
    /// `flushPendingSnapshotPersist` runs it at background time.
    private func persistSnapshot() {
        persistWidgetSnapshot()
        snapshotPersistTask?.cancel()
        hasPendingSnapshotWrite = true
        let encodedSnapshot = snapshot
        let url = cacheURL
        snapshotPersistTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.writeSnapshotCache(encodedSnapshot, url: url)
            self?.hasPendingSnapshotWrite = false
        }
    }

    /// Encodes off-main and writes the resumable snapshot cache. A failure surfaces through
    /// `statusMessage`; the widget snapshot above is independent of this write.
    private func writeSnapshotCache(_ encodedSnapshot: TaskifyWatchSnapshot, url: URL) async {
        let data = try? await Task.detached(priority: .utility) {
            try TaskifyWatchTransfer.encode(encodedSnapshot)
        }.value
        guard let data else {
            statusMessage = "Tasks are available, but the local cache could not be updated."
            return
        }
        writeSnapshotCacheData(data, url: url)
    }

    private func writeSnapshotCacheData(_ data: Data, url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(
                to: url,
                options: [.atomic, .completeFileProtection]
            )
        } catch {
            statusMessage = "Tasks are available, but the local cache could not be updated."
        }
    }

    /// Runs the debounced cache write now instead of letting suspension swallow it. Call
    /// before the app backgrounds; without this the on-disk snapshot can lag a whole session
    /// behind what the user just saw. Encodes synchronously — a deferred encode would hit the
    /// same suspension this exists to avoid.
    func flushPendingSnapshotPersist() {
        guard hasPendingSnapshotWrite else { return }
        hasPendingSnapshotWrite = false
        snapshotPersistTask?.cancel()
        snapshotPersistTask = nil
        guard let data = try? TaskifyWatchTransfer.encode(snapshot) else {
            statusMessage = "Tasks are available, but the local cache could not be updated."
            return
        }
        writeSnapshotCacheData(data, url: cacheURL)
    }

    private func persistWidgetSnapshot() {
        let widgetSnapshot = TaskifyWatchWidgetSnapshot(
            snapshot: snapshot,
            excludingTaskIDs: pendingCompletionIDs
        )
        guard TaskifyWatchWidgetCache.saveIfChanged(widgetSnapshot) else { return }
        reloadComplicationTimelines()
    }

    private func reloadComplicationTimelines() {
        for kind in TaskifyWatchWidgetCache.widgetKinds {
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        }
    }

    private func sessionSetupTransfers() -> [WCSessionUserInfoTransfer] {
        guard WCSession.isSupported() else { return [] }
        return WCSession.default.outstandingUserInfoTransfers.filter {
            TaskifyWatchTransfer.isSetupNavigationRequest($0.userInfo)
        }
    }
}

extension TaskifyWatchAppModel: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor [weak self] in
            if error != nil {
                self?.statusMessage = "The iPhone connection is unavailable. Cached tasks remain available."
            } else {
                self?.requestInitialSetupNavigation()
                self?.retryPendingCommands()
                await self?.requestLatestSnapshotFromPhone()
                self?.requestChatDirectoryFromPhone()
            }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else { return }
        Task { @MainActor [weak self] in
            self?.requestInitialSetupNavigation()
            self?.retryPendingCommands()
            await self?.requestLatestSnapshotFromPhone()
            self?.requestChatDirectoryFromPhone()
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessageData messageData: Data,
        replyHandler: @escaping (Data) -> Void
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                replyHandler(try self.acceptProvisioning(messageData))
            } catch {
                self.statusMessage = error.localizedDescription
                let receipt = TaskifyWatchProvisioningReceipt(
                    publicKeyHex: "",
                    errorMessage: error.localizedDescription
                )
                replyHandler((try? TaskifyWatchTransfer.encode(receipt)) ?? Data())
            }
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        if let readUpdate = TaskifyWatchTransfer.chatReadUpdate(from: message) {
            Task { @MainActor [weak self] in
                guard let self else {
                    replyHandler([:])
                    return
                }
                await self.applyChatReadFromPhone(readUpdate)
                replyHandler([:])
            }
            return
        }
        guard TaskifyWatchTransfer.isProvisioningStatusRequest(message) else {
            replyHandler([:])
            return
        }
        Task { @MainActor [weak self] in
            guard let self,
                  self.isProvisioned,
                  let privateKey = try? self.identityStore.load(),
                  let publicKey = try? TaskifyWatchNostrCrypto.publicKeyHex(for: privateKey) else {
                replyHandler([:])
                return
            }
            replyHandler(TaskifyWatchTransfer.provisioningStatusResponse(publicKeyHex: publicKey))
        }
    }

    /// Read updates queued while the Watch was unreachable arrive here after activation.
    nonisolated func session(
        _ session: WCSession,
        didReceiveUserInfo userInfo: [String: Any] = [:]
    ) {
        guard let readUpdate = TaskifyWatchTransfer.chatReadUpdate(from: userInfo) else { return }
        Task { @MainActor [weak self] in
            await self?.applyChatReadFromPhone(readUpdate)
        }
    }

    /// Applies a read position the iPhone user set. Recording it as already-sent keeps the
    /// Watch from echoing the phone's own read back through its outbound read sync.
    @MainActor
    private func applyChatReadFromPhone(_ readUpdate: (conversationID: String, timestamp: Int)) async {
        let existing = lastSentChatReadThrough[readUpdate.conversationID] ?? 0
        lastSentChatReadThrough[readUpdate.conversationID] = max(existing, readUpdate.timestamp)
        chatSnapshot = (try? await chatCoordinator.markRead(
            conversationID: readUpdate.conversationID,
            through: readUpdate.timestamp
        )) ?? chatSnapshot
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        Task { @MainActor [weak self] in
            self?.apply(applicationContext: applicationContext)
        }
    }
}

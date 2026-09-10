import Foundation
import TaskifyWatchShared

actor TaskifyWatchChatStore {
    private let fileURL: URL
    private var value: TaskifyWatchChatSnapshot
    private var needsProtectedCacheReload = false
    /// The Watch identity, reported by every path that holds the private key. Locally rebuilt
    /// summaries need it to tell inbound messages from the Watch's own sends when counting
    /// unread badges.
    private var identityPublicKey: String?

    init(fileURL: URL) {
        self.fileURL = fileURL
        value = TaskifyWatchChatSnapshot()
        do {
            value = try Self.readSnapshot(from: fileURL)
        } catch CocoaError.fileReadNoSuchFile {
            // A fresh installation has no cache yet.
        } catch {
            // Locked or unreadable is not empty. Do not overwrite this file with launch-time
            // placeholders; retry reading it when protected storage becomes available.
            needsProtectedCacheReload = true
        }
    }

    private static func readSnapshot(from fileURL: URL) throws -> TaskifyWatchChatSnapshot {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let data = try Data(contentsOf: fileURL)
        let decoded = try decoder.decode(TaskifyWatchChatSnapshot.self, from: data)
        guard decoded.schemaVersion <= TaskifyWatchChatSnapshot.currentSchemaVersion else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return decoded
    }

    private func reloadProtectedCacheIfNeeded() throws {
        guard needsProtectedCacheReload else { return }
        value = try Self.readSnapshot(from: fileURL)
        needsProtectedCacheReload = false
    }

    func snapshot() -> TaskifyWatchChatSnapshot {
        try? reloadProtectedCacheIfNeeded()
        return value
    }

    func noteIdentity(_ publicKeyHex: String) {
        identityPublicKey = publicKeyHex.lowercased()
    }

    func applyProvisioning(_ context: TaskifyWatchChatProvisioningContext) throws {
        try reloadProtectedCacheIfNeeded()
        let previous = value
        mergeContacts(context.contacts, replacing: true)
        if let summaries = context.threadSummaries {
            for summary in summaries {
                if let group = summary.group { upsertGroup(group) }
                mergeProjectedReadState(summary)
            }
            mergeThreadSummaries(summaries)
        }
        value.threadSummaries = rebuildSummaries()
        guard value != previous else { return }
        value.generatedAt = Date()
        try persist()
    }

    func applyProjection(_ projection: TaskifyWatchChatProjection) throws {
        try reloadProtectedCacheIfNeeded()
        let previous = value
        if let accountPublicKey = projection.accountPublicKey {
            identityPublicKey = accountPublicKey.lowercased()
        }
        if let contacts = projection.contacts {
            mergeContacts(
                contacts,
                replacing: projection.contactDirectoryIsComplete == true
            )
        }
        if !projection.threads.isEmpty {
            for summary in projection.threads {
                if let group = summary.group { upsertGroup(group) }
                mergeProjectedReadState(summary)
            }
            mergeThreadSummaries(projection.threads)
        }
        // Tombstones are applied last so they win over any stale thread entry the same
        // projection still carries.
        applyTombstones(
            deletedConversationIDs: projection.deletedConversationIDs ?? [],
            blockedPublicKeys: projection.blockedPublicKeys ?? []
        )
        value.threadSummaries = rebuildSummaries()
        // The iPhone stamps a fresh generatedAt into every projection it sends, so content
        // equality is the only convergence test available here. Without it, every applied
        // phone snapshot bumped this store's generatedAt, which the open conversation view
        // treated as fresh content and answered with another read update to the phone --
        // a snapshot ping-pong loop that ran for as long as both screens sat idle.
        guard value != previous else { return }
        value.generatedAt = projection.generatedAt
        try persist()
    }

    /// Merges phone-supplied summaries into the store without replacing Watch-local ones. The
    /// phone wins only for metadata the Watch cannot derive itself (contact display names,
    /// avatars, group titles, request state); previews, activity, unread counts, and read
    /// positions are re-derived from the Watch's own cache during rebuild.
    private func mergeThreadSummaries(_ incoming: [TaskifyWatchChatThreadSummary]) {
        guard !incoming.isEmpty else { return }
        var byID = (value.threadSummaries ?? []).reduce(
            into: [String: TaskifyWatchChatThreadSummary]()
        ) { $0[$1.id] = $1 }
        for summary in incoming {
            if let group = summary.group { upsertGroup(group) }
            if let readThrough = summary.readThrough {
                value.readAt[summary.id] = max(value.readAt[summary.id] ?? 0, readThrough)
            }
            guard let current = byID[summary.id] else {
                byID[summary.id] = summary
                continue
            }
            let phoneActivityIsNewer = summary.latestActivityAt > current.latestActivityAt
            byID[summary.id] = TaskifyWatchChatThreadSummary(
                conversationID: summary.conversationID,
                memberPublicKeys: summary.memberPublicKeys,
                displayName: summary.displayName,
                latestPreview: phoneActivityIsNewer ? summary.latestPreview : current.latestPreview,
                latestActivityAt: max(current.latestActivityAt, summary.latestActivityAt),
                readThrough: [current.readThrough, summary.readThrough].compactMap({ $0 }).max(),
                unreadCount: current.unreadCount,
                isRequest: summary.isRequest,
                avatarURL: summary.avatarURL ?? current.avatarURL,
                group: summary.group ?? current.group
            ) ?? current
        }
        value.threadSummaries = Array(byID.values)
    }

    /// Rebuilds every thread summary from the Watch's own durable state. The Watch cache is the
    /// thread-list authority between directory syncs, so this runs after every mutation that
    /// can change a thread: messages pruned away leave a summary-only thread, and threads that
    /// only exist on the phone appear once a directory projection merges their metadata.
    private func rebuildSummaries() -> [TaskifyWatchChatThreadSummary] {
        let identity = identityPublicKey ?? ""
        let phoneByID = (value.threadSummaries ?? []).reduce(
            into: [String: TaskifyWatchChatThreadSummary]()
        ) { $0[$1.id] = $1 }
        let messagesByConversation = Dictionary(grouping: value.messages, by: \.conversationID)
        let groupsByID = value.groups.reduce(
            into: [String: TaskifyWatchGroupConversation]()
        ) { $0[$1.groupID] = $1 }
        let contactsByPublicKey = value.contacts.reduce(
            into: [String: TaskifyWatchContact]()
        ) { $0[$1.publicKey] = $1 }
        var conversationIDs = Set(messagesByConversation.keys)
        conversationIDs.formUnion(phoneByID.keys)
        let merged = conversationIDs.compactMap { conversationID -> TaskifyWatchChatThreadSummary? in
            let messages = messagesByConversation[conversationID] ?? []
            let latest = messages.max {
                if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                return $0.rumorID < $1.rumorID
            }
            let phone = phoneByID[conversationID]
            let group = groupsByID[conversationID]
            guard let members = group?.memberPublicKeys
                    ?? latest?.memberPublicKeys
                    ?? phone?.memberPublicKeys else { return nil }
            let peers = members.filter { $0 != identity }
            let readAt = value.readAt[conversationID] ?? 0
            let latestActivityAt = max(
                latest?.createdAt ?? 0,
                phone?.latestActivityAt ?? 0,
                group?.createdAt ?? 0
            )
            let preview: String
            if let latest, latest.createdAt >= (phone?.latestActivityAt ?? 0) {
                preview = TaskifyWatchChatIndex.chatPreview(for: latest)
            } else if let phone, !phone.latestPreview.isEmpty {
                preview = phone.latestPreview
            } else if let latest {
                preview = TaskifyWatchChatIndex.chatPreview(for: latest)
            } else {
                preview = "Start a message"
            }
            // Contact names outrank summary names for 1:1 threads: the phone derives its DM
            // names from the same contact directory, and contact-first lets a renamed contact
            // replace a name the Watch derived when the peer was still unknown. Generic phone
            // placeholders never shadow the Watch's own short-key label.
            let phoneName: String?
            if let phone, !["Unknown sender", "Conversation"].contains(phone.displayName) {
                phoneName = phone.displayName
            } else {
                phoneName = nil
            }
            let displayName: String
            if let group {
                displayName = group.displayName
            } else if members.count <= 2, let peer = peers.first {
                displayName = contactsByPublicKey[peer]?.displayName
                    ?? phoneName
                    ?? TaskifyWatchChatIndex.shortPublicKey(peer)
            } else {
                displayName = phoneName ?? "Group"
            }
            let isGroup = group != nil || phone?.isGroup == true || members.count > 2
            let unread: Int
            if messages.isEmpty {
                // Summary-only thread (messages pruned): the phone's count is the only signal,
                // and it is already read when the read position covers the latest activity.
                unread = readAt >= latestActivityAt ? 0 : (phone?.unreadCount ?? 0)
            } else {
                unread = messages.filter {
                    $0.senderPublicKey != identity && $0.createdAt > readAt
                }.count
            }
            return TaskifyWatchChatThreadSummary(
                conversationID: conversationID,
                memberPublicKeys: members,
                displayName: displayName,
                latestPreview: preview,
                latestActivityAt: latestActivityAt,
                readThrough: readAt > 0 ? readAt : nil,
                unreadCount: unread,
                isRequest: phone?.isRequest
                    ?? (!isGroup && peers.contains { contactsByPublicKey[$0] == nil }),
                avatarURL: phone?.avatarURL ?? peers.first.flatMap { contactsByPublicKey[$0]?.avatarURL },
                group: group
            )
        }
        return Array(merged.sorted {
            if $0.latestActivityAt != $1.latestActivityAt {
                return $0.latestActivityAt > $1.latestActivityAt
            }
            return $0.id < $1.id
        }.prefix(TaskifyWatchChatProjection.maximumThreadCount))
    }

    /// Applies phone-side tombstones carried by a directory projection. Without ongoing
    /// projections this is the only path a thread deleted or a peer blocked on iPhone has to
    /// the Watch cache; it mirrors `deleteConversation`/`block` including the dedupe ledger
    /// entries that stop a later relay replay from resurrecting the rows.
    private func applyTombstones(
        deletedConversationIDs: [String],
        blockedPublicKeys: [String]
    ) {
        guard !deletedConversationIDs.isEmpty || !blockedPublicKeys.isEmpty else { return }
        for conversationID in deletedConversationIDs {
            let normalized = conversationID.lowercased()
            let removedMessages = value.messages.filter { $0.conversationID == normalized }
            let removedOutbox = value.outbox.filter { $0.conversationID == normalized }
            guard !removedMessages.isEmpty || !removedOutbox.isEmpty
                    || value.threadSummaries?.contains(where: { $0.id == normalized }) == true else {
                continue
            }
            value.processedRumorIDs.append(contentsOf: removedMessages.map(\.rumorID))
            value.processedRumorIDs.append(contentsOf: removedOutbox.map(\.rumorID))
            value.processedWrapIDs.append(contentsOf: removedMessages.map(\.wrapID))
            value.processedWrapIDs.append(
                contentsOf: removedOutbox.flatMap { $0.wraps.map(\.event.id) }
            )
            value.messages.removeAll { $0.conversationID == normalized }
            value.outbox.removeAll { $0.conversationID == normalized }
            value.threadSummaries?.removeAll { $0.conversationID == normalized }
            value.readAt.removeValue(forKey: normalized)
        }
        for publicKey in blockedPublicKeys {
            let normalized = publicKey.lowercased()
            if !value.blockedPublicKeys.contains(normalized) {
                value.blockedPublicKeys.append(normalized)
            }
            value.messages.removeAll { $0.senderPublicKey == normalized }
            value.threadSummaries?.removeAll { !$0.isGroup && $0.conversationID == normalized }
        }
    }

    private func mergeContacts(
        _ contacts: [TaskifyWatchContact],
        replacing: Bool
    ) {
        // Reduce instead of Dictionary(uniqueKeysWithValues:) so a malformed/legacy cache with a
        // duplicate key cannot crash the Watch process while applying a valid projection.
        let existing = value.contacts.reduce(into: [String: TaskifyWatchContact]()) {
            $0[$1.publicKey] = $1
        }
        var updated: [String: TaskifyWatchContact] = replacing ? [:] : existing
        for contact in contacts where contact.publicKey.count == 64
            && contact.publicKey.allSatisfy(\.isHexDigit) {
            let previous = existing[contact.publicKey]
            updated[contact.publicKey] = TaskifyWatchContact(
                publicKey: contact.publicKey,
                npub: contact.npub,
                displayName: contact.displayName,
                avatarURL: contact.avatarURL,
                discoveryRelayURLs: contact.discoveryRelayURLs,
                inboxPreferenceEvent: contact.inboxPreferenceEvent ?? previous?.inboxPreferenceEvent,
                confirmedAbsentAt: contact.confirmedAbsentAt ?? previous?.confirmedAbsentAt
            )
        }
        value.contacts = updated.values.sorted {
            let comparison = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
            return comparison == .orderedSame
                ? $0.publicKey < $1.publicKey
                : comparison == .orderedAscending
        }
    }

    func updateContactPreference(
        publicKey: String,
        event: TaskifyWatchNostrEvent?,
        confirmedAbsentAt: Date?
    ) throws {
        guard let index = value.contacts.firstIndex(where: { $0.publicKey == publicKey.lowercased() }) else {
            return
        }
        let current = value.contacts[index]
        value.contacts[index] = TaskifyWatchContact(
            publicKey: current.publicKey,
            npub: current.npub,
            displayName: current.displayName,
            avatarURL: current.avatarURL,
            discoveryRelayURLs: current.discoveryRelayURLs,
            inboxPreferenceEvent: event,
            confirmedAbsentAt: confirmedAbsentAt
        )
        value.generatedAt = Date()
        try persist()
    }

    @discardableResult
    func ingest(
        wraps: [TaskifyWatchNostrEvent],
        cursor: String,
        privateKey: Data
    ) throws -> Int {
        try reloadProtectedCacheIfNeeded()
        let identity = try TaskifyWatchNostrCrypto.publicKeyHex(for: privateKey)
        identityPublicKey = identity
        let previous = value
        var processedRumors = value.processedRumorIDs
        var processedWraps = value.processedWrapIDs
        var existingRumors = Set(processedRumors + value.messages.map(\.rumorID))
        var existingWraps = Set(processedWraps + value.messages.map(\.wrapID))
        var inserted = 0
        for wrap in wraps {
            guard existingWraps.insert(wrap.id).inserted else { continue }
            processedWraps.append(wrap.id)
            guard let decrypted = try? TaskifyWatchNIP17.unwrap(
                    wrap,
                    recipientPrivateKey: privateKey
                  ),
                  existingRumors.insert(decrypted.rumor.id).inserted,
                  !value.blockedPublicKeys.contains(decrypted.rumor.publicKey.lowercased()),
                  let message = try? TaskifyWatchNIP17.chatMessage(
                    from: decrypted,
                    identityPublicKey: identity
                  ) else { continue }
            processedRumors.append(decrypted.rumor.id)
            value.messages.append(message)
            inserted += 1
            upsertGroupIfNeeded(rumor: decrypted.rumor, message: message)
        }
        value.processedWrapIDs = processedWraps
        value.processedRumorIDs = processedRumors
        value.cursor = cursor
        prune()
        value.threadSummaries = rebuildSummaries()
        // A cursor advance or prune with no new message is bookkeeping, not user-visible
        // content: persist it, but leave generatedAt alone so a refresh that found nothing
        // still looks unchanged to the conversation view's onChange.
        guard value != previous else { return inserted }
        if inserted > 0 {
            value.generatedAt = Date()
        }
        do {
            try persist()
        } catch {
            // In-memory cursors must never outrun durable messages (e.g. the Watch locks
            // between decrypting a page and saving it). Retry this page on the next wake.
            value = previous
            throw error
        }
        return inserted
    }

    func enqueue(
        message: TaskifyWatchChatMessage,
        outbox: TaskifyWatchChatOutboxEntry,
        group: TaskifyWatchGroupConversation?
    ) throws {
        if !value.messages.contains(where: { $0.rumorID == message.rumorID }) {
            value.messages.append(message)
        }
        if !value.outbox.contains(where: { $0.rumorID == outbox.rumorID }) {
            value.outbox.append(outbox)
        }
        value.processedRumorIDs.append(message.rumorID)
        value.processedWrapIDs.append(contentsOf: outbox.wraps.map(\.event.id))
        if let group { upsertGroup(group) }
        prune()
        value.threadSummaries = rebuildSummaries()
        value.generatedAt = Date()
        try persist()
    }

    func replaceOutboxEntry(_ entry: TaskifyWatchChatOutboxEntry) throws {
        try replaceOutboxEntries([entry])
    }

    /// Batched counterpart to `replaceOutboxEntry`: applies every entry, prunes once, and
    /// persists once. Each individual replace re-encodes the whole store, so a flush draining a
    /// queue of undelivered messages used to pay that cost once per entry.
    func replaceOutboxEntries(_ entries: [TaskifyWatchChatOutboxEntry]) throws {
        guard !entries.isEmpty else { return }
        for entry in entries {
            if let index = value.outbox.firstIndex(where: { $0.rumorID == entry.rumorID }) {
                value.outbox[index] = entry
            } else {
                value.outbox.append(entry)
            }
            if let messageIndex = value.messages.firstIndex(where: { $0.rumorID == entry.rumorID }) {
                value.messages[messageIndex].deliveryState = entry.deliveryState
            }
        }
        prune()
        value.generatedAt = Date()
        try persist()
    }

    @discardableResult
    func renewOutboxEntry(_ rumorID: String) throws -> Bool {
        let normalized = rumorID.lowercased()
        guard let index = value.outbox.firstIndex(where: { $0.rumorID == normalized }) else {
            return false
        }
        let previous = value.outbox[index]
        var wraps = previous.wraps
        for wrapIndex in wraps.indices where !wraps[wrapIndex].isDelivered {
            // Preserve the immutable signed gift wrap, but rediscover current relay preferences
            // and discard stale rejection/AUTH state from the expired attempt window.
            wraps[wrapIndex].routingDecision = TaskifyWatchRelayDecision(status: .indeterminate)
            wraps[wrapIndex].acknowledgements = []
            wraps[wrapIndex].attempts = 0
            wraps[wrapIndex].nextAttemptAt = Date()
        }
        let renewed = TaskifyWatchChatOutboxEntry(
            rumorID: previous.rumorID,
            conversationID: previous.conversationID,
            wraps: wraps,
            senderPublicKey: previous.senderPublicKey,
            createdAt: previous.createdAt,
            expiresAt: Date().addingTimeInterval(48 * 60 * 60)
        )
        value.outbox[index] = renewed
        if let messageIndex = value.messages.firstIndex(where: { $0.rumorID == normalized }) {
            value.messages[messageIndex].deliveryState = renewed.deliveryState
        }
        value.generatedAt = Date()
        try persist()
        return true
    }

    func markRead(conversationID: String, at timestamp: Int = Int(Date().timeIntervalSince1970)) throws {
        let normalized = conversationID.lowercased()
        let previous = value
        value.readAt[normalized] = max(value.readAt[normalized] ?? 0, timestamp)
        value.threadSummaries = rebuildSummaries()
        // Re-marking an already-read position is a no-op: it must not bump generatedAt or
        // rewrite the store, or the conversation view re-arms its own read sync each time.
        guard value != previous else { return }
        value.generatedAt = Date()
        try persist()
    }

    func setGroup(_ group: TaskifyWatchGroupConversation) throws {
        upsertGroup(group)
        try persist()
    }

    func block(publicKey: String) throws {
        let normalized = publicKey.lowercased()
        if !value.blockedPublicKeys.contains(normalized) {
            value.blockedPublicKeys.append(normalized)
        }
        let removed = value.messages.filter { $0.senderPublicKey == normalized }
        value.processedRumorIDs.append(contentsOf: removed.map(\.rumorID))
        value.processedWrapIDs.append(contentsOf: removed.map(\.wrapID))
        value.messages.removeAll { $0.senderPublicKey == normalized }
        value.threadSummaries?.removeAll { !$0.isGroup && $0.conversationID == normalized }
        prune()
        value.threadSummaries = rebuildSummaries()
        try persist()
    }

    func deleteConversation(_ conversationID: String) throws {
        let normalized = conversationID.lowercased()
        let removedMessages = value.messages.filter { $0.conversationID == normalized }
        let removedOutbox = value.outbox.filter { $0.conversationID == normalized }
        value.processedRumorIDs.append(contentsOf: removedMessages.map(\.rumorID))
        value.processedRumorIDs.append(contentsOf: removedOutbox.map(\.rumorID))
        value.processedWrapIDs.append(contentsOf: removedMessages.map(\.wrapID))
        value.processedWrapIDs.append(
            contentsOf: removedOutbox.flatMap { $0.wraps.map(\.event.id) }
        )
        value.messages.removeAll { $0.conversationID == normalized }
        value.outbox.removeAll { $0.conversationID == normalized }
        value.threadSummaries?.removeAll { $0.conversationID == normalized }
        value.readAt.removeValue(forKey: normalized)
        prune()
        value.threadSummaries = rebuildSummaries()
        value.generatedAt = Date()
        try persist()
    }

    func clearMessages() throws {
        value.processedRumorIDs.append(contentsOf: value.messages.map(\.rumorID))
        value.processedRumorIDs.append(contentsOf: value.outbox.map(\.rumorID))
        value.processedWrapIDs.append(contentsOf: value.messages.map(\.wrapID))
        value.processedWrapIDs.append(
            contentsOf: value.outbox.flatMap { $0.wraps.map(\.event.id) }
        )
        value.groups = (value.threadSummaries ?? []).compactMap(\.group)
        value.messages = []
        value.outbox = []
        value.readAt = [:]
        value.blockedPublicKeys = []
        prune()
        value.generatedAt = Date()
        try persist()
    }

    func clear() throws {
        let previous = value
        let wasWaitingForProtectedCache = needsProtectedCacheReload
        value = TaskifyWatchChatSnapshot()
        // Explicit account reset may replace a corrupt cache, but still requires writable
        // protected storage. A failed reset must not silently discard the in-memory state.
        needsProtectedCacheReload = false
        do {
            try persist()
        } catch {
            value = previous
            needsProtectedCacheReload = wasWaitingForProtectedCache
            throw error
        }
    }

    private func upsertGroupIfNeeded(
        rumor: TaskifyWatchNIP17Rumor,
        message: TaskifyWatchChatMessage
    ) {
        guard rumor.recipientPublicKeys.count >= 2 else { return }
        let subject = rumor.tags.first { $0.count >= 2 && $0[0] == "subject" }?[1] ?? ""
        guard let group = TaskifyWatchGroupConversation(
            name: subject,
            memberPublicKeys: message.memberPublicKeys,
            createdAt: rumor.createdAt,
            nameUpdatedAt: subject.isEmpty ? nil : rumor.createdAt
        ) else { return }
        upsertGroup(group)
    }

    private func upsertGroup(_ group: TaskifyWatchGroupConversation) {
        guard let index = value.groups.firstIndex(where: { $0.groupID == group.groupID }) else {
            value.groups.append(group)
            return
        }
        let current = value.groups[index]
        guard (group.nameUpdatedAt ?? 0) >= (current.nameUpdatedAt ?? 0) else { return }
        value.groups[index] = TaskifyWatchGroupConversation(
            name: group.name,
            memberPublicKeys: group.memberPublicKeys,
            createdAt: min(group.createdAt, current.createdAt),
            nameUpdatedAt: group.nameUpdatedAt,
            isMuted: current.isMuted,
            isLeft: current.isLeft
        ) ?? current
    }

    private func mergeProjectedReadState(_ summary: TaskifyWatchChatThreadSummary) {
        guard let readThrough = summary.readThrough else { return }
        value.readAt[summary.id] = max(value.readAt[summary.id] ?? 0, readThrough)
    }

    private func prune(now: Date = Date()) {
        let cutoff = Int(now.addingTimeInterval(-30 * 24 * 60 * 60).timeIntervalSince1970)
        value.messages = Array(
            value.messages
                .filter { $0.createdAt >= cutoff }
                .sorted {
                    if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                    return $0.rumorID < $1.rumorID
                }
                .suffix(500)
        )
        value.outbox = Array(value.outbox
            .filter { $0.expiresAt > now || $0.deliveryState != .sent }
            .suffix(100))
        value.processedWrapIDs = boundedUniqueSuffix(
            value.processedWrapIDs + value.messages.map(\.wrapID),
            limit: 2_000
        )
        value.processedRumorIDs = boundedUniqueSuffix(
            value.processedRumorIDs + value.messages.map(\.rumorID),
            limit: 2_000
        )
    }

    private func boundedUniqueSuffix(_ values: [String], limit: Int) -> [String] {
        var seen = Set<String>()
        var newestFirst: [String] = []
        for value in values.reversed() {
            let normalized = value.lowercased()
            guard seen.insert(normalized).inserted else { continue }
            newestFirst.append(normalized)
            if newestFirst.count == limit { break }
        }
        return newestFirst.reversed()
    }

    private func persist() throws {
        guard !needsProtectedCacheReload else { throw CocoaError(.fileReadNoPermission) }
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let data = try encoder.encode(value)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}

enum TaskifyWatchChatCoordinatorError: LocalizedError {
    case notConfigured
    case invalidConversation
    case routingUnavailable

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Open Taskify on iPhone once to finish Watch chat setup."
        case .invalidConversation: "This conversation cannot be sent from Apple Watch."
        case .routingUnavailable: "A recipient's published inbox relay list is temporarily unavailable."
        }
    }
}

actor TaskifyWatchChatCoordinator {
    private static let preferenceFreshnessSeconds: TimeInterval = 6 * 60 * 60
    /// Steady-state refresh: a handful of pages covers live traffic since the stored cursor.
    private static let maximumPageCount = 5
    /// Bootstrap refresh (no stored cursor): page the gateway's whole 30-day retained inbox so
    /// the Watch cache is complete before its first paint. Bounded by page count and wall
    /// clock; whatever remains continues on the next refresh because the cursor advances per
    /// page and persists.
    private static let bootstrapMaximumPageCount = 25
    /// Pages ingested per store checkpoint during a refresh. Each ingest prunes, rebuilds
    /// summaries and re-encodes the whole store; batching pages cuts that cost while keeping an
    /// interrupted bootstrap's re-download bounded to one checkpoint group.
    private static let ingestCheckpointPageCount = 4
    private let store: TaskifyWatchChatStore
    private var gateway: TaskifyWatchChatGatewayClient?
    private let session: URLSession
    private var context: TaskifyWatchChatProvisioningContext?
    private var latestProjectionGeneratedAt = Date.distantPast
    private var relayDecisionCache = TaskifyWatchRelayDecisionCache()
    private var outboxFlushTask: Task<Void, Error>?
    /// Wall-clock budget for a bootstrap pull. Injectable so tests can exercise the bound
    /// without waiting 20 real seconds.
    private let bootstrapWallClockSeconds: TimeInterval

    init(
        fileURL: URL,
        session: URLSession = .shared,
        bootstrapWallClockSeconds: TimeInterval = 20
    ) {
        store = TaskifyWatchChatStore(fileURL: fileURL)
        self.session = session
        self.bootstrapWallClockSeconds = bootstrapWallClockSeconds
    }

    func configure(_ context: TaskifyWatchChatProvisioningContext) async throws -> TaskifyWatchChatSnapshot {
        // A saved provisioning context becomes visible to SwiftUI before the actor's launch-time
        // configuration task necessarily runs. Make configuration idempotent so every entry
        // point can cheaply close that race instead of failing an otherwise valid first send.
        if self.context == context, gateway != nil {
            return await store.snapshot()
        }
        let configuredGateway = try TaskifyWatchChatGatewayClient(
            baseURL: context.pushRelayHTTPSURL, session: session
        )
        try await store.applyProvisioning(context)
        relayDecisionCache = TaskifyWatchRelayDecisionCache()
        gateway = configuredGateway
        self.context = context
        return await store.snapshot()
    }

    func snapshot() async -> TaskifyWatchChatSnapshot { await store.snapshot() }

    func applyProjection(
        _ projection: TaskifyWatchChatProjection
    ) async throws -> (
        snapshot: TaskifyWatchChatSnapshot,
        context: TaskifyWatchChatProvisioningContext?
    ) {
        guard projection.generatedAt >= latestProjectionGeneratedAt else {
            return (await store.snapshot(), context)
        }
        latestProjectionGeneratedAt = projection.generatedAt
        // Apply first so a size-trimmed projection is merged with the Watch's existing directory
        // before we persist the provisioning context. Saving projection.contacts directly would
        // make the next launch treat a partial directory as complete and erase older contacts.
        try await store.applyProjection(projection)
        let projectedSnapshot = await store.snapshot()
        if let current = context {
            // The saved context's thread summaries stay the provisioning-time bootstrap list.
            // Persisting every projection's threads here used to make the next launch treat a
            // phone-shaped summary list as durable Watch state; the store now owns the live
            // thread list and merges display metadata instead.
            let updated = TaskifyWatchChatProvisioningContext(
                contacts: projection.contacts == nil
                    ? current.contacts
                    : projectedSnapshot.contacts,
                threadSummaries: projectedSnapshot.threadSummaries ?? [],
                discoveryRelayURLs: projection.discoveryRelayURLs
                    ?? current.discoveryRelayURLs,
                accountInboxPreferenceEvent: current.accountInboxPreferenceEvent,
                pushRelayHTTPSURL: projection.pushRelayHTTPSURL
                    ?? current.pushRelayHTTPSURL,
                pushRelayWSSURL: projection.pushRelayWSSURL
                    ?? current.pushRelayWSSURL
            )
            if updated.pushRelayHTTPSURL != current.pushRelayHTTPSURL {
                gateway = try TaskifyWatchChatGatewayClient(
                    baseURL: updated.pushRelayHTTPSURL, session: session
                )
            }
            context = updated
        }
        return (projectedSnapshot, context)
    }

    func refreshInbox(
        privateKey: Data,
        backgroundDeadline: ContinuousClock.Instant? = nil
    ) async throws -> TaskifyWatchChatSnapshot {
        guard let gateway else { throw TaskifyWatchChatCoordinatorError.notConfigured }
        // Keep the notification path narrowly focused on the inbox. Relay discovery and durable
        // outbox retries can consume most of watchOS's 30-second background execution window and
        // previously prevented an otherwise delivered push from fetching its incoming message.
        var current = await store.snapshot()
        var cursor = current.cursor
        let isBootstrap = cursor == nil
        let maximumPages = backgroundDeadline != nil ? 10 : (isBootstrap
            ? Self.bootstrapMaximumPageCount
            : Self.maximumPageCount)
        let bootstrapDeadline = isBootstrap
            ? Date().addingTimeInterval(bootstrapWallClockSeconds)
            : nil
        // Batch page ingestion: every store.ingest prunes, rebuilds summaries and re-encodes the
        // whole store, so per-page ingestion made a bootstrap pay that up to 25 times. Pages
        // accumulate and are checkpointed in groups — and always at the end — so an interrupted
        // bootstrap loses at most one group of un-ingested pages, which the wrap-level dedupe
        // re-downloads on the next attempt.
        var pendingWraps: [TaskifyWatchNostrEvent] = []
        var pagesSinceCheckpoint = 0
        func checkpoint() async throws {
            // An empty page still advances the cursor; a no-change ingest persists nothing, so
            // re-checkpointing after a break is free.
            guard let cursor else { return }
            _ = try await store.ingest(wraps: pendingWraps, cursor: cursor, privateKey: privateKey)
            pendingWraps.removeAll()
        }

        for _ in 0..<maximumPages {
            let page: TaskifyWatchInboxPage
            do {
                try Task.checkCancellation()
                if let backgroundDeadline, ContinuousClock.now >= backgroundDeadline { break }
                let requestDeadline = backgroundDeadline.map {
                    min($0, ContinuousClock.now.advanced(by: .seconds(8)))
                }
                page = try await gateway.queryInbox(
                    cursor: cursor,
                    limit: backgroundDeadline == nil ? 100 : 20,
                    privateKey: privateKey,
                    deadline: requestDeadline
                )
            } catch {
                // Foreground batching must retain earlier pages if a later fetch fails or
                // is cancelled. Never advance the cursor for the request that failed.
                if pagesSinceCheckpoint > 0 { try await checkpoint() }
                throw error
            }
            pendingWraps.append(contentsOf: page.events)
            cursor = page.cursor
            pagesSinceCheckpoint += 1
            // Small background pages are decrypted and saved immediately. Once fetched,
            // finish this checkpoint even if cancellation arrived with the response.
            if backgroundDeadline != nil || pagesSinceCheckpoint >= Self.ingestCheckpointPageCount {
                try await checkpoint()
                pagesSinceCheckpoint = 0
            }
            if !page.hasMore { break }
            if let bootstrapDeadline, Date() >= bootstrapDeadline { break }
        }
        try await checkpoint()
        current = await store.snapshot()
        return current
    }

    func retryOutbox(privateKey: Data) async throws -> TaskifyWatchChatSnapshot {
        try await flushOutbox(privateKey: privateKey)
        return await store.snapshot()
    }

    func retryMessage(
        rumorID: String,
        privateKey: Data
    ) async throws -> TaskifyWatchChatSnapshot {
        guard try await store.renewOutboxEntry(rumorID) else {
            throw TaskifyWatchChatCoordinatorError.invalidConversation
        }
        try await flushOutbox(privateKey: privateKey)
        return await store.snapshot()
    }

    func send(
        content: String,
        memberPublicKeys: [String],
        subject: String? = nil,
        replyToRumorID: String? = nil,
        reactionToRumorID: String? = nil,
        privateKey: Data
    ) async throws -> TaskifyWatchChatSnapshot {
        guard context != nil, gateway != nil else {
            throw TaskifyWatchChatCoordinatorError.notConfigured
        }
        let identity = try TaskifyWatchNostrCrypto.publicKeyHex(for: privateKey)
        await store.noteIdentity(identity)
        let members = Array(Set(memberPublicKeys.map { $0.lowercased() } + [identity])).sorted()
        guard (2...TaskifyWatchGroupConversation.maximumMemberCount).contains(members.count) else {
            throw TaskifyWatchChatCoordinatorError.invalidConversation
        }
        let set = try TaskifyWatchNIP17.createEnvelopeSet(
            content: content,
            senderPrivateKey: privateKey,
            memberPublicKeys: members,
            subject: subject,
            replyToRumorID: replyToRumorID,
            reactionToRumorID: reactionToRumorID,
            kind: reactionToRumorID == nil
                ? TaskifyWatchNIP17.textKind
                : TaskifyWatchNIP17.reactionKind
        )
        // Persist the complete encrypted envelope set before doing any network discovery. A
        // Watch app can be suspended moments after text input closes; resolving every member
        // first left no durable record to retry if that happened. `flushOutbox` resolves these
        // indeterminate routes recipient-first from the saved entry.
        let outboxWraps = set.wraps.map { wrap in
            TaskifyWatchOutboxWrap(
                recipientPublicKey: wrap.recipientPublicKey,
                event: wrap.event,
                routingDecision: TaskifyWatchRelayDecision(status: .indeterminate)
            )
        }
        let conversationID = members.count > 2
            ? TaskifyWatchNIP17.groupID(memberPublicKeys: members)
            : members.first { $0 != identity }!
        guard let selfWrap = set.wraps.first(where: { $0.recipientPublicKey == identity }) else {
            throw TaskifyWatchChatCoordinatorError.invalidConversation
        }
        // This is the rumor we just created locally. Decrypting and verifying our own
        // freshly signed self-copy repeats two decryptions and signature checks on Watch.
        let decrypted = TaskifyWatchNIP17DecryptedRumor(
            wrapEventID: selfWrap.event.id,
            rumor: set.rumor
        )
        var message = try TaskifyWatchNIP17.chatMessage(
            from: decrypted,
            identityPublicKey: identity
        )
        message.deliveryState = .queued
        let entry = TaskifyWatchChatOutboxEntry(
            rumorID: set.rumor.id,
            conversationID: conversationID,
            wraps: outboxWraps,
            senderPublicKey: identity
        )
        let group = members.count > 2
            ? TaskifyWatchGroupConversation(
                name: subject ?? "",
                memberPublicKeys: members,
                createdAt: set.rumor.createdAt,
                nameUpdatedAt: subject == nil ? nil : set.rumor.createdAt
            )
            : nil
        try await store.enqueue(message: message, outbox: entry, group: group)
        // Return the durable queued message immediately. Network delivery is driven by the
        // model's retry task, so the composer never waits for discovery or older outbox work.
        return await store.snapshot()
    }

    func registerWatch(
        deviceToken: Data,
        installationID: String,
        environment: String,
        privateKey: Data
    ) async throws -> (
        snapshot: TaskifyWatchChatSnapshot,
        context: TaskifyWatchChatProvisioningContext
    ) {
        guard let gateway else {
            throw TaskifyWatchChatCoordinatorError.notConfigured
        }
        try await gateway.registerWatch(
            deviceToken: deviceToken,
            installationID: installationID,
            environment: environment,
            privateKey: privateKey
        )
        let prepared = try await prepareIndependentInbox(privateKey: privateKey)
        return (await store.snapshot(), prepared)
    }

    /// Ensures the Watch's gateway is present in the account's own NIP-17 inbox preference even
    /// when alert permission is denied. APNs improves notification delivery, but foreground inbox
    /// delivery must never depend on granting notification access.
    func prepareIndependentInbox(
        privateKey: Data
    ) async throws -> TaskifyWatchChatProvisioningContext {
        guard let context, let gateway else {
            throw TaskifyWatchChatCoordinatorError.notConfigured
        }
        let identity = try TaskifyWatchNostrCrypto.publicKeyHex(for: privateKey)
        let current = await resolve(
            recipientPublicKey: identity,
            identityPublicKey: identity,
            context: context,
            privateKey: privateKey
        )
        guard current.canPublish else { throw TaskifyWatchChatCoordinatorError.routingUnavailable }
        let pushRelay = TaskifyWatchRelayRouting.normalizedRelayURLs([context.pushRelayWSSURL]).first
        guard let pushRelay else { throw TaskifyWatchChatCoordinatorError.routingUnavailable }
        if current.relayURLs.contains(pushRelay),
           context.accountInboxPreferenceEvent != nil {
            return context
        }
        let inboxRelays = TaskifyWatchRelayRouting.normalizedRelayURLs(
            current.relayURLs + [pushRelay]
        )
        let preference = try TaskifyWatchNostrCrypto.inboxPreferenceEvent(
            privateKey: privateKey,
            relayURLs: inboxRelays
        )
        let publishTargets = Array(TaskifyWatchRelayRouting.normalizedRelayURLs(
            [pushRelay] + context.discoveryRelayURLs + current.relayURLs
        ).prefix(TaskifyWatchRelayRouting.maximumRelayCount))
        let response = try await gateway.publishInboxPreference(
            event: preference,
            relayURLs: publishTargets,
            privateKey: privateKey
        )
        var accepted = response.accepted
        for result in response.results where result.status == "auth-required" {
            guard let session = result.session, let challenge = result.challenge else { continue }
            if let authorization = try? await gateway.authorize(
                sessionID: session,
                relayURL: result.relay,
                challenge: challenge,
                privateKey: privateKey
            ), authorization.result.status == "accepted" {
                accepted += 1
            }
        }
        guard accepted > 0 else { throw TaskifyWatchChatCoordinatorError.routingUnavailable }
        let prepared = TaskifyWatchChatProvisioningContext(
            contacts: context.contacts,
            threadSummaries: context.threadSummaries ?? [],
            discoveryRelayURLs: context.discoveryRelayURLs,
            accountInboxPreferenceEvent: preference,
            pushRelayHTTPSURL: context.pushRelayHTTPSURL,
            pushRelayWSSURL: context.pushRelayWSSURL
        )
        self.context = prepared
        return prepared
    }

    func markRead(
        conversationID: String,
        through timestamp: Int
    ) async throws -> TaskifyWatchChatSnapshot {
        try await store.markRead(conversationID: conversationID, at: timestamp)
        return await store.snapshot()
    }

    func setGroup(_ group: TaskifyWatchGroupConversation) async throws -> TaskifyWatchChatSnapshot {
        try await store.setGroup(group)
        return await store.snapshot()
    }

    func block(publicKey: String) async throws -> TaskifyWatchChatSnapshot {
        try await store.block(publicKey: publicKey)
        return await store.snapshot()
    }

    func deleteConversation(_ conversationID: String) async throws -> TaskifyWatchChatSnapshot {
        try await store.deleteConversation(conversationID)
        return await store.snapshot()
    }

    func clearMessages() async throws -> TaskifyWatchChatSnapshot {
        try await store.clearMessages()
        return await store.snapshot()
    }

    func clear() async throws -> TaskifyWatchChatSnapshot {
        gateway = nil
        context = nil
        outboxFlushTask?.cancel()
        // Let cancelled network work finish before clearing, so it cannot restore old entries.
        _ = try? await outboxFlushTask?.value
        outboxFlushTask = nil
        relayDecisionCache = TaskifyWatchRelayDecisionCache()
        try await store.clear()
        latestProjectionGeneratedAt = .distantPast
        return await store.snapshot()
    }

    private func resolve(
        recipientPublicKey: String,
        identityPublicKey: String,
        context: TaskifyWatchChatProvisioningContext,
        privateKey: Data
    ) async -> TaskifyWatchRelayDecision {
        let snapshot = await store.snapshot()
        let contact = snapshot.contacts.first { $0.publicKey == recipientPublicKey }
        let seededEvent = recipientPublicKey == identityPublicKey
            ? context.accountInboxPreferenceEvent
            : contact?.inboxPreferenceEvent
        if let cached = relayDecisionCache.decision(
            for: recipientPublicKey, seedEventID: seededEvent?.id
        ) { return cached }
        if let seededEvent {
            let decision = TaskifyWatchRelayRouting.resolve(
                recipientPublicKey: recipientPublicKey,
                events: [seededEvent],
                discoveryComplete: false
            )
            let age = Date().timeIntervalSince1970 - TimeInterval(seededEvent.createdAt)
            if decision.canPublish, age >= 0, age <= Self.preferenceFreshnessSeconds {
                relayDecisionCache.record(
                    decision, for: recipientPublicKey, seedEventID: seededEvent.id,
                    checkedAt: Date(timeIntervalSince1970: TimeInterval(seededEvent.createdAt))
                )
                return decision
            }
        }
        if let absentAt = contact?.confirmedAbsentAt,
           absentAt > Date().addingTimeInterval(-6 * 60 * 60) {
            return TaskifyWatchRelayRouting.resolve(
                recipientPublicKey: recipientPublicKey,
                events: [],
                discoveryComplete: true
            )
        }
        // Contact-advertised discovery relays remain first, but reserve three of the Watch's
        // bounded query slots for Taskify's reliable defaults. Previously a long list of stale
        // board/contact relays could crowd every working discovery relay out of the first eight.
        let relays = TaskifyWatchRelayDiscoveryPolicy.prioritizedRelayURLs(
            contactRelayURLs: contact?.discoveryRelayURLs ?? [],
            contextRelayURLs: context.discoveryRelayURLs
        )
        let discovered: TaskifyWatchRelayDiscoveryResult
        do {
            guard let gateway else { throw TaskifyWatchChatCoordinatorError.notConfigured }
            discovered = try await gateway.preferenceEvents(
                recipientPublicKey: recipientPublicKey,
                relayURLs: relays,
                privateKey: privateKey
            )
        } catch {
            // Transport failure is not proof that the recipient has no published inbox list.
            discovered = TaskifyWatchRelayDiscoveryResult(events: [], discoveryComplete: false)
        }
        let decision = TaskifyWatchRelayRouting.resolve(
            recipientPublicKey: recipientPublicKey,
            events: discovered.events,
            discoveryComplete: discovered.discoveryComplete,
            lastKnownPositive: seededEvent.map {
                TaskifyWatchRelayRouting.resolve(
                    recipientPublicKey: recipientPublicKey,
                    events: [$0],
                    discoveryComplete: false
                )
            }
        )
        let newest = discovered.events
            .filter {
                $0.kind == 10_050
                    && $0.publicKey.lowercased() == recipientPublicKey.lowercased()
                    && TaskifyWatchNostrCrypto.verify($0)
            }
            .sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
                return $0.id > $1.id
            }
            .first
        // An incomplete lookup must not erase the last signed preference we can still use.
        let retainedEvent = newest ?? (discovered.discoveryComplete ? nil : seededEvent)
        if recipientPublicKey != identityPublicKey {
            try? await store.updateContactPreference(
                publicKey: recipientPublicKey,
                event: retainedEvent,
                confirmedAbsentAt: decision.status == .confirmedAbsent ? Date() : nil
            )
        }
        relayDecisionCache.record(
            decision, for: recipientPublicKey,
            seedEventID: recipientPublicKey == identityPublicKey || contact == nil
                ? seededEvent?.id : retainedEvent?.id
        )
        return decision
    }

    private func flushOutbox(privateKey: Data) async throws {
        if let outboxFlushTask {
            try await outboxFlushTask.value
            return
        }
        let task = Task { try await self.performOutboxFlush(privateKey: privateKey) }
        outboxFlushTask = task
        defer { outboxFlushTask = nil }
        try await task.value
    }

    private func performOutboxFlush(privateKey: Data) async throws {
        guard let gateway, let context else { throw TaskifyWatchChatCoordinatorError.notConfigured }
        let snapshot = await store.snapshot()
        let now = Date()
        var updatedEntries: [TaskifyWatchChatOutboxEntry] = []
        do {
            try await flushOutboxEntries(
                snapshot: snapshot,
                now: now,
                gateway: gateway,
                context: context,
                privateKey: privateKey,
                updatedEntries: &updatedEntries
            )
        } catch {
            // Checkpoint whatever finished before the failure so completed acknowledgements
            // survive a cancelled or failed flush.
            try? await store.replaceOutboxEntries(updatedEntries)
            throw error
        }
        try await store.replaceOutboxEntries(updatedEntries)
    }

    private func flushOutboxEntries(
        snapshot: TaskifyWatchChatSnapshot,
        now: Date,
        gateway: TaskifyWatchChatGatewayClient,
        context: TaskifyWatchChatProvisioningContext,
        privateKey: Data,
        updatedEntries: inout [TaskifyWatchChatOutboxEntry]
    ) async throws {
        for entryIndex in snapshot.outbox.indices {
            try Task.checkCancellation()
            var entry = snapshot.outbox[entryIndex]
            // NIP-17 envelope construction does not promise recipient-first ordering. Process all
            // actual recipients first so a sender wrap that happens to sort first can be mirrored
            // during this same flush once recipient delivery is acknowledged.
            let recipientIndices = entry.wraps.indices.filter {
                entry.wraps[$0].recipientPublicKey != entry.senderPublicKey
            }
            let senderIndices = entry.wraps.indices.filter {
                entry.wraps[$0].recipientPublicKey == entry.senderPublicKey
            }
            for wrapIndex in recipientIndices + senderIndices {
                try Task.checkCancellation()
                var wrap = entry.wraps[wrapIndex]
                // The sender copy is what makes this Watch-originated message appear on the
                // paired iPhone and the sender's other clients. Do not publish that mirror until
                // every actual recipient has a relay acknowledgement; otherwise a completely
                // failed delivery can look sent everywhere except the recipient's devices.
                if wrap.recipientPublicKey == entry.senderPublicKey,
                   !entry.areRecipientCopiesDelivered {
                    continue
                }
                guard !wrap.isFullyReplicated,
                      wrap.nextAttemptAt <= now,
                      entry.expiresAt > now else { continue }
                if !wrap.routingDecision.canPublish {
                    wrap.routingDecision = await resolve(
                        recipientPublicKey: wrap.recipientPublicKey,
                        identityPublicKey: entry.senderPublicKey,
                        context: context,
                        privateKey: privateKey
                    )
                    wrap.acknowledgements = wrap.routingDecision.relayURLs.map {
                        TaskifyWatchRelayAcknowledgement(relayURL: $0)
                    }
                }
                if !wrap.routingDecision.canPublish {
                    // Bounded patience with relay discovery: once a wrap has cycled through
                    // enough attempts without a routable inbox list, publish via the same
                    // degraded relay set the iPhone would use rather than staying queued
                    // until the 48-hour outbox expiry. A momentarily flaky Watch network
                    // still gets a few chances to resolve the real inbox relays first.
                    if wrap.attempts >= TaskifyWatchRelayRouting.degradedFallbackAttemptThreshold {
                        wrap.routingDecision = TaskifyWatchRelayRouting.fallbackDecision(
                            pushRelayWSSURL: context.pushRelayWSSURL,
                            contextRelayURLs: context.discoveryRelayURLs
                        )
                        wrap.acknowledgements = wrap.routingDecision.relayURLs.map {
                            TaskifyWatchRelayAcknowledgement(relayURL: $0)
                        }
                    } else {
                        wrap.attempts += 1
                        wrap.nextAttemptAt = nextAttemptDate(attempts: wrap.attempts)
                        entry.wraps[wrapIndex] = wrap
                        continue
                    }
                }
                let unfinished = wrap.acknowledgements
                    .filter { $0.state != .accepted }
                    .map(\.relayURL)
                guard !unfinished.isEmpty else { continue }
                do {
                    let response = try await gateway.submit(
                        event: wrap.event,
                        relayURLs: unfinished,
                        privateKey: privateKey
                    )
                    wrap.lastSubmissionError = nil
                    for result in response.results {
                        apply(result: result, to: &wrap)
                    }
                    let authorizations = await authorizePendingRelays(
                        results: response.results,
                        gateway: gateway,
                        privateKey: privateKey
                    )
                    for authorization in authorizations {
                        apply(result: authorization.result, to: &wrap)
                    }
                } catch {
                    // The immutable outbox entry remains the source of truth for a later
                    // retry, but keep the rejection reason: a permanently queued message
                    // with no recorded error is indistinguishable from a routing stall.
                    wrap.lastSubmissionError = (error as? TaskifyWatchChatClientError)?
                        .errorDescription ?? error.localizedDescription
                }
                wrap.attempts += 1
                wrap.nextAttemptAt = nextAttemptDate(attempts: wrap.attempts)
                entry.wraps[wrapIndex] = wrap
            }
            try Task.checkCancellation()
            // Keep the entry only when the flush actually changed it; unchanged entries would
            // just trigger a pointless re-encode of the store.
            if entry != snapshot.outbox[entryIndex] {
                updatedEntries.append(entry)
            }
        }
    }

    /// Answers every auth-required relay from one submit concurrently. Gateway AUTH
    /// sessions are short-lived, so a sequential loop over several restricted relays can
    /// burn later sessions' TTL before their authorize POST is even built.
    private func authorizePendingRelays(
        results: [TaskifyWatchGatewayRelayResult],
        gateway: TaskifyWatchChatGatewayClient,
        privateKey: Data
    ) async -> [TaskifyWatchGatewayAuthorizationResult] {
        let pending = results.filter { $0.status == "auth-required" }
        guard !pending.isEmpty else { return [] }
        return await withTaskGroup(
            of: TaskifyWatchGatewayAuthorizationResult?.self
        ) { group in
            for result in pending {
                guard let session = result.session, let challenge = result.challenge else {
                    continue
                }
                group.addTask {
                    try? await gateway.authorize(
                        sessionID: session,
                        relayURL: result.relay,
                        challenge: challenge,
                        privateKey: privateKey
                    )
                }
            }
            var completed: [TaskifyWatchGatewayAuthorizationResult] = []
            for await authorization in group {
                if let authorization { completed.append(authorization) }
            }
            return completed
        }
    }

    private func apply(
        result: TaskifyWatchGatewayRelayResult,
        to wrap: inout TaskifyWatchOutboxWrap
    ) {
        guard let index = wrap.acknowledgementIndex(forResultRelay: result.relay) else {
            return
        }
        switch result.status {
        case "accepted": wrap.acknowledgements[index].state = .accepted
        case "pending": break // The gateway is still forwarding; keep this relay retryable.
        case "auth-required": wrap.acknowledgements[index].state = .authenticationRequired
        default: wrap.acknowledgements[index].state = .rejected
        }
        wrap.acknowledgements[index].message = result.message
        wrap.acknowledgements[index].session = result.session
        wrap.acknowledgements[index].challenge = result.challenge
    }

    private func nextAttemptDate(attempts: Int) -> Date {
        Date().addingTimeInterval(min(pow(2, Double(min(attempts, 10))) * 5, 15 * 60))
    }
}

import Foundation
import TaskifyCore

// MARK: - App state sync (Bible tracker, scripture memory, chat state)

extension AppModel {
    private static let appStateOutboxScope = "__taskify-app-state__"
    private static let appStateLedgerKey = "taskify.appStateSync.ledger.v1"
    /// Foreground returns re-check at most this often: one REQ per relay covers all three records.
    private static let appStateFetchInterval: TimeInterval = 30
    /// Read markers move whenever a conversation is viewed, so they are coalesced into one
    /// replaceable event per quiet period instead of one per message.
    private static let chatStatePublishDelay: Duration = .seconds(15)
    private static let appStatePublishDelay: Duration = .seconds(2)

    static func loadAppStateLedger() -> AppStateSyncLedger {
        guard let data = UserDefaults.standard.data(forKey: appStateLedgerKey),
              let ledger = try? JSONDecoder().decode(AppStateSyncLedger.self, from: data) else {
            return AppStateSyncLedger()
        }
        return ledger
    }

    private func saveAppStateLedger() {
        guard let data = try? JSONEncoder().encode(appStateLedger) else { return }
        UserDefaults.standard.set(data, forKey: Self.appStateLedgerKey)
    }

    /// A ledger belongs to one account; switching identities starts it over.
    private func appStateLedgerIdentity() -> NostrIdentity? {
        guard let identity = cachedIdentity else { return nil }
        if appStateLedger.publicKey != identity.publicKeyHex {
            appStateLedger = AppStateSyncLedger(publicKey: identity.publicKeyHex)
            saveAppStateLedger()
        }
        return identity
    }

    private var appStateRelayURLs: [String] {
        TaskifyRelayURL.normalizedList(appRelays + (accountBackupBaseline?.defaultRelayURLs ?? []))
    }

    /// Throttled entry point for app launch and foreground returns.
    func refreshAppStateSyncIfNeeded() {
        guard !isLoading,
              appStateFetchTask == nil,
              lastAppStateFetchAt.map({ Date().timeIntervalSince($0) > Self.appStateFetchInterval }) ?? true else {
            return
        }
        appStateFetchTask = Task { [weak self] in
            await self?.fetchAppState()
            self?.appStateFetchTask = nil
        }
    }

    /// Publishes anything still waiting on its debounce, e.g. as the app leaves the foreground,
    /// so the next device picked up already sees it. Queued publishes survive in the outbox.
    func flushAppStateSync() {
        let pending = appStatePublishTasks.keys
        for dTag in pending {
            appStatePublishTasks[dTag]?.cancel()
            appStatePublishTasks[dTag] = Task { [weak self] in
                await self?.publishAppState(dTag)
                // A cancelled task was replaced; leave the replacement's slot alone.
                if !Task.isCancelled { self?.appStatePublishTasks[dTag] = nil }
            }
        }
    }

    func scheduleAppStatePublish(_ dTag: String) {
        guard !isLoading, cachedIdentity != nil else { return }
        if dTag == AppStateSyncContract.chatStateDTag {
            // Cheap check first: most snapshot writes (new messages, pending shares) leave
            // nothing new to publish. A pending timer is not restarted, bounding the delay.
            let known = appStateLedger.chat.synced ?? ChatSyncState()
            guard appStatePublishTasks[dTag] == nil,
                  known.toPublish(merging: snapshot.chatSyncState, nowSeconds: Int(Date().timeIntervalSince1970)) != nil else {
                return
            }
        } else {
            appStatePublishTasks[dTag]?.cancel()
        }
        let delay = dTag == AppStateSyncContract.chatStateDTag ? Self.chatStatePublishDelay : Self.appStatePublishDelay
        appStatePublishTasks[dTag] = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self, !Task.isCancelled else { return }
            await self.publishAppState(dTag)
            // A cancelled task was replaced; leave the replacement's slot alone.
            if !Task.isCancelled { self.appStatePublishTasks[dTag] = nil }
        }
    }

    private func fetchAppState() async {
        guard let identity = appStateLedgerIdentity() else { return }
        let lookupRelays = TaskifyRelayURL.normalizedList(appStateRelayURLs + snapshot.boards.flatMap(\.syncRelayURLs))
        let latest = await AppStateSyncFinder.findLatest(
            publicKey: identity.publicKeyHex,
            relayURLs: lookupRelays,
            fetcher: syncEngine
        )
        guard !Task.isCancelled, appStateLedger.publicKey == identity.publicKeyHex else { return }
        lastAppStateFetchAt = Date()
        let decoded: [(dTag: String, event: NostrEvent, plaintext: Data)] = await Task.detached(priority: .utility) {
            latest.values.compactMap { event in
                (try? AppStateSyncContract.decrypt(event: event, identity: identity)).map { ($0.dTag, event, $0.plaintext) }
            }
        }.value
        for item in decoded {
            applyAppStateEvent(dTag: item.dTag, event: item.event, plaintext: item.plaintext)
        }
        // Nothing synced yet anywhere: seed the relays with what this device has.
        if latest[AppStateSyncContract.bibleTrackerDTag] == nil,
           appStateLedger.bibleTracker.synced == nil,
           bibleTrackerStore.state.hasSyncableContent {
            scheduleAppStatePublish(AppStateSyncContract.bibleTrackerDTag)
        }
        if latest[AppStateSyncContract.scriptureMemoryDTag] == nil,
           appStateLedger.scriptureMemory.synced == nil,
           !scriptureMemoryState.entries.isEmpty {
            scheduleAppStatePublish(AppStateSyncContract.scriptureMemoryDTag)
        }
        scheduleAppStatePublish(AppStateSyncContract.chatStateDTag)
    }

    private func applyAppStateEvent(dTag: String, event: NostrEvent, plaintext: Data) {
        let decoder = JSONDecoder()
        switch dTag {
        case AppStateSyncContract.bibleTrackerDTag:
            guard !appStateLedger.bibleTracker.isStale(eventID: event.id, createdAt: event.createdAt),
                  let payload = try? decoder.decode(BibleTrackerSyncPayload.self, from: plaintext),
                  payload.version == 1 else { return }
            let incoming = payload.bibleTracker
            let base = AppStateSyncContract.sharedBase(
                baseTimestamp: payload.baseTimestamp,
                localBase: appStateLedger.bibleTracker.synced
            )
            let merged = bibleTrackerStore.state.merged(with: incoming, base: base)
            bibleTrackerStore.applySyncedState(merged)
            appStateLedger.bibleTracker.record(
                eventID: event.id,
                timestamp: max(payload.timestamp, event.createdAt),
                synced: incoming
            )
            saveAppStateLedger()
            // This device had changes the other one had not seen: send the merge back.
            if !merged.syncEquivalent(to: incoming) {
                scheduleAppStatePublish(dTag)
            }
        case AppStateSyncContract.scriptureMemoryDTag:
            guard !appStateLedger.scriptureMemory.isStale(eventID: event.id, createdAt: event.createdAt),
                  let payload = try? decoder.decode(ScriptureMemorySyncPayload.self, from: plaintext),
                  payload.version == 1 else { return }
            let incoming = payload.scriptureMemory
            let base = AppStateSyncContract.sharedBase(
                baseTimestamp: payload.baseTimestamp,
                localBase: appStateLedger.scriptureMemory.synced
            )
            let merged = scriptureMemoryState.merged(with: incoming, base: base)
            appStateLedger.scriptureMemory.record(
                eventID: event.id,
                timestamp: max(payload.timestamp, event.createdAt),
                synced: incoming
            )
            saveAppStateLedger()
            if merged != scriptureMemoryState {
                isApplyingSyncedScriptureMemory = true
                scriptureMemoryState = merged
                persistScriptureMemoryState()
                isApplyingSyncedScriptureMemory = false
                // New or reviewed passages can change which review task should exist.
                _ = reconcileScriptureMemory()
            }
            if !scriptureMemoryState.syncEquivalent(to: incoming) {
                scheduleAppStatePublish(dTag)
            }
        case AppStateSyncContract.chatStateDTag:
            guard !appStateLedger.chat.isStale(eventID: event.id, createdAt: event.createdAt),
                  let payload = try? decoder.decode(ChatStateSyncPayload.self, from: plaintext),
                  payload.version == 1 else { return }
            let incoming = payload.state
            appStateLedger.chat.record(
                eventID: event.id,
                timestamp: max(payload.timestamp, event.createdAt),
                synced: (appStateLedger.chat.synced ?? ChatSyncState()).merged(with: incoming)
            )
            saveAppStateLedger()
            var updated = snapshot
            let previousInvites = updated.sharedCalendarInviteItems ?? []
            let readChanged = updated.applySyncedReadThrough(incoming.readThrough)
            let responsesChanged = updated.applySyncedInboxResponses(incoming.inboxResponses)
            if readChanged || responsesChanged {
                snapshot = updated
                scheduleSave()
            }
            if responsesChanged {
                materializeSyncedCalendarInvites(previous: previousInvites)
            }
        default:
            return
        }
    }

    /// Adds invites another device accepted (or marked maybe) to this device's calendar, as
    /// accepting here would. Local only: the RSVP already went out from the device that answered.
    private func materializeSyncedCalendarInvites(previous: [SharedCalendarInviteInboxItem]) {
        let wasPending = Set(previous.filter { $0.status == .pending }.map(\.id))
        let accepted = snapshot.sharedCalendarInvites.filter {
            wasPending.contains($0.id) && ($0.status == .accepted || $0.status == .tentative)
        }
        guard !accepted.isEmpty else { return }
        Task { [weak self] in
            for item in accepted {
                guard let self else { return }
                let relays = TaskifyRelayURL.normalizedList((item.event.relayURLs ?? []) + self.sharedInboxRelayURLs)
                guard !relays.isEmpty,
                      let event = try? await TaskifyEventInvitationResolver.resolve(
                          invite: item.event,
                          status: item.status,
                          relayURLs: relays
                      ) else { continue }
                var updated = self.snapshot
                if updated.upsertTaskifyEvent(event) {
                    self.snapshot = updated
                    self.scheduleSave()
                }
            }
        }
    }

    private func publishAppState(_ dTag: String) async {
        guard let identity = appStateLedgerIdentity() else { return }
        let relays = appStateRelayURLs
        guard !relays.isEmpty else { return }
        // Bible tracker and scripture memory pick up the newest remote copy first when it has not
        // been checked recently, so this publish carries the other devices' changes too.
        if dTag != AppStateSyncContract.chatStateDTag,
           lastAppStateFetchAt.map({ Date().timeIntervalSince($0) > Self.appStateFetchInterval }) ?? true {
            await fetchAppState()
            guard !Task.isCancelled else { return }
        }
        let createdAt: Int
        let eventBuilder: @Sendable () throws -> NostrEvent
        let commit: (NostrEvent) -> Void
        switch dTag {
        case AppStateSyncContract.bibleTrackerDTag:
            let state = bibleTrackerStore.state
            let entry = appStateLedger.bibleTracker
            if let synced = entry.synced, synced.syncEquivalent(to: state) { return }
            createdAt = entry.nextTimestamp()
            let payload = BibleTrackerSyncPayload(timestamp: createdAt, baseTimestamp: entry.baseTimestamp, bibleTracker: state)
            eventBuilder = { try AppStateSyncContract.event(dTag: dTag, payload: payload, identity: identity, createdAt: createdAt) }
            commit = { [weak self] event in
                self?.appStateLedger.bibleTracker.record(eventID: event.id, timestamp: createdAt, synced: state)
            }
        case AppStateSyncContract.scriptureMemoryDTag:
            let state = scriptureMemoryState
            let entry = appStateLedger.scriptureMemory
            if let synced = entry.synced, synced.syncEquivalent(to: state) { return }
            createdAt = entry.nextTimestamp()
            let payload = ScriptureMemorySyncPayload(timestamp: createdAt, baseTimestamp: entry.baseTimestamp, scriptureMemory: state)
            eventBuilder = { try AppStateSyncContract.event(dTag: dTag, payload: payload, identity: identity, createdAt: createdAt) }
            commit = { [weak self] event in
                self?.appStateLedger.scriptureMemory.record(eventID: event.id, timestamp: createdAt, synced: state)
            }
        case AppStateSyncContract.chatStateDTag:
            let known = appStateLedger.chat.synced ?? ChatSyncState()
            createdAt = appStateLedger.chat.nextTimestamp()
            guard let next = known.toPublish(merging: snapshot.chatSyncState, nowSeconds: createdAt) else { return }
            let payload = ChatStateSyncPayload(timestamp: createdAt, state: next)
            eventBuilder = { try AppStateSyncContract.event(dTag: dTag, payload: payload, identity: identity, createdAt: createdAt) }
            commit = { [weak self] event in
                self?.appStateLedger.chat.record(eventID: event.id, timestamp: createdAt, synced: next)
            }
        default:
            return
        }
        do {
            let event = try await TaskifyRelayProofOfWork.prepare(relays: relays, operation: eventBuilder)
            await syncEngine.configure(
                boards: snapshot.boardsForSync,
                auxiliaryRelayURLs: TaskifyRelayURL.normalizedList(sharedInboxRelayURLs + relays),
                inboxPublicKey: identity.publicKeyHex,
                inboxRelayURLs: effectiveNIP17InboxRelayURLs
            )
            try await syncEngine.publish(
                event,
                relayURLs: relays,
                outboxScope: Self.appStateOutboxScope,
                recordID: dTag
            )
            commit(event)
            saveAppStateLedger()
        } catch {
            // Left unrecorded, so the next change or foreground check tries again.
        }
    }
}

private extension BibleTrackerState {
    var hasSyncableContent: Bool {
        !progress.isEmpty || !archive.isEmpty || !verses.isEmpty || !completedBooks.isEmpty
    }
}

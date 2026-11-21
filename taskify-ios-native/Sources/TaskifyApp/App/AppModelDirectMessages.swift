import Foundation
import os
import TaskifyCore
import TaskifyWatchShared

extension AppModel {
    /// One rumor's payload before wrapping: its kind, content, and extra tags.
    private struct DirectMessageRumorDraft: Sendable {
        let kind: Int
        let content: String
        let additionalTags: [[String]]
    }

    func sendDirectMessage(
        to recipientValue: String,
        content: String,
        replyToEventID: String? = nil,
        additionalTags: [[String]] = [],
        optimisticLocalEcho: Bool = false,
        resolvedDeliveryPlan: NIP17DeliveryPlan? = nil,
        onLocalEcho: (() -> Void)? = nil
    ) async throws {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw NostrDirectMessageError.emptyMessage }
#if DEBUG
        if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_FIXTURE"] == "1",
           ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] == "1" {
            // Exercise composer rendering and simulated relay acceptance without publishing test data.
            let eventID = UUID().uuidString.lowercased()
            let delayAcceptance = ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_DELAY_ACCEPTANCE"] == "1"
            if snapshot.ingestDirectMessage(NostrDirectMessage(
                rumorEventID: eventID, wrapEventID: eventID,
                peerPublicKey: recipientValue, senderPublicKey: identityPublicKey,
                content: text, createdAt: currentDirectMessageTimestamp(), isIncoming: false,
                replyToEventID: replyToEventID,
                botUiAction: TaskifyBotUiContract.action(from: additionalTags),
                deliveryState: delayAcceptance ? .queued : .sent
            )) {
                scheduleSave()
            }
            onLocalEcho?()
            if delayAcceptance {
                let accountID = identityPublicKey
                Task {
                    try await Task.sleep(for: .seconds(5))
                    guard accountID == identityPublicKey else { return }
                    if snapshot.setDirectMessageDeliveryState(rumorEventID: eventID, state: .sent) {
                        scheduleSave()
                    }
                }
            }
            return
        }
#endif
        try await publishDirectMessageRumorBatch(
            to: recipientValue,
            drafts: [DirectMessageRumorDraft(
                kind: NIP17GiftWrap.rumorKind,
                content: text,
                additionalTags: additionalTags
            )],
            replyToEventID: replyToEventID,
            attachmentComment: nil,
            optimisticLocalEcho: optimisticLocalEcho,
            resolvedDeliveryPlan: resolvedDeliveryPlan,
            onLocalEcho: onLocalEcho
        )
    }

    /// Sends a Taskify-generated Hermes menu command. The encrypted tag identifies it to every
    /// Taskify client so the command can stay hidden while its picker state remains reproducible.
    func sendBotUiCommand(
        to recipientValue: String,
        content: String,
        action: TaskifyBotUiAction,
        bindToListing: Bool = false
    ) async throws {
        guard snapshot.groupConversation(id: recipientValue) == nil else {
            throw NostrDirectMessageError.invalidGroup
        }
        let tag = try TaskifyBotUiContract.tag(for: action)
        try await sendDirectMessage(
            to: recipientValue,
            content: content,
            replyToEventID: bindToListing ? action.menuId : nil,
            additionalTags: [tag]
        )
#if DEBUG
        if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_HERMES_MENU"] == "1",
           ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] == "1" {
            guard action.kind == .modelSelect,
                  ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_HERMES_NO_CONFIRMATION"] != "1" else { return }
            let responseText = """
            Model switched to `\(action.modelId ?? "")`
            Provider: \(action.providerSlug)
            Context: 1,048,576 tokens
            _(session only — add --global to persist)_
            """
            let responseID = UUID().uuidString
            if snapshot.ingestDirectMessage(NostrDirectMessage(
                rumorEventID: responseID,
                wrapEventID: responseID,
                peerPublicKey: recipientValue,
                senderPublicKey: recipientValue,
                content: responseText,
                createdAt: currentDirectMessageTimestamp() + 1,
                isIncoming: true
            )) {
                scheduleSave()
            }
        }
#endif
    }

    /// One file per kind 15 rumor (NIP-17 has no multi-file event), sent as a
    /// single ordered batch with an optional caption kind 14 after the files.
    func sendDirectMessageAttachments(
        to recipientValue: String,
        attachments: [NostrDirectMessageAttachment],
        replyToEventID: String? = nil,
        comment: String? = nil,
        optimisticLocalEcho: Bool = false,
        onLocalEcho: (() -> Void)? = nil
    ) async throws {
        guard !attachments.isEmpty,
              attachments.count <= NostrDirectMessageAttachment.maximumBatchCount else {
            throw NostrDirectMessageError.invalidAttachment
        }
#if DEBUG
        if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_FIXTURE"] == "1",
           ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] == "1" {
            // Exercise rendering a sent attachment without publishing test data.
            for attachment in attachments {
                let eventID = UUID().uuidString
                if snapshot.ingestDirectMessage(NostrDirectMessage(
                    rumorEventID: eventID, wrapEventID: eventID,
                    peerPublicKey: recipientValue, senderPublicKey: identityPublicKey,
                    content: attachment.url, createdAt: currentDirectMessageTimestamp(), isIncoming: false,
                    replyToEventID: replyToEventID,
                    attachment: attachment
                )) {
                    scheduleSave()
                }
            }
            onLocalEcho?()
            return
        }
#endif
        let drafts = try attachments.map { attachment in
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
            return DirectMessageRumorDraft(
                kind: NostrDirectMessageAttachment.rumorKind,
                content: validated.url,
                additionalTags: validated.rumorTags
            )
        }
        try await publishDirectMessageRumorBatch(
            to: recipientValue,
            drafts: drafts,
            replyToEventID: replyToEventID,
            attachmentComment: comment,
            optimisticLocalEcho: optimisticLocalEcho,
            onLocalEcho: onLocalEcho
        )
    }

    private func publishDirectMessageRumorBatch(
        to recipientValue: String,
        drafts: [DirectMessageRumorDraft],
        replyToEventID: String?,
        attachmentComment: String?,
        optimisticLocalEcho: Bool,
        resolvedDeliveryPlan: NIP17DeliveryPlan? = nil,
        onLocalEcho: (() -> Void)?
    ) async throws {
        guard !drafts.isEmpty else { throw NostrDirectMessageError.emptyMessage }
        if let group = snapshot.groupConversation(id: recipientValue) {
            guard !snapshot.hasLeftDirectMessageGroup(group.groupID) else {
                throw NostrDirectMessageError.leftGroup
            }
            try await publishGroupRumors(
                group: group,
                drafts: drafts,
                replyToEventID: replyToEventID,
                attachmentComment: attachmentComment,
                optimisticLocalEcho: optimisticLocalEcho,
                onLocalEcho: onLocalEcho
            )
            return
        }
        let sendSignpostID = OSSignpostID(log: Self.dmPerformanceLog)
        let sendStartedAt = ProcessInfo.processInfo.systemUptime
        os_signpost(
            .begin,
            log: Self.dmPerformanceLog,
            name: "DM Send",
            signpostID: sendSignpostID
        )
        defer {
            os_signpost(
                .end,
                log: Self.dmPerformanceLog,
                name: "DM Send",
                signpostID: sendSignpostID,
                "total_ms=%.1f",
                (ProcessInfo.processInfo.systemUptime - sendStartedAt) * 1_000
            )
        }
        let identity = try outboundIdentity()
        guard let recipientPublicKey = NostrPublicKey.parse(recipientValue) else {
            throw NostrDirectMessageError.invalidRecipient
        }
        let recipientHex = recipientPublicKey.hexString
        // Strictly increasing timestamps keep a multi-file batch ordered on
        // every client; a single draft keeps today's exact wire behavior.
        let replyTag = validNostrEventID(replyToEventID).map { ["e", $0] }
        let baseCreatedAt = currentDirectMessageTimestamp()
        let rumors = try drafts.enumerated().map { index, draft in
            var rumorTags = [["p", recipientHex]] + draft.additionalTags
            if let replyTag { rumorTags.append(replyTag) }
            return try NIP17Rumor(
                publicKey: identity.publicKeyHex,
                createdAt: baseCreatedAt + index,
                kind: draft.kind,
                tags: rumorTags,
                content: draft.content
            )
        }
        let optimisticMessages = try (optimisticLocalEcho || onLocalEcho != nil)
            ? ingestOptimisticDirectMessages(
                rumors: rumors,
                attachmentComment: attachmentComment,
                identity: identity
            )
            : []
        onLocalEcho?()
        do {
            let fallbackRelays = directMessageDiscoveryRelayURLs(recipientPublicKey: recipientHex)
            let resolutionStartedAt = ProcessInfo.processInfo.systemUptime
            let deliveryPlan: NIP17DeliveryPlan
            if let resolvedDeliveryPlan {
                deliveryPlan = resolvedDeliveryPlan
            } else {
                guard !fallbackRelays.isEmpty, let plan = await nip17DeliveryPlan(
                    recipientPublicKey: recipientHex,
                    discoveryRelayURLs: fallbackRelays,
                    identity: identity
                ) else { throw NostrDirectMessageError.noRelays }
                deliveryPlan = plan
            }
            os_signpost(
                .event,
                log: Self.dmPerformanceLog,
                name: "DM Relay Resolution",
                signpostID: sendSignpostID,
                "duration_ms=%.1f recipient_relays=%d discovery_relays=%d",
                (ProcessInfo.processInfo.systemUptime - resolutionStartedAt) * 1_000,
                deliveryPlan.recipientRelayURLs.count,
                fallbackRelays.count
            )
            let enqueueStartedAt = ProcessInfo.processInfo.systemUptime
            var routes = [identity.publicKeyHex: deliveryPlan.senderRelayURLs]
            routes[recipientHex] = deliveryPlan.recipientRelayURLs
            try await enqueueRoutedDirectMessageBatch(
                rumors: rumors,
                attachmentComment: attachmentComment,
                identity: identity,
                relayURLsByRecipient: routes,
                isGroup: false
            )
            let allDeliveryRelays = TaskifyRelayURL.normalizedList(
                deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs
            )
            let queuedCount = await syncEngine.pendingPublishCount()
            os_signpost(
                .event,
                log: Self.dmPerformanceLog,
                name: "DM Durable Queue",
                signpostID: sendSignpostID,
                "duration_ms=%.1f outbox_entries=%d target_relays=%d",
                (ProcessInfo.processInfo.systemUptime - enqueueStartedAt) * 1_000,
                queuedCount,
                allDeliveryRelays.count
            )
            let boards = snapshot.boardsForSync
            Task { [syncEngine] in
                await syncEngine.configure(
                    boards: boards,
                    auxiliaryRelayURLs: allDeliveryRelays,
                    inboxPublicKey: identity.publicKeyHex,
                    inboxRelayURLs: deliveryPlan.senderRelayURLs
                )
            }
        } catch {
            markOptimisticDirectMessagesFailed(optimisticMessages)
            throw error
        }
    }

    func sendDirectMessageReaction(
        to message: NostrDirectMessage,
        emoji: String
    ) async throws {
        let value = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw NostrDirectMessageError.emptyMessage }
        let identity = try outboundIdentity()
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
        let isSelfMessage = recipientHex == identity.publicKeyHex
        let fallbackRelays = directMessageDiscoveryRelayURLs(recipientPublicKey: recipientHex)
        guard !fallbackRelays.isEmpty else { throw NostrDirectMessageError.noRelays }
        guard let deliveryPlan = await nip17DeliveryPlan(
            recipientPublicKey: recipientHex,
            discoveryRelayURLs: fallbackRelays,
            identity: identity
        ) else { throw NostrDirectMessageError.noRelays }

        let createdAt = nextNostrTimestamp()
        let wrapped = try await TaskifyRelayProofOfWork.prepare(difficulty: 0) {
            let rumor = try NIP17Rumor(
                publicKey: identity.publicKeyHex,
                createdAt: createdAt,
                kind: 7,
                tags: [
                    ["p", recipientHex],
                    ["e", message.rumorEventID],
                    ["p", message.senderPublicKey],
                ],
                content: value
            )
            let recipientWrap = try NIP17GiftWrap.wrapForOutbox(
                rumor: rumor,
                sender: identity,
                recipientPublicKey: recipientPublicKey
            )
            let senderWrap = isSelfMessage
                ? recipientWrap
                : try NIP17GiftWrap.wrapForOutbox(
                    rumor: rumor,
                    sender: identity,
                    recipientPublicKey: identity.publicKey
                )
            return (rumor, recipientWrap, senderWrap)
        }
        let rumor = wrapped.0
        let recipientWrap = wrapped.1
        let senderWrap = wrapped.2
        let decrypted = NIP17DecryptedRumor(wrapEventID: senderWrap.event.id, rumor: rumor)
        guard let localReaction = NostrDirectMessageReaction(
            decrypted: decrypted,
            identityPublicKey: identity.publicKeyHex
        ) else { throw NostrDirectMessageError.invalidRecipient }
        if snapshot.ingestDirectMessageReaction(localReaction) { scheduleSave() }

        let allDeliveryRelays = TaskifyRelayURL.normalizedList(
            deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs
        )
        let expiresAt = Date().addingTimeInterval(48 * 60 * 60)
        var requests = [TaskSyncRelayPublishRequest(
            event: recipientWrap.event,
            relayURLs: deliveryPlan.recipientRelayURLs,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):reaction:recipient",
            acknowledgementPolicy: .firstRelay,
            expiresAt: expiresAt,
            encryptedProofOfWorkKey: recipientWrap.encryptedProofOfWorkKey
        )]
        if !isSelfMessage {
            requests.append(TaskSyncRelayPublishRequest(
                event: senderWrap.event,
                relayURLs: deliveryPlan.senderRelayURLs,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "\(rumor.id):reaction:sender",
                acknowledgementPolicy: .firstRelay,
                expiresAt: expiresAt,
                encryptedProofOfWorkKey: senderWrap.encryptedProofOfWorkKey
            ))
        }
        try await syncEngine.enqueueForPublish(requests)
        let boards = snapshot.boardsForSync
        Task { [syncEngine] in
            await syncEngine.configure(
                boards: boards,
                auxiliaryRelayURLs: allDeliveryRelays,
                inboxPublicKey: identity.publicKeyHex,
                inboxRelayURLs: deliveryPlan.senderRelayURLs
            )
        }
    }

    private func publishGroupRumors(
        group: NostrGroupConversation,
        drafts: [DirectMessageRumorDraft],
        replyToEventID: String?,
        attachmentComment: String?,
        optimisticLocalEcho: Bool,
        onLocalEcho: (() -> Void)?
    ) async throws {
        let identity = try outboundIdentity()
        guard group.memberPublicKeys.contains(identity.publicKeyHex),
              group.memberPublicKeys.count <= NostrGroupConversation.maximumMemberCount else {
            throw NostrDirectMessageError.invalidGroup
        }
        let baseCreatedAt = currentDirectMessageTimestamp()
        let replyTag = validNostrEventID(replyToEventID).map { ["e", $0] }
        let rumors = try drafts.enumerated().map { index, draft in
            var tags = group.memberPublicKeys.map { ["p", $0] }
            if !group.name.isEmpty { tags.append(["subject", group.name]) }
            tags.append(contentsOf: draft.additionalTags)
            if let replyTag { tags.append(replyTag) }
            return try NIP17Rumor(
                publicKey: identity.publicKeyHex,
                createdAt: baseCreatedAt + index,
                kind: draft.kind,
                tags: tags,
                content: draft.content
            )
        }
        let optimisticMessages = try (optimisticLocalEcho || onLocalEcho != nil)
            ? ingestOptimisticDirectMessages(
                rumors: rumors,
                attachmentComment: attachmentComment,
                identity: identity
            )
            : []
        onLocalEcho?()
        do {
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

            var routes = relayMap
            routes[identity.publicKeyHex] = senderRelays
            try await enqueueRoutedDirectMessageBatch(
                rumors: rumors,
                attachmentComment: attachmentComment,
                identity: identity,
                relayURLsByRecipient: routes,
                isGroup: true
            )
            let allRelays = TaskifyRelayURL.normalizedList(senderRelays + recipientRelays)
            let boards = snapshot.boardsForSync
            Task { [syncEngine] in
                await syncEngine.configure(
                    boards: boards,
                    auxiliaryRelayURLs: allRelays,
                    inboxPublicKey: identity.publicKeyHex,
                    inboxRelayURLs: senderRelays
                )
            }
        } catch {
            markOptimisticDirectMessagesFailed(optimisticMessages)
            throw error
        }
    }

    private func ingestOptimisticDirectMessages(
        rumors: [NIP17Rumor],
        attachmentComment: String?,
        identity: NostrIdentity
    ) throws -> [NostrDirectMessage] {
        let messages = try NIP17OutgoingMessageBatch.optimisticLocalMessages(
            rumors: rumors,
            attachmentComment: attachmentComment,
            identity: identity
        )
        ingestLocalDirectMessages(messages)
        return messages
    }

    private func ingestLocalDirectMessages(_ messages: [NostrDirectMessage]) {
        var updated = snapshot
        var changed = false
        for message in messages {
            changed = updated.ingestDirectMessage(message) || changed
        }
        if changed {
            snapshot = updated
            scheduleSave()
        }
    }

    private func markOptimisticDirectMessagesFailed(_ messages: [NostrDirectMessage]) {
        guard messages.first?.senderPublicKey == identityPublicKey else { return }
        var updated = snapshot
        var changed = false
        for message in messages {
            changed = updated.setDirectMessageDeliveryState(
                rumorEventID: message.rumorEventID,
                state: .failed
            ) || changed
        }
        if changed {
            snapshot = updated
            scheduleSave()
        }
    }

    private func enqueueDirectMessageBatch(
        _ batch: NIP17OutgoingMessageBatch,
        identity: NostrIdentity,
        isGroup: Bool
    ) async throws {
        guard identityPublicKey == identity.publicKeyHex else { throw NostrDirectMessageError.identityUnavailable }
        ingestLocalDirectMessages(batch.localMessages)
        let expiresAt = Date().addingTimeInterval(48 * 60 * 60)
        let isSelfMessage = !isGroup && batch.localMessages.first?.peerPublicKey == identity.publicKeyHex
        let requests = batch.deliveries.map { delivery in
            let isSender = delivery.recipientPublicKey == identity.publicKeyHex
            let suffix = isGroup
                ? "group:\(isSender ? "sender" : delivery.recipientPublicKey)"
                : (isSender && !isSelfMessage ? "sender" : "recipient")
            return TaskSyncRelayPublishRequest(
                event: delivery.event,
                relayURLs: delivery.relayURLs,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "\(delivery.rumorEventID):\(suffix)",
                acknowledgementPolicy: .firstRelay,
                expiresAt: expiresAt,
                dependsOnEventID: delivery.dependsOnEventID,
                encryptedProofOfWorkKey: delivery.encryptedProofOfWorkKey
            )
        }
        do {
            try await syncEngine.enqueueForPublish(requests)
        } catch {
            markOptimisticDirectMessagesFailed(batch.localMessages)
            throw error
        }
    }

    /// Gift wraps are encrypted once per recipient. The durable outbox keeps the wrap
    /// and its encrypted signing key so it can add proof of work if a relay requires it.
    private func enqueueRoutedDirectMessageBatch(
        rumors: [NIP17Rumor],
        attachmentComment: String?,
        identity: NostrIdentity,
        relayURLsByRecipient: [String: [String]],
        isGroup: Bool
    ) async throws {
        let batch = try await Task.detached(priority: .userInitiated) {
            try NIP17OutgoingMessageBatch(
                rumors: rumors,
                attachmentComment: attachmentComment,
                identity: identity,
                relayURLsByRecipient: relayURLsByRecipient,
                allowProofOfWorkRetry: true
            )
        }.value
        try Task.checkCancellation()
        try await enqueueDirectMessageBatch(batch, identity: identity, isGroup: isGroup)
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
        let recipientPlans = group.memberPublicKeys.compactMap {
            member -> (String, Data, [String])? in
            guard member != identity.publicKeyHex,
                  let publicKey = NostrPublicKey.parse(member),
                  let relays = relayMap[member],
                  !relays.isEmpty else { return nil }
            return (member, publicKey, relays)
        }
        let wrapped = try await TaskifyRelayProofOfWork.prepare(difficulty: 0) {
            let selfWrap = try NIP17GiftWrap.wrapForOutbox(
                rumor: rumor,
                sender: identity,
                recipientPublicKey: identity.publicKey
            )
            let deliveries = try recipientPlans.map { member, publicKey, relays in
                GroupGiftWrapDelivery(
                    memberPublicKey: member,
                    wrap: try NIP17GiftWrap.wrapForOutbox(
                        rumor: rumor,
                        sender: identity,
                        recipientPublicKey: publicKey
                    ),
                    relayURLs: relays
                )
            }
            return (selfWrap, deliveries)
        }
        let selfWrap = wrapped.0
        guard let localReaction = NostrDirectMessageReaction(
            decrypted: NIP17DecryptedRumor(wrapEventID: selfWrap.event.id, rumor: rumor),
            identityPublicKey: identity.publicKeyHex
        ) else { throw NostrDirectMessageError.invalidGroup }
        if snapshot.ingestDirectMessageReaction(localReaction) { scheduleSave() }

        let expiresAt = Date().addingTimeInterval(48 * 60 * 60)
        var requests = wrapped.1.map { delivery in
            TaskSyncRelayPublishRequest(
                event: delivery.wrap.event,
                relayURLs: delivery.relayURLs,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "\(rumor.id):group-reaction:\(delivery.memberPublicKey)",
                acknowledgementPolicy: .firstRelay,
                expiresAt: expiresAt,
                encryptedProofOfWorkKey: delivery.wrap.encryptedProofOfWorkKey
            )
        }
        requests.append(TaskSyncRelayPublishRequest(
            event: selfWrap.event,
            relayURLs: senderRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):group-reaction:sender",
            acknowledgementPolicy: .firstRelay,
            expiresAt: expiresAt,
            encryptedProofOfWorkKey: selfWrap.encryptedProofOfWorkKey
        ))
        try await syncEngine.enqueueForPublish(requests)

        let allRelays = TaskifyRelayURL.normalizedList(senderRelays + recipientRelays)
        let boards = snapshot.boardsForSync
        Task { [syncEngine] in
            await syncEngine.configure(
                boards: boards,
                auxiliaryRelayURLs: allRelays,
                inboxPublicKey: identity.publicKeyHex,
                inboxRelayURLs: senderRelays
            )
        }
    }

    private struct GroupRelayResolutionInput: Sendable {
        let memberPublicKey: String
        let discoveryRelayURLs: [String]
    }

    func groupDeliveryRelays(
        group: NostrGroupConversation,
        identity: NostrIdentity
    ) async -> [String: [String]] {
        let inputs = group.memberPublicKeys.compactMap { member -> GroupRelayResolutionInput? in
            guard member != identity.publicKeyHex else { return nil }
            let discoveryRelays = directMessageDiscoveryRelayURLs(
                recipientPublicKey: member,
                groupID: group.groupID
            )
            guard !discoveryRelays.isEmpty else { return nil }
            return GroupRelayResolutionInput(
                memberPublicKey: member,
                discoveryRelayURLs: discoveryRelays
            )
        }
        let maximumConcurrentResolutions = 4
        return await withTaskGroup(
            of: (String, [String])?.self,
            returning: [String: [String]].self
        ) { taskGroup in
            var nextIndex = 0
            let initialCount = min(maximumConcurrentResolutions, inputs.count)
            for _ in 0..<initialCount {
                let input = inputs[nextIndex]
                nextIndex += 1
                taskGroup.addTask {
                    let relays = await NIP17InboxRelayResolver.resolve(
                        recipientPublicKey: input.memberPublicKey,
                        discoveryRelayURLs: input.discoveryRelayURLs
                    )
                    return relays.isEmpty ? nil : (input.memberPublicKey, relays)
                }
            }

            var result: [String: [String]] = [:]
            while let resolution = await taskGroup.next() {
                if let (member, relays) = resolution { result[member] = relays }
                if nextIndex < inputs.count {
                    let input = inputs[nextIndex]
                    nextIndex += 1
                    taskGroup.addTask {
                        let relays = await NIP17InboxRelayResolver.resolve(
                            recipientPublicKey: input.memberPublicKey,
                            discoveryRelayURLs: input.discoveryRelayURLs
                        )
                        return relays.isEmpty ? nil : (input.memberPublicKey, relays)
                    }
                }
            }
            return result
        }
    }

    private func currentDirectMessageTimestamp() -> Int {
        Int(Date().timeIntervalSince1970)
    }

    private func validNostrEventID(_ value: String?) -> String? {
        guard let normalized = value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
              normalized.count == 64,
              (try? Data(hex: normalized))?.count == 32 else { return nil }
        return normalized
    }

}

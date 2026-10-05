import Foundation
import os
import TaskifyCore

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
        replyToEventID: String? = nil
    ) async throws {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw NostrDirectMessageError.emptyMessage }
#if DEBUG
        if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_FIXTURE"] == "1",
           ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_CHAT_LOCAL_SENDS"] == "1" {
            // Exercise local insertion before composer clearing without publishing test data.
            let eventID = UUID().uuidString
            if snapshot.ingestDirectMessage(NostrDirectMessage(
                rumorEventID: eventID, wrapEventID: eventID,
                peerPublicKey: recipientValue, senderPublicKey: identityPublicKey,
                content: text, createdAt: currentDirectMessageTimestamp(), isIncoming: false,
                replyToEventID: replyToEventID
            )) {
                scheduleSave()
            }
            await Task.yield()
            return
        }
#endif
        try await publishDirectMessageRumorBatch(
            to: recipientValue,
            drafts: [DirectMessageRumorDraft(
                kind: NIP17GiftWrap.rumorKind,
                content: text,
                additionalTags: []
            )],
            replyToEventID: replyToEventID,
            attachmentComment: nil
        )
    }

    /// One file per kind 15 rumor (NIP-17 has no multi-file event), sent as a
    /// single ordered batch with an optional caption kind 14 after the files.
    func sendDirectMessageAttachments(
        to recipientValue: String,
        attachments: [NostrDirectMessageAttachment],
        replyToEventID: String? = nil,
        comment: String? = nil
    ) async throws {
        guard !attachments.isEmpty,
              attachments.count <= NostrDirectMessageAttachment.maximumBatchCount else {
            throw NostrDirectMessageError.invalidAttachment
        }
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
            attachmentComment: comment
        )
    }

    private func publishDirectMessageRumorBatch(
        to recipientValue: String,
        drafts: [DirectMessageRumorDraft],
        replyToEventID: String?,
        attachmentComment: String?
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
                attachmentComment: attachmentComment
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
        let fallbackRelays = directMessageDiscoveryRelayURLs(recipientPublicKey: recipientHex)
        guard !fallbackRelays.isEmpty else { throw NostrDirectMessageError.noRelays }
        let resolutionStartedAt = ProcessInfo.processInfo.systemUptime
        guard let deliveryPlan = await nip17DeliveryPlan(
            recipientPublicKey: recipientHex,
            discoveryRelayURLs: fallbackRelays,
            identity: identity
        ) else { throw NostrDirectMessageError.noRelays }
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

        // Strictly increasing timestamps keep a multi-file batch ordered on
        // every client; a single draft keeps today's exact wire behavior.
        let replyTag = validNostrEventID(replyToEventID).map { ["e", $0] }
        let baseCreatedAt = currentDirectMessageTimestamp()
        let cryptoStartedAt = ProcessInfo.processInfo.systemUptime
        let batch = try await TaskifyRelayProofOfWork.prepare(relays: deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs) {
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
            var routes = [identity.publicKeyHex: deliveryPlan.senderRelayURLs]
            routes[recipientHex] = deliveryPlan.recipientRelayURLs
            return try NIP17OutgoingMessageBatch(rumors: rumors, attachmentComment: attachmentComment,
                identity: identity, relayURLsByRecipient: routes)
        }
        os_signpost(
            .event,
            log: Self.dmPerformanceLog,
            name: "DM Gift Wrap",
            signpostID: sendSignpostID,
            "duration_ms=%.1f",
            (ProcessInfo.processInfo.systemUptime - cryptoStartedAt) * 1_000
        )
        let allDeliveryRelays = TaskifyRelayURL.normalizedList(
            deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs
        )
        let enqueueStartedAt = ProcessInfo.processInfo.systemUptime
        try await enqueueDirectMessageBatch(batch, identity: identity, isGroup: false)
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
        let wrapped = try await TaskifyRelayProofOfWork.prepare(relays: deliveryPlan.senderRelayURLs + deliveryPlan.recipientRelayURLs) {
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
            let recipientWrap = try NIP17GiftWrap.wrap(
                rumor: rumor,
                sender: identity,
                recipientPublicKey: recipientPublicKey
            )
            let senderWrap = isSelfMessage
                ? recipientWrap
                : try NIP17GiftWrap.wrap(
                    rumor: rumor,
                    sender: identity,
                    recipientPublicKey: identity.publicKey
                )
            return (rumor, recipientWrap, senderWrap)
        }
        let rumor = wrapped.0
        let recipientWrap = wrapped.1
        let senderWrap = wrapped.2
        let decrypted = NIP17DecryptedRumor(wrapEventID: senderWrap.id, rumor: rumor)
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
            event: recipientWrap,
            relayURLs: deliveryPlan.recipientRelayURLs,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):reaction:recipient",
            acknowledgementPolicy: .anyRelay,
            expiresAt: expiresAt
        )]
        if !isSelfMessage {
            requests.append(TaskSyncRelayPublishRequest(
                event: senderWrap,
                relayURLs: deliveryPlan.senderRelayURLs,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "\(rumor.id):reaction:sender",
                acknowledgementPolicy: .anyRelay,
                expiresAt: expiresAt
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
        attachmentComment: String?
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

        let batch = try await TaskifyRelayProofOfWork.prepare(relays: senderRelays + recipientRelays) {
            var routes = relayMap
            routes[identity.publicKeyHex] = senderRelays
            return try NIP17OutgoingMessageBatch(rumors: rumors, attachmentComment: attachmentComment,
                identity: identity, relayURLsByRecipient: routes)
        }
        let allRelays = TaskifyRelayURL.normalizedList(senderRelays + recipientRelays)
        try await enqueueDirectMessageBatch(batch, identity: identity, isGroup: true)
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

    private func enqueueDirectMessageBatch(
        _ batch: NIP17OutgoingMessageBatch,
        identity: NostrIdentity,
        isGroup: Bool
    ) async throws {
        guard identityPublicKey == identity.publicKeyHex else { throw NostrDirectMessageError.identityUnavailable }
        for message in batch.localMessages {
            if snapshot.ingestDirectMessage(message) { scheduleSave() }
        }
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
                acknowledgementPolicy: .anyRelay,
                expiresAt: expiresAt,
                dependsOnEventID: delivery.dependsOnEventID
            )
        }
        do {
            try await syncEngine.enqueueForPublish(requests)
        } catch {
            for message in batch.localMessages {
                if snapshot.setDirectMessageDeliveryState(rumorEventID: message.rumorEventID, state: .failed) {
                    scheduleSave()
                }
            }
            throw error
        }
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
        let wrapped = try await TaskifyRelayProofOfWork.prepare(relays: senderRelays + recipientRelays) {
            let selfWrap = try NIP17GiftWrap.wrap(
                rumor: rumor,
                sender: identity,
                recipientPublicKey: identity.publicKey
            )
            let deliveries = try recipientPlans.map { member, publicKey, relays in
                GroupGiftWrapDelivery(
                    memberPublicKey: member,
                    event: try NIP17GiftWrap.wrap(
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
            decrypted: NIP17DecryptedRumor(wrapEventID: selfWrap.id, rumor: rumor),
            identityPublicKey: identity.publicKeyHex
        ) else { throw NostrDirectMessageError.invalidGroup }
        if snapshot.ingestDirectMessageReaction(localReaction) { scheduleSave() }

        let expiresAt = Date().addingTimeInterval(48 * 60 * 60)
        var requests = wrapped.1.map { delivery in
            TaskSyncRelayPublishRequest(
                event: delivery.event,
                relayURLs: delivery.relayURLs,
                outboxScope: Self.directMessagesOutboxScope,
                recordID: "\(rumor.id):group-reaction:\(delivery.memberPublicKey)",
                acknowledgementPolicy: .anyRelay,
                expiresAt: expiresAt
            )
        }
        requests.append(TaskSyncRelayPublishRequest(
            event: selfWrap,
            relayURLs: senderRelays,
            outboxScope: Self.directMessagesOutboxScope,
            recordID: "\(rumor.id):group-reaction:sender",
            acknowledgementPolicy: .anyRelay,
            expiresAt: expiresAt
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

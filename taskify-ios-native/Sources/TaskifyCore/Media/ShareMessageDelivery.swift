import Foundation

public enum ShareDeliveryError: LocalizedError {
    case invalidRecipient, noRelays, invalidAttachment, emptyMessage
    public var errorDescription: String? {
        switch self {
        case .invalidRecipient: "This chat is no longer available for the current account."
        case .noRelays: "This chat has no advertised DM inbox relays. Open Taskify and try again."
        case .invalidAttachment: "The attachment is invalid."
        case .emptyMessage: "Enter a message or select a file."
        }
    }
}

public enum ShareMessageDelivery {
    /// Persist the complete, stable set of gift wraps before any network publication.
    /// Retries reuse the same event and rumor IDs, including after process termination.
    public static func prepare(_ input: ShareTransfer, identity: NostrIdentity, account: ShareAccount) async throws -> ShareTransfer {
        guard input.account == identity.publicKeyHex, account.publicKey == identity.publicKeyHex,
              let recipient = account.recipients.first(where: { $0.id == input.recipient.id }),
              recipient.members == input.recipient.members else { throw ShareDeliveryError.invalidRecipient }
        if !input.deliveries.isEmpty { return input }
        let targets = Array(Set(recipient.members + [identity.publicKeyHex])).sorted()
        guard targets.count <= NostrGroupConversation.maximumMemberCount else { throw ShareDeliveryError.invalidRecipient }
        var routes: [String: [String]] = [:]
        for target in targets {
            let relays = target == identity.publicKeyHex ? account.senderRelays
                : await NIP17InboxRelayResolver.resolveAdvertised(recipientPublicKey: target, discoveryRelayURLs: recipient.discoveryRelays)
            guard !relays.isEmpty else { throw ShareDeliveryError.noRelays }
            routes[target] = relays
        }
        let job = try prepared(input, identity: identity, routes: routes)
        try ShareTransferStore.save(job)
        return job
    }

    static func prepared(_ input: ShareTransfer, identity: NostrIdentity, routes: [String: [String]]) throws -> ShareTransfer {
        if !input.deliveries.isEmpty { return input }
        var job = input
        let recipient = job.recipient
        var tags = recipient.members.filter { $0 != identity.publicKeyHex }.map { ["p", $0] }
        if tags.isEmpty { tags = [["p", identity.publicKeyHex]] }
        if recipient.isGroup { tags.append(["subject", recipient.name]) }
        let kind: Int
        let content: String
        if job.remoteURL != nil || job.ciphertextName != nil || job.keyHex != nil || job.nonceHex != nil {
            guard let remote = job.remoteURL, let key = job.keyHex, let nonce = job.nonceHex,
                  let attachment = NostrDirectMessageAttachment(url: remote, mimeType: job.mimeType ?? "application/octet-stream",
                filename: job.filename, size: job.size, keyHex: key, nonceHex: nonce, sha256: job.sha256) else { throw ShareDeliveryError.invalidAttachment }
            tags += attachment.rumorTags
            kind = NostrDirectMessageAttachment.rumorKind
            content = remote
        } else {
            guard let text = job.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ShareDeliveryError.emptyMessage }
            kind = NIP17GiftWrap.rumorKind
            content = text
        }
        let rumor = try NIP17Rumor(publicKey: identity.publicKeyHex, createdAt: Int(job.createdAt.timeIntervalSince1970),
                                  kind: kind, tags: tags, content: content)
        let batch = try NIP17OutgoingMessageBatch(rumor: rumor,
            attachmentComment: kind == NostrDirectMessageAttachment.rumorKind ? job.text : nil,
            identity: identity, relayURLsByRecipient: routes)
        job.deliveries = batch.deliveries.map { delivery in
            ShareDelivery(event: delivery.event, relays: delivery.relayURLs,
                rumorEventID: delivery.rumorEventID, dependsOnEventID: delivery.dependsOnEventID)
        }
        job.localMessage = batch.localMessages.first
        job.additionalLocalMessages = Array(batch.localMessages.dropFirst())
        job.state = "sending"
        return job
    }

    public static func publish(_ input: ShareTransfer, identity: NostrIdentity) async throws -> ShareTransfer {
        try await deliver(input, save: ShareTransferStore.save) { delivery in
            for relay in delivery.relays {
                try Task.checkCancellation()
                guard let current = try? ShareTransferStore.account(), current.publicKey == input.account,
                      current.recipients.contains(where: { $0.id == input.recipient.id && $0.members == input.recipient.members }) else {
                    throw ShareDeliveryError.invalidRecipient
                }
                if await publish(delivery.event, relay: relay, identity: identity) { return true }
            }
            return false
        }
    }

    /// Each wave contains only parents, or replies whose parent was accepted in
    /// an earlier wave. Persist every acknowledgement before releasing a reply.
    static func deliver(
        _ input: ShareTransfer,
        save: (ShareTransfer) throws -> Void,
        send: @escaping @Sendable (ShareDelivery) async throws -> Bool
    ) async throws -> ShareTransfer {
        var job = input
        var attempted: Set<Int> = []
        while true {
            let ready = job.readyDeliveryIndices(excluding: attempted)
            if ready.isEmpty { break }
            attempted.formUnion(ready)
            try await withThrowingTaskGroup(of: (Int, Bool).self) { group in
                for index in ready {
                    let delivery = job.deliveries[index]
                    group.addTask { (index, try await send(delivery)) }
                }
                for try await (index, accepted) in group {
                    if accepted {
                        job.deliveries[index].accepted = true
                        try save(job)
                    }
                }
            }
        }
        guard job.deliveries.allSatisfy(\.accepted) else { throw URLError(.cannotConnectToHost) }
        job.state = "sent"
        job.error = nil
        job.localMessage?.deliveryState = .sent
        if let messages = job.additionalLocalMessages {
            job.additionalLocalMessages = messages.map { input in
                var message = input; message.deliveryState = .sent; return message
            }
        }
        try save(job)
        return job
    }

    private static func publish(_ event: NostrEvent, relay: String, identity: NostrIdentity) async -> Bool {
        let connection = NostrRelayConnection(relayURL: relay)
        let result = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                do {
                    try await connection.connect()
                    try await connection.publish(event)
                    var authID: String?
                    for await message in connection.messages() {
                        if Task.isCancelled { return false }
                        switch message {
                        case .acknowledgement(let id, let accepted, let message):
                            let duplicate = message.trimmingCharacters(in: .whitespacesAndNewlines)
                                .lowercased().hasPrefix("duplicate:")
                            if id == event.id, accepted || duplicate { return true }
                            if id == authID, accepted { try await connection.publish(event) }
                        case .auth(let challenge):
                            if authID == nil {
                                let auth = try NostrEvent.signed(privateKey: identity.privateKey, createdAt: Int(Date().timeIntervalSince1970),
                                    kind: NIP42AuthContract.eventKind, tags: [["relay", relay], ["challenge", challenge]], content: "")
                                authID = auth.id
                                try await connection.authenticate(auth)
                            }
                        case .disconnected: return false
                        default: break
                        }
                    }
                } catch { return false }
                return false
            }
            group.addTask { try? await Task.sleep(for: .seconds(8)); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            await connection.disconnect()
            return first
        }
        return result
    }
}

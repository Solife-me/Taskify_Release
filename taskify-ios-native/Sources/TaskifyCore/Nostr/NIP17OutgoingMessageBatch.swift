import Foundation

/// A recipient's independently encrypted copy of a message. A follow-up waits
/// for that recipient's parent wrap to be acknowledged before it is published.
public struct NIP17OutgoingDelivery: Sendable {
    public let rumorEventID: String
    public let recipientPublicKey: String
    public let event: NostrEvent
    public let relayURLs: [String]
    public let dependsOnEventID: String?
}

/// Constructs one or more attachments and their optional text reply together,
/// so callers can persist the whole send before publishing either message.
/// Multiple files stay one file per kind 15 rumor (NIP-17 has no multi-file
/// event), wrapped in order so each recipient receives the batch as staged.
public struct NIP17OutgoingMessageBatch: Sendable {
    public let localMessages: [NostrDirectMessage]
    public let deliveries: [NIP17OutgoingDelivery]

    public init(
        rumors: [NIP17Rumor],
        attachmentComment: String? = nil,
        identity: NostrIdentity,
        relayURLsByRecipient: [String: [String]]
    ) throws {
        guard let first = rumors.first else {
            throw NIP17GiftWrapError.invalidRumor
        }
        for rumor in rumors {
            guard rumor.publicKey == identity.publicKeyHex, rumor.verifyID() else {
                throw NIP17GiftWrapError.invalidRumor
            }
        }
        let targets = Set(first.recipientPublicKeys + [identity.publicKeyHex])
        let recipientSet = Set(first.recipientPublicKeys)
        guard !first.recipientPublicKeys.isEmpty,
              targets.count <= NostrGroupConversation.maximumMemberCount,
              targets == Set(relayURLsByRecipient.keys) else {
            throw NIP17GiftWrapError.wrongRecipient
        }
        for rumor in rumors.dropFirst() {
            guard Set(rumor.recipientPublicKeys) == recipientSet else {
                throw NIP17GiftWrapError.wrongRecipient
            }
        }
        var wrappedRumors = rumors
        let comment = attachmentComment?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !comment.isEmpty {
            guard NostrDirectMessageAttachment(rumor: first) != nil else {
                throw NIP17GiftWrapError.invalidRumor
            }
            // NIP-17 kind 15 content remains the file URL. The comment is a
            // separate kind 14 whose e tag names the last file's canonical
            // rumor, never its recipient-specific gift wrap. Only conversation
            // tags carry over; file keys and the attachment's own reply target
            // do not. Sharing the last file's createdAt keeps the single-file
            // wire behavior unchanged, and the same-second parent is what the
            // history reparenting uses to keep a caption after every file even
            // when events arrive out of order.
            let tags = first.tags.filter { $0.first == "p" || $0.first == "subject" }
                + [["e", rumors.last!.id]]
            wrappedRumors.append(try NIP17Rumor(publicKey: first.publicKey,
                createdAt: rumors.last!.createdAt, kind: NIP17GiftWrap.rumorKind,
                tags: tags, content: comment))
        }

        var messages: [NostrDirectMessage] = []
        var deliveries: [NIP17OutgoingDelivery] = []
        var previousWraps: [String: String] = [:]
        let allRelays = TaskifyRelayURL.normalizedList(relayURLsByRecipient.values.flatMap { $0 })
        for item in wrappedRumors {
            for target in targets.sorted() {
                guard let publicKey = NostrPublicKey.parse(target) else {
                    throw NIP17GiftWrapError.wrongRecipient
                }
                let relays = TaskifyRelayURL.normalizedList(relayURLsByRecipient[target] ?? [])
                guard !relays.isEmpty else { throw NIP17GiftWrapError.wrongRecipient }
                let event = try NIP17GiftWrap.wrap(rumor: item, sender: identity, recipientPublicKey: publicKey)
                deliveries.append(NIP17OutgoingDelivery(rumorEventID: item.id,
                    recipientPublicKey: target, event: event, relayURLs: relays,
                    dependsOnEventID: previousWraps[target]))
                previousWraps[target] = event.id
                if target == identity.publicKeyHex {
                    guard var message = NostrDirectMessage(
                        decrypted: NIP17DecryptedRumor(wrapEventID: event.id, rumor: item),
                        identityPublicKey: identity.publicKeyHex, relayURLs: allRelays
                    ) else { throw NIP17GiftWrapError.invalidRumor }
                    message.deliveryState = .queued
                    messages.append(message)
                }
            }
        }
        self.localMessages = messages
        self.deliveries = deliveries
    }

    public init(
        rumor: NIP17Rumor,
        attachmentComment: String? = nil,
        identity: NostrIdentity,
        relayURLsByRecipient: [String: [String]]
    ) throws {
        try self.init(rumors: [rumor], attachmentComment: attachmentComment,
            identity: identity, relayURLsByRecipient: relayURLsByRecipient)
    }
}

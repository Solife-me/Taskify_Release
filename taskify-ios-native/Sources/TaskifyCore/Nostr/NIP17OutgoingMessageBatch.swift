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

/// Constructs an attachment and its optional text reply together, so callers
/// can persist the whole send before publishing either message.
public struct NIP17OutgoingMessageBatch: Sendable {
    public let localMessages: [NostrDirectMessage]
    public let deliveries: [NIP17OutgoingDelivery]

    public init(
        rumor: NIP17Rumor,
        attachmentComment: String? = nil,
        identity: NostrIdentity,
        relayURLsByRecipient: [String: [String]]
    ) throws {
        guard rumor.publicKey == identity.publicKeyHex, rumor.verifyID() else {
            throw NIP17GiftWrapError.invalidRumor
        }
        let targets = Set(rumor.recipientPublicKeys + [identity.publicKeyHex])
        guard !rumor.recipientPublicKeys.isEmpty,
              targets.count <= NostrGroupConversation.maximumMemberCount,
              targets == Set(relayURLsByRecipient.keys) else {
            throw NIP17GiftWrapError.wrongRecipient
        }
        var rumors = [rumor]
        let comment = attachmentComment?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !comment.isEmpty {
            guard NostrDirectMessageAttachment(rumor: rumor) != nil else {
                throw NIP17GiftWrapError.invalidRumor
            }
            // NIP-17 kind 15 content remains the file URL. The comment is a
            // separate kind 14 whose e tag names the parent's canonical rumor,
            // never its recipient-specific gift wrap. Only conversation tags
            // carry over; file keys and the attachment's own reply target do not.
            let tags = rumor.tags.filter { $0.first == "p" || $0.first == "subject" }
                + [["e", rumor.id]]
            rumors.append(try NIP17Rumor(publicKey: rumor.publicKey,
                createdAt: rumor.createdAt, kind: NIP17GiftWrap.rumorKind,
                tags: tags, content: comment))
        }

        var messages: [NostrDirectMessage] = []
        var deliveries: [NIP17OutgoingDelivery] = []
        var previousWraps: [String: String] = [:]
        let allRelays = TaskifyRelayURL.normalizedList(relayURLsByRecipient.values.flatMap { $0 })
        for item in rumors {
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
}

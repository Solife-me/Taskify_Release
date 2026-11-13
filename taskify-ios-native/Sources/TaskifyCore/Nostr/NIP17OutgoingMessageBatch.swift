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
        let wrappedRumors = try Self.rumorsIncludingAttachmentComment(
            rumors,
            attachmentComment: attachmentComment
        )

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

    /// Builds the same local rows as a fully wrapped batch before relay discovery and gift
    /// wrapping finish. The rumor IDs are final, so ingesting the wrapped copy later reconciles
    /// with these rows instead of showing duplicates. The temporary wrap ID is intentionally the
    /// rumor ID; delivery-state reconciliation is keyed by the canonical rumor ID.
    public static func optimisticLocalMessages(
        rumors: [NIP17Rumor],
        attachmentComment: String? = nil,
        identity: NostrIdentity
    ) throws -> [NostrDirectMessage] {
        let completedRumors = try rumorsIncludingAttachmentComment(
            rumors,
            attachmentComment: attachmentComment
        )
        return try completedRumors.map { rumor in
            guard rumor.publicKey == identity.publicKeyHex,
                  rumor.verifyID(),
                  var message = NostrDirectMessage(
                      decrypted: NIP17DecryptedRumor(wrapEventID: rumor.id, rumor: rumor),
                      identityPublicKey: identity.publicKeyHex
                  ) else {
                throw NIP17GiftWrapError.invalidRumor
            }
            message.deliveryState = .queued
            return message
        }
    }

    private static func rumorsIncludingAttachmentComment(
        _ rumors: [NIP17Rumor],
        attachmentComment: String?
    ) throws -> [NIP17Rumor] {
        guard let first = rumors.first else { throw NIP17GiftWrapError.invalidRumor }
        var completedRumors = rumors
        let comment = attachmentComment?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !comment.isEmpty else { return completedRumors }
        guard NostrDirectMessageAttachment(rumor: first) != nil,
              let last = rumors.last else {
            throw NIP17GiftWrapError.invalidRumor
        }
        // NIP-17 kind 15 content remains the file URL. The comment is a separate kind 14 whose
        // e tag names the last file's canonical rumor. Matching this construction for the early
        // local echo guarantees that the optimistic and wrapped caption have the same event ID.
        let tags = first.tags.filter { $0.first == "p" || $0.first == "subject" }
            + [["e", last.id]]
        completedRumors.append(try NIP17Rumor(
            publicKey: first.publicKey,
            createdAt: last.createdAt,
            kind: NIP17GiftWrap.rumorKind,
            tags: tags,
            content: comment
        ))
        return completedRumors
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

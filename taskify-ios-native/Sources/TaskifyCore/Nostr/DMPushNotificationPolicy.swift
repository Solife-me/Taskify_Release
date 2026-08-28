import Foundation

public enum DMPushNotificationCategory: String, Codable, CaseIterable, Sendable {
    case message
    case paymentReceived
}

public enum DMPushNotificationSelection: String, Codable, CaseIterable, Sendable {
    case messages
    case payments
    case both

    public var title: String {
        switch self {
        case .messages: "New messages"
        case .payments: "Ecash payments"
        case .both: "Messages & payments"
        }
    }

    public func allows(_ category: DMPushNotificationCategory) -> Bool {
        switch (self, category) {
        case (.messages, .message), (.payments, .paymentReceived), (.both, _): true
        default: false
        }
    }
}

public enum DMPushNotificationSharedSettings {
    public static let selectionKey = "taskify.dmPush.selection"

    public static var selection: DMPushNotificationSelection {
        selection(defaults: UserDefaults(suiteName: TaskifySharedContainer.appGroupID))
    }

    public static func selection(defaults: UserDefaults?) -> DMPushNotificationSelection {
        guard let rawValue = defaults?.string(forKey: selectionKey) else { return .both }
        return DMPushNotificationSelection(rawValue: rawValue) ?? .both
    }

    public static func saveSelection(
        _ selection: DMPushNotificationSelection,
        defaults: UserDefaults? = UserDefaults(suiteName: TaskifySharedContainer.appGroupID)
    ) {
        defaults?.set(selection.rawValue, forKey: selectionKey)
    }
}

/// Classification intentionally runs only after NIP-17 decryption on the recipient device. The
/// push relay and APNs receive the same content-free wake for every gift wrap, so neither learns
/// whether the event is a conversation or an ecash payment.
public enum DMPushNotificationPolicy {
    public static func category(forIncomingContent content: String) -> DMPushNotificationCategory {
        if CashuPaymentRequestContract.extractReceivableToken(from: content) != nil {
            return .paymentReceived
        }
        return .message
    }
}

public enum DMPushNotificationPresentation: Equatable, Sendable {
    case activity(title: String, subtitle: String?, body: String)

    public var title: String {
        guard case .activity(let title, _, _) = self else { return "" }
        return title
    }

    public var subtitle: String? {
        guard case .activity(_, let subtitle, _) = self else { return nil }
        return subtitle
    }

    public var body: String {
        guard case .activity(_, _, let body) = self else { return "" }
        return body
    }
}

/// Converts an already decrypted NIP-17 rumor into notification text. The relay and APNs never
/// receive this result; it is produced only in Taskify's notification service extension.
public enum DMPushNotificationPreviewPolicy {
    public static func presentation(
        for decrypted: NIP17DecryptedRumor,
        identityPublicKey: String,
        contacts: [NostrContact],
        selection: DMPushNotificationSelection
    ) -> DMPushNotificationPresentation? {
        guard selection.allows(.message) else { return nil }
        let rumor = decrypted.rumor
        let identity = identityPublicKey.lowercased()
        guard rumor.publicKey.lowercased() != identity else { return nil }
        guard CashuPaymentRequestContract.extractReceivableToken(from: rumor.content) == nil else {
            return nil
        }

        let sender = senderLabel(publicKey: rumor.publicKey, contacts: contacts)
        let body: String
        if let envelope = TaskifyShareEnvelope.decode(content: rumor.content) {
            body = shareDescription(envelope.item)
        } else if let reaction = NostrDirectMessageReaction(
            decrypted: decrypted,
            identityPublicKey: identity
        ) {
            body = reaction.isRemoval ? "Removed a reaction" : "Reacted \(reaction.emoji)"
        } else if let message = NostrDirectMessage(
            decrypted: decrypted,
            identityPublicKey: identity
        ), message.isIncoming {
            body = messagePreview(message.displayContent)
        } else if let group = NostrGroupConversation(
            rumor: rumor,
            identityPublicKey: identity
        ), rumor.tags.contains(where: { $0.count >= 2 && $0[0] == "subject" }) {
            body = group.name.isEmpty ? "Updated a group conversation" : "Updated group: \(group.name)"
        } else {
            return nil
        }
        return .activity(title: sender.title, subtitle: sender.subtitle, body: body)
    }

    public static func messagePreview(_ content: String, maximumLines: Int = 3, maximumCharacters: Int = 240) -> String {
        let lines = content
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let joined = lines.prefix(max(1, maximumLines)).joined(separator: "\n")
        guard joined.count > maximumCharacters else { return joined }
        return String(joined.prefix(max(1, maximumCharacters - 1))) + "…"
    }

    private static func senderLabel(
        publicKey: String,
        contacts: [NostrContact]
    ) -> (title: String, subtitle: String?) {
        if let contact = contacts.first(where: {
            $0.publicKey.caseInsensitiveCompare(publicKey) == .orderedSame
        }) {
            return (contact.displayName, nil)
        }
        guard let key = NostrPublicKey.parse(publicKey),
              let npub = NostrPublicKey.npub(from: key) else {
            return ("Unknown sender", nil)
        }
        let short = npub.count > 22 ? "\(npub.prefix(12))…\(npub.suffix(6))" : npub
        return ("Unknown sender", short)
    }

    private static func shareDescription(_ item: TaskifyShareItem) -> String {
        switch item {
        case .task(let task):
            return task.isAssignment
                ? "New task assignment: \(task.title)"
                : "Shared a task: \(task.title)"
        case .contact(let contact):
            return "Shared a contact: \(contact.primaryName)"
        case .calendarEvent(let event):
            return "New invitation: \(event.displayTitle)"
        case .assignmentResponse(let response):
            let status = switch response.status {
            case .accepted: "accepted"
            case .declined: "declined"
            case .tentative: "marked maybe"
            case .pending: "updated"
            }
            return "Task assignment \(status)"
        case .board(let board):
            return "New board invitation: \(board.boardName ?? "Board")"
        }
    }
}

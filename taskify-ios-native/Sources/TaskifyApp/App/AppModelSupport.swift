import Foundation
import TaskifyCore

struct BoardTemplateShareResult: Sendable {
    let board: Board
    let queuedTaskCount: Int
    let failedTaskCount: Int
    let queuedEventCount: Int
    let failedEventCount: Int
}

enum BoardTemplateShareError: LocalizedError {
    case boardUnavailable
    case unsupportedBoard

    var errorDescription: String? {
        switch self {
        case .boardUnavailable:
            "That board is no longer available."
        case .unsupportedBoard:
            "Template sharing currently supports week and list boards."
        }
    }
}

struct SharedTaskSendResult: Sendable {
    let recipientNpub: String
    let relayCount: Int
    let assignment: Bool
}

enum NostrContactDirectoryError: LocalizedError {
    case identityUnavailable
    case invalidPublicKey
    case cannotAddSelf
    case noRelays
    case contactUnavailable

    var errorDescription: String? {
        switch self {
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidPublicKey: "Enter a valid npub or 64-character public key."
        case .cannotAddSelf: "Your own Nostr account does not need to be added as a contact."
        case .noRelays: "No Nostr relays are configured for contact sync."
        case .contactUnavailable: "That contact is no longer available."
        }
    }
}

enum ProfilePictureUploadError: LocalizedError {
    case invalidServer

    var errorDescription: String? {
        switch self {
        case .invalidServer: "The configured file server URL is invalid."
        }
    }
}

enum SharedTaskSendError: LocalizedError {
    case taskUnavailable
    case eventUnavailable
    case identityUnavailable
    case invalidRecipient
    case cannotSendToSelf
    case noRelays

    var errorDescription: String? {
        switch self {
        case .taskUnavailable: "That task is no longer available."
        case .eventUnavailable: "That event is not available for sharing."
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "Enter a valid npub or 64-character public key."
        case .cannotSendToSelf: "Choose another Nostr account as the recipient."
        case .noRelays: "No Nostr relays are configured for delivery."
        }
    }
}

enum StructuredShareSendError: LocalizedError {
    case contactUnavailable
    case boardUnavailable
    case identityUnavailable
    case invalidRecipient
    case cannotSendToSelf
    case noRelays

    var errorDescription: String? {
        switch self {
        case .contactUnavailable: "That contact is no longer available."
        case .boardUnavailable: "That board is no longer available."
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "That conversation has an invalid Nostr public key."
        case .cannotSendToSelf: "Choose another Nostr account as the recipient."
        case .noRelays: "No Nostr relays are configured for delivery."
        }
    }
}

enum NostrDirectMessageError: LocalizedError {
    case identityUnavailable
    case invalidRecipient
    case emptyMessage
    case noRelays
    case invalidAttachment
    case invalidGroup
    case groupUnavailable
    case emptyGroupName
    case leftGroup

    var errorDescription: String? {
        switch self {
        case .identityUnavailable: "Your Nostr identity is unavailable."
        case .invalidRecipient: "That conversation has an invalid Nostr public key."
        case .emptyMessage: "Enter a message before sending."
        case .noRelays: "No Nostr inbox relays are available for this recipient."
        case .invalidAttachment: "That encrypted attachment is invalid or incomplete."
        case .invalidGroup: "Choose at least two contacts. Groups can contain up to 17 people including you."
        case .groupUnavailable: "That group conversation is no longer available."
        case .emptyGroupName: "Enter a group name before saving."
        case .leftGroup: "Rejoin this group before sending a message."
        }
    }
}

/// The account-level relay set, stored per device. Falls back to the built-in defaults until
/// the user edits it.
enum AppRelaySettings {
    private static let key = "taskify.sync.appRelays"

    static var urls: [String] {
        let stored = UserDefaults.standard.stringArray(forKey: key) ?? []
        let normalized = TaskifyRelayURL.normalizedList(stored)
        return normalized.isEmpty ? TaskifyRelayDefaults.urls : normalized
    }

    static func setURLs(_ urls: [String]) {
        UserDefaults.standard.set(TaskifyRelayURL.normalizedList(urls), forKey: key)
    }
}

/// Relays the user removed from this device's sync list. Device-local: nothing is published and
/// board relay lists are untouched—the app just stops connecting to, publishing to, and waiting
/// on these relays.
enum SyncExcludedRelaySettings {
    private static let key = "taskify.sync.excludedRelays"

    static var urls: Set<String> {
        let stored = UserDefaults.standard.stringArray(forKey: key) ?? []
        return Set(TaskifyRelayURL.normalizedList(stored))
    }

    static func setURLs(_ urls: Set<String>) {
        UserDefaults.standard.set(urls.sorted(), forKey: key)
    }
}

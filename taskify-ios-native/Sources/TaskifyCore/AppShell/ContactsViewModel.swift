import Foundation

public enum ContactsListState: Equatable {
    case loading
    case empty
    case ready
    case error(String)
}

public struct ContactField: Identifiable, Equatable, Sendable {
    public var id: String { key }
    public let key: String
    public let label: String
    public let value: String
    public let multiline: Bool
    public let verified: Bool

    public init(
        key: String,
        label: String,
        value: String,
        multiline: Bool = false,
        verified: Bool = false
    ) {
        self.key = key
        self.label = label
        self.value = value
        self.multiline = multiline
        self.verified = verified
    }
}

public struct ContactSubtitlePresentation: Equatable, Sendable {
    public let text: String
    public let verified: Bool

    public init(text: String, verified: Bool = false) {
        self.text = text
        self.verified = verified
    }
}

@MainActor
public final class ContactsViewModel: ObservableObject {
    @Published public private(set) var state: ContactsListState = .loading
    @Published public private(set) var contacts: [TaskifyContactRecord] = []
    @Published public private(set) var publicFollows: [TaskifyPublicFollowRecord] = []
    @Published public private(set) var nip05Checks: [String: Nip05CheckState] = [:]

    public init() {}

    public func setContacts(_ contacts: [TaskifyContactRecord]) {
        self.contacts = contacts
        state = contacts.isEmpty ? .empty : .ready
    }

    public func setPublicFollows(_ follows: [TaskifyPublicFollowRecord]) {
        publicFollows = follows
    }

    public func setNip05Checks(_ checks: [String: Nip05CheckState]) {
        nip05Checks = checks
    }

    public func setLoading() {
        state = .loading
    }

    public func setError(_ message: String) {
        state = .error(message)
    }

    public func filteredContacts(searchText: String) -> [TaskifyContactRecord] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return contacts }
        return contacts.filter { contact in
            [
                contact.name,
                contact.displayName ?? "",
                contact.username ?? "",
                contact.address,
                contact.nip05 ?? "",
                contact.npub,
            ]
            .joined(separator: "\n")
            .lowercased()
            .contains(query)
        }
    }

    public func importableFollows(searchText: String = "") -> [TaskifyPublicFollowRecord] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let existingKeys = Set(contacts.compactMap { try? NostrIdentityService.normalizePublicKeyInput($0.npub) })
        return publicFollows.filter { follow in
            guard !existingKeys.contains(follow.pubkey) else { return false }
            guard !query.isEmpty else { return true }
            return [
                follow.petname ?? "",
                follow.username ?? "",
                follow.nip05 ?? "",
                follow.pubkey,
                formatContactNpub(follow.pubkey),
            ]
            .joined(separator: "\n")
            .lowercased()
            .contains(query)
        }
    }

    public func verifiedNip05(for contact: TaskifyContactRecord) -> String? {
        contactVerifiedNip05(contact: contact, cache: nip05Checks)
    }

    public func subtitle(
        for contact: TaskifyContactRecord,
        isProfile: Bool = false
    ) -> ContactSubtitlePresentation? {
        if isProfile {
            let lightning = contact.address.trimmingCharacters(in: .whitespacesAndNewlines)
            if !lightning.isEmpty {
                return ContactSubtitlePresentation(text: lightning)
            }
            if let normalizedNip05 = normalizeNip05(contact.nip05) {
                return ContactSubtitlePresentation(text: normalizedNip05)
            }
            let npub = formatContactNpub(contact.npub)
            return npub.isEmpty ? nil : ContactSubtitlePresentation(text: npub)
        }

        if let verifiedNip05 = verifiedNip05(for: contact) {
            return ContactSubtitlePresentation(text: verifiedNip05, verified: true)
        }

        let normalizedNip05 = normalizeNip05(contact.nip05)
        if !contactHasNpub(contact), let normalizedNip05 {
            return ContactSubtitlePresentation(text: normalizedNip05)
        }

        let lightning = contact.address.trimmingCharacters(in: .whitespacesAndNewlines)
        if !lightning.isEmpty {
            return ContactSubtitlePresentation(text: lightning)
        }

        let npub = formatContactNpub(contact.npub)
        if !npub.isEmpty {
            return ContactSubtitlePresentation(text: npub)
        }

        let paymentRequest = contact.paymentRequest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !paymentRequest.isEmpty {
            return ContactSubtitlePresentation(text: "Payment request saved")
        }

        let displayName = contact.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return displayName.isEmpty ? nil : ContactSubtitlePresentation(text: displayName)
    }

    public func isFollowed(_ contact: TaskifyContactRecord) -> Bool {
        guard let publicKeyHex = try? NostrIdentityService.normalizePublicKeyInput(contact.npub) else {
            return false
        }
        return publicFollows.contains { $0.pubkey == publicKeyHex }
    }

    public func canFollow(
        _ contact: TaskifyContactRecord,
        isProfile: Bool = false
    ) -> Bool {
        guard !isProfile, contact.kind != .custom else { return false }
        return normalizeNostrPubkeyHex(contact.npub) != nil
    }

    public func fields(for contact: TaskifyContactRecord) -> [ContactField] {
        let username = formatContactUsername(contact.username)
        let npub = formatContactNpub(contact.npub)
        let verifiedNip05Value = verifiedNip05(for: contact)
        let normalizedNip05 = normalizeNip05(contact.nip05)
        return [
            !contact.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? ContactField(key: "lightning", label: "Lightning", value: contact.address)
                : nil,
            !npub.isEmpty
                ? ContactField(key: "npub", label: "Nostr pubkey", value: npub)
                : nil,
            normalizedNip05 != nil
                ? ContactField(
                    key: "nip05",
                    label: "NIP-05",
                    value: normalizedNip05 ?? "",
                    verified: normalizedNip05 == normalizeNip05(verifiedNip05Value)
                )
                : nil,
            !username.isEmpty
                ? ContactField(key: "username", label: "Username", value: username)
                : nil,
            !(contact.about ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? ContactField(key: "about", label: "About", value: contact.about ?? "", multiline: true)
                : nil,
        ]
        .compactMap { $0 }
    }
}

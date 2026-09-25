import Foundation

public extension TaskifySnapshot {
    var contactDirectory: [NostrContact] {
        (contacts ?? []).sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    func shareContacts(matching query: String) -> [NostrContact] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = contactDirectory.filter {
            query.isEmpty || NostrPublicKey.parse(query) != nil ||
                $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
        return matches
    }

    func contact(publicKeyValue: String) -> NostrContact? {
        guard let key = NostrPublicKey.parse(publicKeyValue)?.hexString else { return nil }
        return contacts?.first { $0.publicKey == key }
    }

    @discardableResult
    mutating func replaceContacts(
        from list: NIP51ContactList
    ) -> Bool {
        guard contactsListUpdatedAt == nil || list.eventCreatedAt > (contactsListUpdatedAt ?? 0) else {
            return false
        }
        let cachedProfiles = Dictionary(
            (contacts ?? []).compactMap { contact in
                contact.profile.map { (contact.publicKey, $0) }
            },
            uniquingKeysWith: { first, _ in first }
        )
        contacts = list.contacts.map { contact in
            var merged = contact
            merged.profile = cachedProfiles[contact.publicKey]
            return merged
        }
        contactsListUpdatedAt = list.eventCreatedAt
        contactsListExtraTags = list.extraTags
        return true
    }

    @discardableResult
    mutating func upsertContact(
        publicKeyValue: String,
        relayURLs: [String],
        petname: String?,
        updatedAt: Int
    ) -> NostrContact? {
        guard var contact = NostrContact(
            publicKeyValue: publicKeyValue,
            relayURLs: relayURLs,
            petname: petname
        ) else { return nil }
        var values = contacts ?? []
        if let index = values.firstIndex(where: { $0.publicKey == contact.publicKey }) {
            contact.profile = values[index].profile
            values[index] = contact
        } else {
            values.append(contact)
        }
        contacts = values
        contactsListUpdatedAt = max(updatedAt, contactsListUpdatedAt ?? 0)
        return contact
    }

    @discardableResult
    mutating func removeContact(publicKeyValue: String, updatedAt: Int) -> Bool {
        guard let key = NostrPublicKey.parse(publicKeyValue)?.hexString else { return false }
        var values = contacts ?? []
        let originalCount = values.count
        values.removeAll { $0.publicKey == key }
        guard values.count != originalCount else { return false }
        contacts = values
        contactsListUpdatedAt = max(updatedAt, contactsListUpdatedAt ?? 0)
        return true
    }

    @discardableResult
    mutating func applyContactProfiles(
        _ profiles: [String: NostrContactProfile]
    ) -> Bool {
        guard !profiles.isEmpty else { return false }
        var values = contacts ?? []
        var changed = false
        for index in values.indices {
            guard let incoming = profiles[values[index].publicKey],
                  incoming.eventCreatedAt >= (values[index].profile?.eventCreatedAt ?? 0),
                  values[index].profile != incoming else { continue }
            values[index].profile = incoming
            changed = true
        }
        if changed { contacts = values }
        return changed
    }
}

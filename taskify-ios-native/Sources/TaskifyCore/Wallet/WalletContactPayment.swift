import Foundation

/// Wire formats for paying a Nostr contact.
///
/// Both of these have to agree with the PWA exactly: the Lightning address decides where money
/// lands, and the direct message is read by whatever Nostr client the recipient happens to use.
/// They live here, away from the views, so they can be pinned down by tests.
public enum WalletContactPayment {
    /// Where to send a Lightning payment for a contact.
    ///
    /// Falls back to the contact's `npub@solife.me` when their profile advertises no Lightning
    /// address. That fallback is what makes every Nostr contact payable without them having set
    /// anything up: solife.me forwards to the npub as ecash.
    public static func lightningAddress(
        lud16: String?,
        npub: String,
        domain: String = SolifeClient.domain
    ) -> String {
        if let lud16 = lud16?.trimmingCharacters(in: .whitespacesAndNewlines),
           isLightningAddressShaped(lud16) {
            return lud16
        }
        return "\(npub)@\(domain)"
    }

    /// The body of the NIP-17 direct message that carries an ecash token, byte for byte as the
    /// PWA composes it (`useContactPaymentActions.ts`'s `dmPlain`) so a token sent from either app
    /// reads identically. The leading `nostr:` mention lets clients render the sender inline.
    public static func ecashDirectMessage(
        senderNpub: String,
        formattedAmount: String,
        token: String
    ) -> String {
        "nostr:\(senderNpub) sent you \(formattedAmount) from Taskify wallet!\n\(token)"
    }

    /// A deliberately loose check -- just enough to tell a usable `name@domain` from an empty or
    /// malformed profile field. Resolution proper is LNURL's job.
    static func isLightningAddressShaped(_ value: String) -> Bool {
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty, parts[1].contains(".") else {
            return false
        }
        return !value.lowercased().hasPrefix("ln")
    }
}

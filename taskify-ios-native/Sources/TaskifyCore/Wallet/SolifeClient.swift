import Foundation

/// A `<npub>@solife.me` Lightning address. Unlike npub.cash, solife.me is a pure forwarder: it
/// receives the Lightning payment on the user's behalf and immediately forwards it as eCash in a
/// NIP-17 DM to the matching npub. There's no account to create and nothing to poll or claim —
/// any Nostr key already works, and the incoming DM is picked up by the same generic
/// incoming-token detection that handles any other unsolicited Cashu DM (see
/// `CashuIncomingTokenInboxStore`). This type only derives the address to display.
public enum SolifeClient {
    public static let domain = "solife.me"

    public static func address(npub: String) -> String {
        "\(npub)@\(domain)"
    }
}

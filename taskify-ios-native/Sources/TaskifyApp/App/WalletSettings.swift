import Foundation

/// Local device settings for optional wallet-adjacent Nostr sync, matching the PWA's
/// `walletContactsSyncEnabled` setting.
enum WalletSettings {
    private static let contactsSyncEnabledKey = "taskify.wallet.contactsSyncEnabled"

    /// Defaults to on, matching the PWA.
    static var contactsSyncEnabled: Bool {
        UserDefaults.standard.object(forKey: contactsSyncEnabledKey) as? Bool ?? true
    }

    static func setContactsSyncEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: contactsSyncEnabledKey)
    }
}

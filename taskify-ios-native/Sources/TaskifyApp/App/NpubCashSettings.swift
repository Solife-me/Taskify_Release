import Foundation

/// Local device settings for npub.cash Lightning-address receiving, matching the PWA's
/// `npubCashLightningAddressEnabled` / `npubCashAutoClaim` (scoped to npub.cash only — the PWA's
/// solife.me provider isn't ported, since it depends on Taskify's own backend and a paid custom
/// handle purchase flow).
enum NpubCashSettings {
    private static let receivingEnabledKey = "taskify.npubCash.receivingEnabled"
    private static let autoClaimEnabledKey = "taskify.npubCash.autoClaimEnabled"

    /// Defaults to off — there is no native equivalent of the PWA's solife.me-by-default
    /// provider, so an explicit opt-in is the correct native default.
    static var receivingEnabled: Bool {
        UserDefaults.standard.bool(forKey: receivingEnabledKey)
    }

    /// Defaults to off, matching the PWA.
    static var autoClaimEnabled: Bool {
        UserDefaults.standard.bool(forKey: autoClaimEnabledKey)
    }

    static func setReceivingEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: receivingEnabledKey)
    }

    static func setAutoClaimEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: autoClaimEnabledKey)
    }
}

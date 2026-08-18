import Foundation

/// Which service (if any) resolves the Lightning address shown on Receive, matching the PWA's
/// `lightningAddressProvider` setting.
enum LightningAddressProvider: String, CaseIterable, Identifiable {
    case solife = "solife.me"
    case npubCash = "npub.cash"
    case none = "None"

    var id: String { rawValue }
    var displayName: String { rawValue }
}

/// Local device settings for Lightning-address receiving, matching the PWA's
/// `lightningAddressProvider` / `npubCashAutoClaim` / `solifeLightningAddress`.
enum LightningAddressSettings {
    private static let providerKey = "taskify.lightningAddress.provider"
    private static let autoClaimEnabledKey = "taskify.npubCash.autoClaimEnabled"
    private static let selectedSolifeAddressKey = "taskify.solife.selectedAddress"

    /// Defaults to solife.me: a pure forwarder that needs no signup or opt-in, matching the PWA's
    /// default provider and this app's original always-on behavior.
    static var provider: LightningAddressProvider {
        UserDefaults.standard.string(forKey: providerKey).flatMap(LightningAddressProvider.init(rawValue:)) ?? .solife
    }

    /// Defaults to off, matching the PWA.
    static var autoClaimEnabled: Bool {
        UserDefaults.standard.bool(forKey: autoClaimEnabledKey)
    }

    /// A custom solife.me address the user chose to show on Receive instead of the default
    /// npub-derived one. `nil` means "use the default".
    static var selectedSolifeAddress: String? {
        let value = UserDefaults.standard.string(forKey: selectedSolifeAddressKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return (value?.isEmpty == false) ? value : nil
    }

    static func setProvider(_ provider: LightningAddressProvider) {
        UserDefaults.standard.set(provider.rawValue, forKey: providerKey)
        if provider != .npubCash {
            setAutoClaimEnabled(false)
        }
    }

    static func setAutoClaimEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: autoClaimEnabledKey)
    }

    static func setSelectedSolifeAddress(_ address: String?) {
        let trimmed = address?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let trimmed, !trimmed.isEmpty {
            UserDefaults.standard.set(trimmed, forKey: selectedSolifeAddressKey)
        } else {
            UserDefaults.standard.removeObject(forKey: selectedSolifeAddressKey)
        }
    }
}

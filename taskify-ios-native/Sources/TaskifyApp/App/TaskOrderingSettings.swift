import Foundation
import TaskifyCore

/// Local device setting for where a quick-added task lands within its column, matching the
/// PWA's `newTaskPosition` setting.
enum TaskOrderingSettings {
    private static let positionKey = "taskify.newTaskPosition"

    /// Defaults to top, matching the PWA.
    static var position: NewTaskPosition {
        UserDefaults.standard.string(forKey: positionKey).flatMap(NewTaskPosition.init(rawValue:)) ?? .top
    }

    static func setPosition(_ position: NewTaskPosition) {
        UserDefaults.standard.set(position.rawValue, forKey: positionKey)
    }
}

/// Local PWA-compatible week-boundary preference. The PWA deliberately offers these three
/// common starts rather than inheriting a locale value that may differ across collaborators.
enum WeekLayoutSettings {
    private static let startKey = "taskify.weekStart"

    static var start: WeekdayColumn {
        guard let stored = UserDefaults.standard.string(forKey: startKey),
              let weekday = WeekdayColumn(rawValue: stored),
              WeekdayColumn.supportedWeekStarts.contains(weekday) else {
            return .sunday
        }
        return weekday
    }

    static func setStart(_ weekday: WeekdayColumn) {
        guard WeekdayColumn.supportedWeekStarts.contains(weekday) else { return }
        UserDefaults.standard.set(weekday.rawValue, forKey: startKey)
    }
}

/// Local presentation preferences shared by Settings and the native board/task cards. These
/// mirror the PWA's `completedTab` and `hideCompletedSubtasks` settings while remaining
/// device-specific appearance choices rather than synced board/task data.
enum TaskPresentationSettings {
    static let completedTabKey = "taskify.view.completedTab"
    static let hideCompletedSubtasksKey = "taskify.view.hideCompletedSubtasks"
    static let showFullWeekRecurringKey = "taskify.view.showFullWeekRecurring"

    static let completedTabDefault = true
    static let hideCompletedSubtasksDefault = false
    static let showFullWeekRecurringDefault = false
}

/// Device-local Chat retention, using the same identifiers and default as the PWA. The selected
/// value is also mirrored into the encrypted account backup when one is connected.
enum ChatHistorySettings {
    static let pwaSettingsKey = "chatMessageRetention"
    private static let retentionKey = "taskify.chat.messageRetention"

    static var retention: ChatMessageRetention {
        UserDefaults.standard.string(forKey: retentionKey)
            .flatMap(ChatMessageRetention.init(rawValue:)) ?? .forever
    }

    static func setRetention(_ retention: ChatMessageRetention) {
        UserDefaults.standard.set(retention.rawValue, forKey: retentionKey)
    }
}

/// Device-local wallet currency-display preferences, using the PWA's own field names/defaults
/// (`walletConversionEnabled` default true, `walletPrimaryCurrency` default "sat",
/// `walletDenominationDisplay` default "bitcoin-symbol") and mirroring the invariant the PWA
/// enforces on every settings write: `primaryCurrency` can only be `.usd` while conversion is
/// enabled, and is forced back to `.sat` the instant it's turned off.
enum WalletCurrencySettings {
    static let conversionEnabledPWAKey = "walletConversionEnabled"
    static let primaryCurrencyPWAKey = "walletPrimaryCurrency"
    static let denominationDisplayPWAKey = "walletDenominationDisplay"

    private static let conversionEnabledKey = "taskify.wallet.conversionEnabled"
    private static let primaryCurrencyKey = "taskify.wallet.primaryCurrency"
    private static let denominationDisplayKey = "taskify.wallet.denominationDisplay"

    static var conversionEnabled: Bool {
        (UserDefaults.standard.object(forKey: conversionEnabledKey) as? Bool) ?? true
    }

    static var primaryCurrency: WalletPrimaryCurrency {
        guard conversionEnabled,
              let stored = UserDefaults.standard.string(forKey: primaryCurrencyKey),
              let currency = WalletPrimaryCurrency(rawValue: stored) else {
            return .sat
        }
        return currency
    }

    static var denominationDisplay: WalletDenominationDisplay {
        UserDefaults.standard.string(forKey: denominationDisplayKey)
            .flatMap(WalletDenominationDisplay.init(rawValue:)) ?? .bitcoinSymbol
    }

    static func setConversionEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: conversionEnabledKey)
        if !enabled {
            UserDefaults.standard.set(WalletPrimaryCurrency.sat.rawValue, forKey: primaryCurrencyKey)
        }
    }

    static func setPrimaryCurrency(_ currency: WalletPrimaryCurrency) {
        guard conversionEnabled else { return }
        UserDefaults.standard.set(currency.rawValue, forKey: primaryCurrencyKey)
    }

    static func setDenominationDisplay(_ display: WalletDenominationDisplay) {
        UserDefaults.standard.set(display.rawValue, forKey: denominationDisplayKey)
    }
}

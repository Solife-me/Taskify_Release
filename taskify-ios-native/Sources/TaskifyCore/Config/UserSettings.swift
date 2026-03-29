/// UserSettings.swift
/// App settings model matching the PWA's Settings type for cross-compatibility.
/// Persisted to UserDefaults (equivalent to the PWA's local storage payload).

import Foundation

// MARK: - Accent color choice

public enum AccentChoice: String, Codable, CaseIterable, Identifiable {
    case blue
    case green
    case background

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .blue: return "iMessage blue"
        case .green: return "Mint green"
        case .background: return "Photo accent"
        }
    }

    public var fill: String {
        switch self {
        case .blue: return "#0a84ff"
        case .green: return "#34c759"
        case .background: return "#0a84ff"
        }
    }
}

// MARK: - Appearance mode

public enum AppearanceMode: String, Codable, CaseIterable, Identifiable {
    case system
    case light
    case dark

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }
}

// MARK: - New task position

public enum NewTaskPosition: String, Codable, CaseIterable, Identifiable {
    case top
    case bottom

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .top: return "Top"
        case .bottom: return "Bottom"
        }
    }
}

public enum BackgroundBlurMode: String, Codable, CaseIterable, Identifiable {
    case blurred
    case sharp

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .blurred: return "Blurred"
        case .sharp: return "Sharp"
        }
    }
}

public enum StartupViewPreference: String, Codable, CaseIterable, Identifiable {
    case main
    case wallet

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .main: return "Main view"
        case .wallet: return "Wallet"
        }
    }
}

public enum WalletPrimaryCurrency: String, Codable, CaseIterable, Identifiable {
    case sat
    case usd

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .sat: return "Sats"
        case .usd: return "USD"
        }
    }
}

public enum PushPlatform: String, Codable, CaseIterable, Identifiable {
    case ios
    case android

    public var id: String { rawValue }
}

public enum NotificationPermissionState: String, Codable, CaseIterable, Identifiable {
    case notDetermined = "default"
    case granted
    case denied

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .notDetermined: return "Not requested"
        case .granted: return "Allowed"
        case .denied: return "Denied"
        }
    }
}

public enum ScriptureMemoryFrequency: String, Codable, CaseIterable, Identifiable {
    case daily
    case every2d
    case twiceWeek
    case weekly

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .daily: return "Daily"
        case .every2d: return "Every 2 days"
        case .twiceWeek: return "Twice per week"
        case .weekly: return "Weekly"
        }
    }

    public var description: String {
        switch self {
        case .daily: return "Creates a review task every day."
        case .every2d: return "Review roughly three to four times per week."
        case .twiceWeek: return "Focus on scripture memory a couple times per week."
        case .weekly: return "Schedule one scripture memory task each week."
        }
    }
}

public enum ScriptureMemorySort: String, Codable, CaseIterable, Identifiable {
    case canonical
    case oldest
    case newest
    case needsReview

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .canonical: return "Canonical order"
        case .oldest: return "Oldest added"
        case .newest: return "Newest added"
        case .needsReview: return "Needs review"
        }
    }
}

public enum FastingRemindersMode: String, Codable, CaseIterable, Identifiable {
    case weekday
    case random

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .weekday: return "Weekday"
        case .random: return "Random"
        }
    }
}

public struct PushPreferences: Codable, Equatable {
    public var enabled: Bool
    public var platform: PushPlatform
    public var deviceId: String?
    public var subscriptionId: String?
    public var permission: NotificationPermissionState?

    public init(
        enabled: Bool = false,
        platform: PushPlatform = .ios,
        deviceId: String? = nil,
        subscriptionId: String? = nil,
        permission: NotificationPermissionState? = .notDetermined
    ) {
        self.enabled = enabled
        self.platform = platform
        self.deviceId = deviceId
        self.subscriptionId = subscriptionId
        self.permission = permission
    }
}

private enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let value) = self {
            return value
        }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self {
            return value
        }
        return nil
    }

    var doubleValue: Double? {
        if case .number(let value) = self {
            return value
        }
        return nil
    }

    var intValue: Int? {
        guard let doubleValue else { return nil }
        let rounded = Int(doubleValue.rounded())
        return abs(doubleValue - Double(rounded)) < 0.000_001 ? rounded : nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self {
            return value
        }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self {
            return value
        }
        return nil
    }
}

public struct AccentPalette: Codable, Equatable, Identifiable, Sendable {
    public var fill: String
    public var hover: String
    public var active: String
    public var soft: String
    public var border: String
    public var borderActive: String
    public var ring: String
    public var on: String
    public var glow: String
    public var shadow: String
    public var shadowActive: String

    public var id: String {
        [fill, borderActive, ring].joined(separator: "|")
    }

    fileprivate init?(jsonObject: [String: JSONValue]) {
        guard
            let fill = jsonObject["fill"]?.stringValue,
            let hover = jsonObject["hover"]?.stringValue,
            let active = jsonObject["active"]?.stringValue,
            let soft = jsonObject["soft"]?.stringValue,
            let border = jsonObject["border"]?.stringValue,
            let borderActive = jsonObject["borderActive"]?.stringValue,
            let ring = jsonObject["ring"]?.stringValue,
            let on = jsonObject["on"]?.stringValue,
            let glow = jsonObject["glow"]?.stringValue,
            let shadow = jsonObject["shadow"]?.stringValue,
            let shadowActive = jsonObject["shadowActive"]?.stringValue
        else {
            return nil
        }

        self.fill = fill
        self.hover = hover
        self.active = active
        self.soft = soft
        self.border = border
        self.borderActive = borderActive
        self.ring = ring
        self.on = on
        self.glow = glow
        self.shadow = shadow
        self.shadowActive = shadowActive
    }

    fileprivate var jsonValue: JSONValue {
        .object([
            "fill": .string(fill),
            "hover": .string(hover),
            "active": .string(active),
            "soft": .string(soft),
            "border": .string(border),
            "borderActive": .string(borderActive),
            "ring": .string(ring),
            "on": .string(on),
            "glow": .string(glow),
            "shadow": .string(shadow),
            "shadowActive": .string(shadowActive),
        ])
    }
}

public struct BackgroundAppearance: Equatable, Sendable {
    public var imageDataURL: String
    public var selectedAccent: AccentPalette?
    public var accents: [AccentPalette]
    public var accentIndex: Int?

    public init(
        imageDataURL: String,
        selectedAccent: AccentPalette? = nil,
        accents: [AccentPalette] = [],
        accentIndex: Int? = nil
    ) {
        self.imageDataURL = imageDataURL
        self.selectedAccent = selectedAccent
        self.accents = accents
        self.accentIndex = accentIndex
    }

    public var resolvedAccent: AccentPalette? {
        if let accentIndex, accents.indices.contains(accentIndex) {
            return accents[accentIndex]
        }
        return selectedAccent ?? accents.first
    }

    public var resolvedAccentIndex: Int? {
        if let accentIndex, accents.indices.contains(accentIndex) {
            return accentIndex
        }
        if let selectedAccent, let index = accents.firstIndex(of: selectedAccent) {
            return index
        }
        return accents.isEmpty ? nil : 0
    }
}

// MARK: - UserSettings (matches PWA settingsTypes.ts for cross-compat fields)

public struct UserSettings: Codable, Equatable {

    // Display
    public var accent: AccentChoice
    public var appearance: AppearanceMode
    public var weekStart: Int                        // 0=Sun, 1=Mon, 6=Sat (matches PWA Weekday)
    public var newTaskPosition: NewTaskPosition
    public var baseFontSize: Double?                 // nil = system default
    public var showFullWeekRecurring: Bool
    public var startBoardByDay: [Int: String]        // Weekday → boardId
    public var hideCompletedSubtasks: Bool
    public var backgroundBlur: BackgroundBlurMode
    public var startupView: StartupViewPreference

    // Feature toggles
    public var streaksEnabled: Bool
    public var completedTab: Bool
    public var bibleTrackerEnabled: Bool
    public var scriptureMemoryEnabled: Bool
    public var scriptureMemoryBoardId: String?
    public var scriptureMemoryFrequency: ScriptureMemoryFrequency
    public var scriptureMemorySort: ScriptureMemorySort
    public var fastingRemindersEnabled: Bool
    public var fastingRemindersMode: FastingRemindersMode
    public var fastingRemindersPerMonth: Int
    public var fastingRemindersWeekday: Int
    public var fastingRemindersRandomSeed: String

    // Wallet parity fields
    public var walletConversionEnabled: Bool
    public var walletPrimaryCurrency: WalletPrimaryCurrency
    public var walletSentStateChecksEnabled: Bool
    public var walletPaymentRequestsEnabled: Bool
    public var walletPaymentRequestsBackgroundChecksEnabled: Bool
    public var walletMintBackupEnabled: Bool
    public var walletContactsSyncEnabled: Bool
    public var npubCashLightningAddressEnabled: Bool
    public var npubCashAutoClaim: Bool

    // Sync / storage
    public var fileStorageServer: String
    public var nostrBackupEnabled: Bool
    public var nostrBackupMetadataEnabled: Bool
    public var cloudBackupsEnabled: Bool
    public var pushNotifications: PushPreferences

    // Preserve unmodeled PWA settings fields across decode/encode.
    private var rawExtras: [String: JSONValue]

    public init(
        accent: AccentChoice = .blue,
        appearance: AppearanceMode = .system,
        weekStart: Int = 0,
        newTaskPosition: NewTaskPosition = .top,
        baseFontSize: Double? = nil,
        showFullWeekRecurring: Bool = false,
        startBoardByDay: [Int: String] = [:],
        hideCompletedSubtasks: Bool = false,
        backgroundBlur: BackgroundBlurMode = .sharp,
        startupView: StartupViewPreference = .main,
        streaksEnabled: Bool = true,
        completedTab: Bool = true,
        bibleTrackerEnabled: Bool = false,
        scriptureMemoryEnabled: Bool = false,
        scriptureMemoryBoardId: String? = nil,
        scriptureMemoryFrequency: ScriptureMemoryFrequency = .daily,
        scriptureMemorySort: ScriptureMemorySort = .needsReview,
        fastingRemindersEnabled: Bool = false,
        fastingRemindersMode: FastingRemindersMode = .weekday,
        fastingRemindersPerMonth: Int = 4,
        fastingRemindersWeekday: Int = 1,
        fastingRemindersRandomSeed: String = UUID().uuidString.lowercased(),
        walletConversionEnabled: Bool = true,
        walletPrimaryCurrency: WalletPrimaryCurrency = .sat,
        walletSentStateChecksEnabled: Bool = true,
        walletPaymentRequestsEnabled: Bool = true,
        walletPaymentRequestsBackgroundChecksEnabled: Bool = true,
        walletMintBackupEnabled: Bool = true,
        walletContactsSyncEnabled: Bool = true,
        npubCashLightningAddressEnabled: Bool = true,
        npubCashAutoClaim: Bool = true,
        fileStorageServer: String = defaultFileStorageServer,
        nostrBackupEnabled: Bool = true,
        nostrBackupMetadataEnabled: Bool = true,
        cloudBackupsEnabled: Bool = false,
        pushNotifications: PushPreferences = PushPreferences()
    ) {
        self.init(
            accent: accent,
            appearance: appearance,
            weekStart: weekStart,
            newTaskPosition: newTaskPosition,
            baseFontSize: baseFontSize,
            showFullWeekRecurring: showFullWeekRecurring,
            startBoardByDay: startBoardByDay,
            hideCompletedSubtasks: hideCompletedSubtasks,
            backgroundBlur: backgroundBlur,
            startupView: startupView,
            streaksEnabled: streaksEnabled,
            completedTab: completedTab,
            bibleTrackerEnabled: bibleTrackerEnabled,
            scriptureMemoryEnabled: scriptureMemoryEnabled,
            scriptureMemoryBoardId: scriptureMemoryBoardId,
            scriptureMemoryFrequency: scriptureMemoryFrequency,
            scriptureMemorySort: scriptureMemorySort,
            fastingRemindersEnabled: fastingRemindersEnabled,
            fastingRemindersMode: fastingRemindersMode,
            fastingRemindersPerMonth: fastingRemindersPerMonth,
            fastingRemindersWeekday: fastingRemindersWeekday,
            fastingRemindersRandomSeed: fastingRemindersRandomSeed,
            walletConversionEnabled: walletConversionEnabled,
            walletPrimaryCurrency: walletPrimaryCurrency,
            walletSentStateChecksEnabled: walletSentStateChecksEnabled,
            walletPaymentRequestsEnabled: walletPaymentRequestsEnabled,
            walletPaymentRequestsBackgroundChecksEnabled: walletPaymentRequestsBackgroundChecksEnabled,
            walletMintBackupEnabled: walletMintBackupEnabled,
            walletContactsSyncEnabled: walletContactsSyncEnabled,
            npubCashLightningAddressEnabled: npubCashLightningAddressEnabled,
            npubCashAutoClaim: npubCashAutoClaim,
            fileStorageServer: fileStorageServer,
            nostrBackupEnabled: nostrBackupEnabled,
            nostrBackupMetadataEnabled: nostrBackupMetadataEnabled,
            cloudBackupsEnabled: cloudBackupsEnabled,
            pushNotifications: pushNotifications,
            rawExtras: [:]
        )
    }

    fileprivate init(
        accent: AccentChoice,
        appearance: AppearanceMode,
        weekStart: Int,
        newTaskPosition: NewTaskPosition,
        baseFontSize: Double?,
        showFullWeekRecurring: Bool,
        startBoardByDay: [Int: String],
        hideCompletedSubtasks: Bool,
        backgroundBlur: BackgroundBlurMode,
        startupView: StartupViewPreference,
        streaksEnabled: Bool,
        completedTab: Bool,
        bibleTrackerEnabled: Bool,
        scriptureMemoryEnabled: Bool,
        scriptureMemoryBoardId: String?,
        scriptureMemoryFrequency: ScriptureMemoryFrequency,
        scriptureMemorySort: ScriptureMemorySort,
        fastingRemindersEnabled: Bool,
        fastingRemindersMode: FastingRemindersMode,
        fastingRemindersPerMonth: Int,
        fastingRemindersWeekday: Int,
        fastingRemindersRandomSeed: String,
        walletConversionEnabled: Bool,
        walletPrimaryCurrency: WalletPrimaryCurrency,
        walletSentStateChecksEnabled: Bool,
        walletPaymentRequestsEnabled: Bool,
        walletPaymentRequestsBackgroundChecksEnabled: Bool,
        walletMintBackupEnabled: Bool,
        walletContactsSyncEnabled: Bool,
        npubCashLightningAddressEnabled: Bool,
        npubCashAutoClaim: Bool,
        fileStorageServer: String,
        nostrBackupEnabled: Bool,
        nostrBackupMetadataEnabled: Bool,
        cloudBackupsEnabled: Bool,
        pushNotifications: PushPreferences,
        rawExtras: [String: JSONValue]
    ) {
        self.accent = accent
        self.appearance = appearance
        self.weekStart = weekStart
        self.newTaskPosition = newTaskPosition
        self.baseFontSize = baseFontSize
        self.showFullWeekRecurring = showFullWeekRecurring
        self.startBoardByDay = startBoardByDay
        self.hideCompletedSubtasks = hideCompletedSubtasks
        self.backgroundBlur = backgroundBlur
        self.startupView = startupView
        self.streaksEnabled = streaksEnabled
        self.completedTab = completedTab
        self.bibleTrackerEnabled = bibleTrackerEnabled
        self.scriptureMemoryEnabled = scriptureMemoryEnabled
        self.scriptureMemoryBoardId = scriptureMemoryBoardId
        self.scriptureMemoryFrequency = scriptureMemoryFrequency
        self.scriptureMemorySort = scriptureMemorySort
        self.fastingRemindersEnabled = fastingRemindersEnabled
        self.fastingRemindersMode = fastingRemindersMode
        self.fastingRemindersPerMonth = fastingRemindersPerMonth
        self.fastingRemindersWeekday = fastingRemindersWeekday
        self.fastingRemindersRandomSeed = fastingRemindersRandomSeed
        self.walletConversionEnabled = walletConversionEnabled
        self.walletPrimaryCurrency = walletPrimaryCurrency
        self.walletSentStateChecksEnabled = walletSentStateChecksEnabled
        self.walletPaymentRequestsEnabled = walletPaymentRequestsEnabled
        self.walletPaymentRequestsBackgroundChecksEnabled = walletPaymentRequestsBackgroundChecksEnabled
        self.walletMintBackupEnabled = walletMintBackupEnabled
        self.walletContactsSyncEnabled = walletContactsSyncEnabled
        self.npubCashLightningAddressEnabled = npubCashLightningAddressEnabled
        self.npubCashAutoClaim = npubCashAutoClaim
        self.fileStorageServer = fileStorageServer
        self.nostrBackupEnabled = nostrBackupEnabled
        self.nostrBackupMetadataEnabled = nostrBackupMetadataEnabled
        self.cloudBackupsEnabled = cloudBackupsEnabled
        self.pushNotifications = pushNotifications
        self.rawExtras = rawExtras
        self = normalized()
    }

    /// Default settings matching PWA defaults.
    public static let defaults = UserSettings()

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode([String: JSONValue].self)
        var extras = raw

        func string(_ key: String) -> String? {
            extras.removeValue(forKey: key)?.stringValue
        }

        func bool(_ key: String) -> Bool? {
            extras.removeValue(forKey: key)?.boolValue
        }

        func int(_ key: String) -> Int? {
            extras.removeValue(forKey: key)?.intValue
        }

        func double(_ key: String) -> Double? {
            extras.removeValue(forKey: key)?.doubleValue
        }

        func object(_ key: String) -> [String: JSONValue]? {
            extras.removeValue(forKey: key)?.objectValue
        }

        var startBoardByDay: [Int: String] = [:]
        if let startBoardObject = object("startBoardByDay") {
            for (key, value) in startBoardObject {
                guard let weekday = Int(key), let boardId = value.stringValue else { continue }
                startBoardByDay[weekday] = boardId
            }
        }

        var pushNotifications = PushPreferences()
        if let pushObject = object("pushNotifications") {
            pushNotifications.enabled = pushObject["enabled"]?.boolValue ?? pushNotifications.enabled
            if let platform = pushObject["platform"]?.stringValue.flatMap(PushPlatform.init(rawValue:)) {
                pushNotifications.platform = platform
            }
            pushNotifications.deviceId = pushObject["deviceId"]?.stringValue
            pushNotifications.subscriptionId = pushObject["subscriptionId"]?.stringValue
            pushNotifications.permission = pushObject["permission"]?.stringValue.flatMap(NotificationPermissionState.init(rawValue:))
        }

        self.init(
            accent: string("accent").flatMap(AccentChoice.init(rawValue:)) ?? .blue,
            appearance: string("appearance").flatMap(AppearanceMode.init(rawValue:)) ?? .system,
            weekStart: int("weekStart") ?? 0,
            newTaskPosition: string("newTaskPosition").flatMap(NewTaskPosition.init(rawValue:)) ?? .top,
            baseFontSize: double("baseFontSize"),
            showFullWeekRecurring: bool("showFullWeekRecurring") ?? false,
            startBoardByDay: startBoardByDay,
            hideCompletedSubtasks: bool("hideCompletedSubtasks") ?? false,
            backgroundBlur: string("backgroundBlur").flatMap(BackgroundBlurMode.init(rawValue:)) ?? .sharp,
            startupView: string("startupView").flatMap(StartupViewPreference.init(rawValue:)) ?? .main,
            streaksEnabled: bool("streaksEnabled") ?? true,
            completedTab: bool("completedTab") ?? true,
            bibleTrackerEnabled: bool("bibleTrackerEnabled") ?? false,
            scriptureMemoryEnabled: bool("scriptureMemoryEnabled") ?? false,
            scriptureMemoryBoardId: string("scriptureMemoryBoardId"),
            scriptureMemoryFrequency: string("scriptureMemoryFrequency").flatMap(ScriptureMemoryFrequency.init(rawValue:)) ?? .daily,
            scriptureMemorySort: string("scriptureMemorySort").flatMap(ScriptureMemorySort.init(rawValue:)) ?? .needsReview,
            fastingRemindersEnabled: bool("fastingRemindersEnabled") ?? false,
            fastingRemindersMode: string("fastingRemindersMode").flatMap(FastingRemindersMode.init(rawValue:)) ?? .weekday,
            fastingRemindersPerMonth: int("fastingRemindersPerMonth") ?? 4,
            fastingRemindersWeekday: int("fastingRemindersWeekday") ?? 1,
            fastingRemindersRandomSeed: string("fastingRemindersRandomSeed") ?? UUID().uuidString.lowercased(),
            walletConversionEnabled: bool("walletConversionEnabled") ?? true,
            walletPrimaryCurrency: string("walletPrimaryCurrency").flatMap(WalletPrimaryCurrency.init(rawValue:)) ?? .sat,
            walletSentStateChecksEnabled: bool("walletSentStateChecksEnabled") ?? true,
            walletPaymentRequestsEnabled: bool("walletPaymentRequestsEnabled") ?? true,
            walletPaymentRequestsBackgroundChecksEnabled: bool("walletPaymentRequestsBackgroundChecksEnabled") ?? true,
            walletMintBackupEnabled: bool("walletMintBackupEnabled") ?? true,
            walletContactsSyncEnabled: bool("walletContactsSyncEnabled") ?? true,
            npubCashLightningAddressEnabled: bool("npubCashLightningAddressEnabled") ?? true,
            npubCashAutoClaim: bool("npubCashAutoClaim") ?? true,
            fileStorageServer: string("fileStorageServer") ?? Self.defaultFileStorageServer,
            nostrBackupEnabled: bool("nostrBackupEnabled") ?? true,
            nostrBackupMetadataEnabled: bool("nostrBackupMetadataEnabled") ?? true,
            cloudBackupsEnabled: bool("cloudBackupsEnabled") ?? false,
            pushNotifications: pushNotifications,
            rawExtras: extras
        )
    }

    public func encode(to encoder: Encoder) throws {
        var payload = rawExtras
        payload["accent"] = .string(accent.rawValue)
        payload["appearance"] = .string(appearance.rawValue)
        payload["weekStart"] = .number(Double(weekStart))
        payload["newTaskPosition"] = .string(newTaskPosition.rawValue)
        payload["baseFontSize"] = baseFontSize.map(JSONValue.number) ?? .null
        payload["showFullWeekRecurring"] = .bool(showFullWeekRecurring)
        payload["startBoardByDay"] = .object(Dictionary(uniqueKeysWithValues: startBoardByDay.map { (String($0.key), .string($0.value)) }))
        payload["hideCompletedSubtasks"] = .bool(hideCompletedSubtasks)
        payload["backgroundBlur"] = .string(backgroundBlur.rawValue)
        payload["startupView"] = .string(startupView.rawValue)
        payload["streaksEnabled"] = .bool(streaksEnabled)
        payload["completedTab"] = .bool(completedTab)
        payload["bibleTrackerEnabled"] = .bool(bibleTrackerEnabled)
        payload["scriptureMemoryEnabled"] = .bool(scriptureMemoryEnabled)
        payload["scriptureMemoryBoardId"] = scriptureMemoryBoardId.map(JSONValue.string) ?? .null
        payload["scriptureMemoryFrequency"] = .string(scriptureMemoryFrequency.rawValue)
        payload["scriptureMemorySort"] = .string(scriptureMemorySort.rawValue)
        payload["fastingRemindersEnabled"] = .bool(fastingRemindersEnabled)
        payload["fastingRemindersMode"] = .string(fastingRemindersMode.rawValue)
        payload["fastingRemindersPerMonth"] = .number(Double(fastingRemindersPerMonth))
        payload["fastingRemindersWeekday"] = .number(Double(fastingRemindersWeekday))
        payload["fastingRemindersRandomSeed"] = .string(fastingRemindersRandomSeed)
        payload["walletConversionEnabled"] = .bool(walletConversionEnabled)
        payload["walletPrimaryCurrency"] = .string(walletPrimaryCurrency.rawValue)
        payload["walletSentStateChecksEnabled"] = .bool(walletSentStateChecksEnabled)
        payload["walletPaymentRequestsEnabled"] = .bool(walletPaymentRequestsEnabled)
        payload["walletPaymentRequestsBackgroundChecksEnabled"] = .bool(walletPaymentRequestsBackgroundChecksEnabled)
        payload["walletMintBackupEnabled"] = .bool(walletMintBackupEnabled)
        payload["walletContactsSyncEnabled"] = .bool(walletContactsSyncEnabled)
        payload["fileStorageServer"] = .string(fileStorageServer)
        payload["npubCashLightningAddressEnabled"] = .bool(npubCashLightningAddressEnabled)
        payload["npubCashAutoClaim"] = .bool(npubCashAutoClaim)
        payload["cloudBackupsEnabled"] = .bool(cloudBackupsEnabled)
        payload["nostrBackupEnabled"] = .bool(nostrBackupEnabled)
        payload["nostrBackupMetadataEnabled"] = .bool(nostrBackupMetadataEnabled)
        payload["pushNotifications"] = .object([
            "enabled": .bool(pushNotifications.enabled),
            "platform": .string(pushNotifications.platform.rawValue),
            "deviceId": pushNotifications.deviceId.map(JSONValue.string) ?? .null,
            "subscriptionId": pushNotifications.subscriptionId.map(JSONValue.string) ?? .null,
            "permission": pushNotifications.permission.map { .string($0.rawValue) } ?? .null,
        ])

        var container = encoder.singleValueContainer()
        try container.encode(payload)
    }

    /// Resolves the configured startup board for the given date using the
    /// Taskify weekday mapping (0 = Sunday ... 6 = Saturday).
    public func startBoardId(for date: Date = Date(), calendar: Calendar = .current) -> String? {
        let weekday = Self.taskifyWeekday(for: date, calendar: calendar)
        guard let boardId = startBoardByDay[weekday]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !boardId.isEmpty else {
            return nil
        }
        return boardId
    }

    public var backgroundAppearance: BackgroundAppearance? {
        guard let imageDataURL = rawExtras["backgroundImage"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !imageDataURL.isEmpty else {
            return nil
        }

        let selectedAccent = rawExtras["backgroundAccent"]?.objectValue.flatMap(AccentPalette.init(jsonObject:))
        let accents = rawExtras["backgroundAccents"]?.arrayValue?.compactMap { value in
            value.objectValue.flatMap(AccentPalette.init(jsonObject:))
        } ?? []
        let accentIndex = rawExtras["backgroundAccentIndex"]?.intValue

        return BackgroundAppearance(
            imageDataURL: imageDataURL,
            selectedAccent: selectedAccent,
            accents: accents,
            accentIndex: accentIndex
        )
    }

    public var activeBackgroundAccent: AccentPalette? {
        backgroundAppearance?.resolvedAccent
    }

    public var activeAccentFillHex: String? {
        guard accent == .background else { return nil }
        return activeBackgroundAccent?.fill
    }

    public mutating func setBackgroundAppearance(_ appearance: BackgroundAppearance?) {
        guard let appearance else {
            rawExtras.removeValue(forKey: "backgroundImage")
            rawExtras.removeValue(forKey: "backgroundAccent")
            rawExtras.removeValue(forKey: "backgroundAccents")
            rawExtras.removeValue(forKey: "backgroundAccentIndex")
            if accent == .background {
                accent = .blue
            }
            self = normalized()
            return
        }

        let imageDataURL = appearance.imageDataURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !imageDataURL.isEmpty else {
            setBackgroundAppearance(nil)
            return
        }

        rawExtras["backgroundImage"] = .string(imageDataURL)
        rawExtras["backgroundAccent"] = appearance.selectedAccent?.jsonValue
        if appearance.accents.isEmpty {
            rawExtras.removeValue(forKey: "backgroundAccents")
        } else {
            rawExtras["backgroundAccents"] = .array(appearance.accents.map(\.jsonValue))
        }
        if let accentIndex = appearance.accentIndex {
            rawExtras["backgroundAccentIndex"] = .number(Double(accentIndex))
        } else {
            rawExtras.removeValue(forKey: "backgroundAccentIndex")
        }
        self = normalized()
    }

    public mutating func selectBackgroundAccent(index: Int) {
        guard var appearance = backgroundAppearance,
              appearance.accents.indices.contains(index) else { return }
        appearance.accentIndex = index
        appearance.selectedAccent = appearance.accents[index]
        setBackgroundAppearance(appearance)
        accent = .background
        self = normalized()
    }

    public mutating func clearBackgroundAppearance() {
        setBackgroundAppearance(nil)
    }

    public func normalized() -> UserSettings {
        var next = self
        next.rawExtras = next.rawExtras.removingKnownSettingsKeys()
        next.weekStart = Self.validWeekStarts.contains(next.weekStart) ? next.weekStart : 0
        if let baseFontSize = next.baseFontSize, baseFontSize <= 0 {
            next.baseFontSize = nil
        }
        next.startBoardByDay = next.startBoardByDay.reduce(into: [:]) { result, entry in
            let key = entry.key
            let value = entry.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (0...6).contains(key), !value.isEmpty else { return }
            result[key] = value
        }

        if next.accent == .background && !next.hasBackgroundAppearanceData {
            next.accent = .blue
        }

        next.fileStorageServer = Self.normalizeFileStorageServer(next.fileStorageServer) ?? Self.defaultFileStorageServer

        if !next.walletPaymentRequestsEnabled {
            next.walletPaymentRequestsBackgroundChecksEnabled = false
        }

        if !next.walletConversionEnabled {
            next.walletPrimaryCurrency = .sat
        }

        if !next.npubCashLightningAddressEnabled {
            next.npubCashAutoClaim = false
        }

        next.nostrBackupMetadataEnabled = next.nostrBackupEnabled
        next.pushNotifications.platform = .ios
        if next.pushNotifications.permission != .granted {
            next.pushNotifications.enabled = false
        }

        if !next.bibleTrackerEnabled {
            next.scriptureMemoryEnabled = false
            next.scriptureMemoryBoardId = nil
        } else if let boardId = next.scriptureMemoryBoardId?.trimmingCharacters(in: .whitespacesAndNewlines) {
            next.scriptureMemoryBoardId = boardId.isEmpty ? nil : boardId
        }

        let perMonthUpperBound = next.fastingRemindersMode == .random ? 31 : 5
        next.fastingRemindersPerMonth = min(perMonthUpperBound, max(1, next.fastingRemindersPerMonth))
        next.fastingRemindersWeekday = (0...6).contains(next.fastingRemindersWeekday) ? next.fastingRemindersWeekday : 1
        let randomSeed = next.fastingRemindersRandomSeed.trimmingCharacters(in: .whitespacesAndNewlines)
        next.fastingRemindersRandomSeed = randomSeed.isEmpty ? UUID().uuidString.lowercased() : randomSeed

        return next
    }

    public static func taskifyWeekday(for date: Date, calendar: Calendar = .current) -> Int {
        let swiftWeekday = calendar.component(.weekday, from: date)
        return (swiftWeekday + 6) % 7
    }

    public static let defaultFileStorageServer = "https://nostr.build"
    private static let validWeekStarts: Set<Int> = [0, 1, 6]

    public static func normalizeFileStorageServer(_ value: String?) -> String? {
        let raw = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }

        func tryNormalize(_ input: String) -> String? {
            guard let components = URLComponents(string: input),
                  let scheme = components.scheme, !scheme.isEmpty,
                  let host = components.host, !host.isEmpty else {
                return nil
            }
            let normalizedPath = components.path.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            return normalizedPath.isEmpty
                ? "\(scheme)://\(host)"
                : "\(scheme)://\(host)\(normalizedPath)"
        }

        return tryNormalize(raw) ?? tryNormalize("https://\(raw)")
    }

    private var hasBackgroundAppearanceData: Bool {
        guard rawExtras["backgroundImage"]?.stringValue?.isEmpty == false else {
            return false
        }
        if rawExtras["backgroundAccent"]?.objectValue != nil {
            return true
        }
        if let accents = rawExtras["backgroundAccents"], case .array(let items) = accents {
            return items.isEmpty == false
        }
        return false
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    func removingKnownSettingsKeys() -> Self {
        var copy = self
        let keys = [
            "accent",
            "appearance",
            "weekStart",
            "newTaskPosition",
            "baseFontSize",
            "showFullWeekRecurring",
            "startBoardByDay",
            "hideCompletedSubtasks",
            "backgroundBlur",
            "startupView",
            "streaksEnabled",
            "completedTab",
            "bibleTrackerEnabled",
            "scriptureMemoryEnabled",
            "scriptureMemoryBoardId",
            "scriptureMemoryFrequency",
            "scriptureMemorySort",
            "fastingRemindersEnabled",
            "fastingRemindersMode",
            "fastingRemindersPerMonth",
            "fastingRemindersWeekday",
            "fastingRemindersRandomSeed",
            "walletConversionEnabled",
            "walletPrimaryCurrency",
            "walletSentStateChecksEnabled",
            "walletPaymentRequestsEnabled",
            "walletPaymentRequestsBackgroundChecksEnabled",
            "walletMintBackupEnabled",
            "walletContactsSyncEnabled",
            "fileStorageServer",
            "npubCashLightningAddressEnabled",
            "npubCashAutoClaim",
            "cloudBackupsEnabled",
            "nostrBackupEnabled",
            "nostrBackupMetadataEnabled",
            "pushNotifications",
        ]
        keys.forEach { copy.removeValue(forKey: $0) }
        return copy
    }
}

// MARK: - Persistence

public enum UserSettingsStore {
    private static let key = "ai.taskify.settings"

    public static func load() -> UserSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let settings = try? JSONDecoder().decode(UserSettings.self, from: data) else {
            return .defaults
        }
        return settings.normalized()
    }

    public static func save(_ settings: UserSettings) {
        guard let data = try? JSONEncoder().encode(settings.normalized()) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

// MARK: - Observable Settings Manager

@MainActor
public final class SettingsManager: ObservableObject {
    @Published public var settings: UserSettings {
        didSet {
            let normalized = settings.normalized()
            guard settings != normalized else {
                savePending = true
                scheduleSave()
                return
            }
            settings = normalized
        }
    }

    private var savePending = false
    private var saveTask: Task<Void, Never>?

    public init() {
        self.settings = UserSettingsStore.load()
    }

    /// Debounced save (500ms, matching PWA behavior).
    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self, self.savePending else { return }
            UserSettingsStore.save(self.settings)
            self.savePending = false
        }
    }

    /// Save immediately (for sign-out, background, etc.).
    public func saveNow() {
        saveTask?.cancel()
        UserSettingsStore.save(settings)
        savePending = false
    }
}
